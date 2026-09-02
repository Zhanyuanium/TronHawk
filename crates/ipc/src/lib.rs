//! JSON-RPC over a local TCP socket. Every message carries `version`, `id`, and a
//! per-launch `secret`; errors are returned as structured `RpcError` responses.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

/// Protocol version carried in every message.
pub const PROTOCOL_VERSION: &str = "0.1";

/// Maximum accepted request frame size (bytes).
const MAX_FRAME_SIZE: usize = 64 * 1024;
/// Read timeout for a single frame.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub version: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    /// Per-launch authentication token.
    #[serde(default)]
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub version: String,
    pub id: u64,
    #[serde(flatten)]
    pub result: ResponseResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponseResult {
    Ok { result: serde_json::Value },
    Err { error: RpcError },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl Response {
    pub fn ok(id: u64, result: serde_json::Value) -> Self {
        Response {
            version: PROTOCOL_VERSION.into(),
            id,
            result: ResponseResult::Ok { result },
        }
    }

    pub fn err(id: u64, code: i32, message: impl Into<String>) -> Self {
        Response {
            version: PROTOCOL_VERSION.into(),
            id,
            result: ResponseResult::Err {
                error: RpcError {
                    code,
                    message: message.into(),
                },
            },
        }
    }
}

/// Run a blocking JSON-RPC server on 127.0.0.1, dispatching each newline-delimited
/// request to `handler`. Per-connection errors are isolated and never terminate the
/// listener.
pub fn serve(port: u16, handler: impl Fn(Request) -> Response) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                // A misbehaving client only closes its own connection.
                let _ = handle_connection(stream, &handler);
            }
            Err(_) => continue,
        }
    }
    Ok(())
}

fn handle_connection(
    stream: TcpStream,
    handler: &impl Fn(Request) -> Response,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    while let Some(line) = read_frame(&mut reader)? {
        let req = match serde_json::from_str::<Request>(line.trim()) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::err(0, -32700, format!("parse error: {e}"));
                write_response(&mut writer, &resp)?;
                continue;
            }
        };
        let resp = handler(req);
        write_response(&mut writer, &resp)?;
    }
    Ok(())
}

/// Read one newline-terminated frame, enforcing a size cap.
fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if buf.is_empty() {
                return Ok(None); // EOF with no data
            }
            // A final partial frame without a trailing newline.
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            if buf.len() + pos > MAX_FRAME_SIZE {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "frame too large",
                ));
            }
            buf.extend_from_slice(&available[..pos]);
            reader.consume(pos + 1);
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        if buf.len() + available.len() > MAX_FRAME_SIZE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        let len = available.len();
        buf.extend_from_slice(available);
        reader.consume(len);
    }
}

fn write_response(writer: &mut TcpStream, resp: &Response) -> std::io::Result<()> {
    let line = serde_json::to_string(resp)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let req = Request {
            version: PROTOCOL_VERSION.into(),
            id: 7,
            method: "getPlugin".into(),
            params: serde_json::json!({}),
            secret: "abc".into(),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: Request = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, 7);
        assert_eq!(back.method, "getPlugin");
        assert_eq!(back.secret, "abc");
    }

    #[test]
    fn error_response_shape() {
        let v = serde_json::to_value(Response::err(3, -32601, "not found")).unwrap();
        assert_eq!(v["id"], 3);
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(v["error"]["message"], "not found");
    }

    #[test]
    fn newline_terminated_oversized_frame_is_rejected() {
        let mut input = vec![b'x'; MAX_FRAME_SIZE + 1];
        input.push(b'\n');
        let error = read_frame(&mut std::io::Cursor::new(input)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}

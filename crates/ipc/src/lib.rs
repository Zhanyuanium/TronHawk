//! JSON-RPC over a local TCP socket. Every message carries `version` and `id`;
//! errors are returned as structured `RpcError` responses.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

/// Protocol version carried in every message.
pub const PROTOCOL_VERSION: &str = "0.1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub version: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
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
/// request to `handler`.
pub fn serve(port: u16, handler: impl Fn(Request) -> Response) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    for stream in listener.incoming() {
        let stream = stream?;
        handle_connection(stream, &handler)?;
    }
    Ok(())
}

fn handle_connection(
    stream: TcpStream,
    handler: &impl Fn(Request) -> Response,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(()); // EOF
        }

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
}

fn write_response(writer: &mut TcpStream, resp: &Response) -> std::io::Result<()> {
    let line = serde_json::to_string(resp)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

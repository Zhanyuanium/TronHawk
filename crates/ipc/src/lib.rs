//! JSON-RPC over a local TCP socket. Every message carries `version`, `id`, and a
//! per-launch `secret`; errors are returned as structured `RpcError` responses.

use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::Sha256;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
#[cfg(feature = "async-client")]
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};

/// Protocol version carried in every message.
pub const PROTOCOL_VERSION: &str = "0.1";

/// Maximum accepted request/response frame size in bytes (1 MiB).
/// Keep in sync with `MAX_FRAME_BYTES` in `crates/injector/assets/bootstrap.js`.
const MAX_FRAME_SIZE: usize = 1024 * 1024;
/// Read timeout for a single frame.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum number of connections handled concurrently. Accepting blocks while this many
/// connections are active, so one slow client can never exhaust threads or starve the loop.
const MAX_CONCURRENT_CONNECTIONS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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

/// Response payload. `ResponseResult` is flattened so the wire shape is either
/// `{"version","id","result":...}` or `{"version","id","error":{...}}`.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub version: String,
    pub id: u64,
    #[serde(flatten)]
    pub result: ResponseResult,
}

/// Serialization keeps the flattened `{ "result": ... }` / `{ "error": ... }` shape.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ResponseResult {
    Ok { result: serde_json::Value },
    Err { error: RpcError },
}

/// `deny_unknown_fields` is not available on `untagged` enum variants, so deserialization is
/// implemented by hand: the object must contain exactly one of `result` or `error` and no
/// other keys.
impl<'de> Deserialize<'de> for ResponseResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            #[serde(default)]
            result: Option<serde_json::Value>,
            #[serde(default)]
            error: Option<RpcError>,
        }
        let wire = Wire::deserialize(deserializer)?;
        match (wire.result, wire.error) {
            (Some(result), _) => Ok(ResponseResult::Ok { result }),
            (None, Some(error)) => Ok(ResponseResult::Err { error }),
            (None, None) => Err(serde::de::Error::custom(
                "missing `result` or `error` field",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

/// `deny_unknown_fields` cannot be derived on `Response` while `result` is flattened, so
/// deserialization is implemented by hand: the top-level object may contain exactly
/// `version`, `id`, and one of `result`/`error`, and anything else is rejected.
impl<'de> Deserialize<'de> for Response {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            version: String,
            id: u64,
            #[serde(default)]
            result: Option<serde_json::Value>,
            #[serde(default)]
            error: Option<RpcError>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let result = match (wire.result, wire.error) {
            (Some(result), _) => ResponseResult::Ok { result },
            (None, Some(error)) => ResponseResult::Err { error },
            (None, None) => {
                return Err(serde::de::Error::custom(
                    "missing `result` or `error` field",
                ))
            }
        };
        Ok(Response {
            version: wire.version,
            id: wire.id,
            result,
        })
    }
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
/// request to `handler`. Each accepted connection is handled on its own thread (bounded by
/// [`MAX_CONCURRENT_CONNECTIONS`]); while saturated the accept loop blocks, queueing further
/// connections in the kernel backlog. Per-connection errors are isolated and never terminate
/// the listener.
pub fn serve(
    port: u16,
    handler: impl Fn(Request) -> Response + Send + Sync + 'static,
) -> std::io::Result<()> {
    let handler = Arc::new(handler);
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let slots = Arc::new((Mutex::new(0usize), Condvar::new()));

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            // Accept errors are transient (e.g. a connection reset before accept); keep going.
            Err(_) => continue,
        };

        // Reserve a concurrency slot, blocking while the cap is reached so we never spawn an
        // unbounded number of handler threads.
        {
            let (lock, cvar) = &*slots;
            let mut active = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            while *active >= MAX_CONCURRENT_CONNECTIONS {
                active = cvar
                    .wait(active)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            *active += 1;
        }

        let handler = Arc::clone(&handler);
        let guard = SlotGuard {
            slots: Arc::clone(&slots),
        };
        // A misbehaving client only affects its own handler thread.
        let _ = std::thread::spawn(move || {
            let _guard = guard;
            let _ = handle_connection(stream, handler.as_ref());
        });
    }
    Ok(())
}

/// Releases a reserved concurrency slot on drop, including on handler panic, so the accept
/// loop can never deadlock because of a leaked reservation.
struct SlotGuard {
    slots: Arc<(Mutex<usize>, Condvar)>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.slots;
        if let Ok(mut active) = lock.lock() {
            *active = active.saturating_sub(1);
            cvar.notify_one();
        }
    }
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

/// Read one newline-terminated frame, enforcing a size cap. The returned string includes the
/// terminating newline when the frame is complete, so callers can tell a complete frame apart
/// from a final partial frame delivered at EOF. Content length (excluding the newline) is what
/// counts against [`MAX_FRAME_SIZE`].
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
            buf.extend_from_slice(&available[..=pos]);
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

/// Source of outbound call ids: unique across every caller in this process, so concurrent
/// calls never reuse an id the server could confuse.
static NEXT_CALL_ID: AtomicU64 = AtomicU64::new(1);

fn next_call_id() -> u64 {
    NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed)
}

/// Build one outbound request with a freshly allocated per-call `id`. Shared by the sync
/// (`call`) and async (`call_async`) clients so both sides allocate ids and lay out the
/// envelope identically.
fn new_request(secret: &str, method: &str, params: serde_json::Value) -> Request {
    Request {
        version: PROTOCOL_VERSION.into(),
        id: next_call_id(),
        method: method.to_owned(),
        params,
        secret: secret.to_owned(),
    }
}

/// Encode one request frame: canonical `serde_json::to_string` plus a single trailing `\n`.
/// Shared by the sync and async clients so the wire bytes are identical.
fn encode_request_frame(request: &Request) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_string(request)
        .map_err(|error| format!("failed to encode the Core request: {error}"))?;
    line.push('\n');
    Ok(line.into_bytes())
}

/// Validate the `getServerProof` payload against `token`/`challenge`. Shared by the sync
/// (`verify_server`) and async (`verify_server_async`) identity probes so error strings and
/// proof checks can never drift apart.
fn validate_server_proof(
    response: &serde_json::Value,
    token: &str,
    challenge: &str,
) -> Result<(), String> {
    let proof = response
        .get("proof")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Core returned a malformed server proof".to_owned())?;
    if !is_lowercase_hex(proof) || proof.len() != 64 {
        return Err("Core returned an invalid server proof".into());
    }
    let expected = compute_server_proof(token, challenge);
    if !constant_time_eq(proof.as_bytes(), expected.as_bytes()) {
        return Err("Core server identity verification failed".into());
    }
    Ok(())
}

/// Perform one bounded, newline-delimited JSON-RPC round-trip against the local Core daemon on
/// `127.0.0.1:port`, authenticating with `secret`. The request carries a freshly allocated
/// per-call `id`; the response is validated to carry the matching `id`, a supported protocol
/// version, and a well-formed envelope. A Core-side error (`error` result) is surfaced as a
/// `String` describing its code and message; an `Ok` result is returned as its JSON value.
///
/// The response frame is capped at [`MAX_FRAME_SIZE`] bytes, matching the server side, and
/// `timeout` bounds connect, read, and write. Any network/encoding/validation failure is
/// reported as a `String` error rather than panicking.
pub fn call(
    port: u16,
    secret: &str,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let request = new_request(secret, method, params);
    let id = request.id;

    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), timeout)
        .map_err(|error| format!("Core is unavailable at 127.0.0.1:{port}: {error}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|_| stream.set_write_timeout(Some(timeout)))
        .map_err(|error| format!("failed to configure the Core connection: {error}"))?;

    let request_bytes = encode_request_frame(&request)?;
    stream
        .write_all(&request_bytes)
        .and_then(|_| stream.flush())
        .map_err(|error| format!("failed to send the Core request: {error}"))?;

    let mut reader = BufReader::new(stream);
    let frame = match read_frame(&mut reader) {
        Ok(Some(frame)) => frame,
        Ok(None) => return Err("Core closed the connection without a response".into()),
        Err(error) => return Err(format!("failed to read the Core response: {error}")),
    };
    if !frame.ends_with('\n') {
        return Err("Core returned an unterminated response frame".into());
    }
    decode_response_frame(&frame, id)
}

/// Validate a raw response frame against the expected call id and return the `Ok` payload,
/// surfacing Core-side `error` results and protocol/envelope violations.
fn decode_response_frame(encoded: &str, expected_id: u64) -> Result<serde_json::Value, String> {
    let response: Response = serde_json::from_str(encoded.trim_end())
        .map_err(|error| format!("Core returned a malformed response: {error}"))?;
    if response.version != PROTOCOL_VERSION {
        return Err("Core returned an unsupported protocol version".into());
    }
    if response.id != expected_id {
        return Err("Core response id did not match the request".into());
    }
    match response.result {
        ResponseResult::Ok { result } => Ok(result),
        ResponseResult::Err { error } => Err(format!(
            "Core rejected the request ({}): {}",
            error.code, error.message
        )),
    }
}

/// Domain-separation prefix bound into every server-identity proof.
const SERVER_PROOF_PREFIX: &str = "tronhawk-server-proof-v1:";

/// Compute the server-identity proof for `challenge`:
/// `proof = hex(HMAC-SHA256(key = ASCII(token), msg = "tronhawk-server-proof-v1:" + challenge))`.
///
/// This is the single source of truth for the proof construction, shared by the Core daemon
/// (which produces proofs) and by this crate's client (which verifies them), so the two sides
/// can never drift apart.
pub fn compute_server_proof(token: &str, challenge: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(SERVER_PROOF_PREFIX.as_bytes());
    mac.update(challenge.as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

/// Ask the process listening on `127.0.0.1:port` to prove it holds `token` before any secret
/// is disclosed to it (server identity / port-squat protection).
///
/// A fresh 32-byte random challenge (64 lowercase hex) is sent over the unauthenticated
/// `getServerProof` method; the peer must answer with `hex(HMAC-SHA256(key = token, msg =
/// "tronhawk-server-proof-v1:" + challenge))`. The proof is compared in constant time. Any
/// transport/parse error, malformed proof, or mismatch fails closed — there is no fallback
/// that would accept an unverified peer.
pub fn verify_server(port: u16, token: &str, timeout: Duration) -> Result<(), String> {
    let mut challenge_bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut challenge_bytes)
        .map_err(|error| format!("failed to generate a server-proof challenge: {error}"))?;
    let challenge = hex_encode(&challenge_bytes);

    let response = call(
        port,
        "",
        "getServerProof",
        serde_json::json!({ "challenge": challenge }),
        timeout,
    )?;
    validate_server_proof(&response, token, &challenge)
}

/// Perform one authenticated control RPC, but only after the peer has proven it holds the
/// control token via [`verify_server`]. The token is never sent to an unverified peer.
///
/// **Control-token calls MUST use `call_control`, never bare [`call`]** — a bare `call` leaks
/// the control credential to whatever process happens to own the port.
pub fn call_control(
    port: u16,
    token: &str,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    verify_server(port, token, timeout)?;
    call(port, token, method, params, timeout)
}

/// Read one newline-terminated frame over an async buffered stream, enforcing the same size
/// cap as the sync [`read_frame`]. The returned string includes the terminating newline when
/// the frame is complete, so callers can tell a complete frame apart from a final partial
/// frame delivered at EOF. Content length (excluding the newline) is what counts against
/// [`MAX_FRAME_SIZE`]. Byte-for-byte the same framing rule as the sync path; only the I/O
/// polling is async.
#[cfg(feature = "async-client")]
async fn read_frame_async(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
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
            buf.extend_from_slice(&available[..=pos]);
            reader.consume(pos + 1);
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        if buf.len() + available.len() > MAX_FRAME_SIZE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        let chunk: Vec<u8> = available.to_vec();
        let len = chunk.len();
        buf.extend_from_slice(&chunk);
        reader.consume(len);
    }
}

/// Async variant of [`call`]: one bounded, newline-delimited JSON-RPC round-trip against the
/// local Core daemon on `127.0.0.1:port`, authenticating with `secret`.
///
/// The wire format is identical to the sync path — the request is built by [`new_request`],
/// encoded by [`encode_request_frame`], and the response is validated by
/// [`decode_response_frame`] — so the daemon cannot tell the two clients apart. `timeout`
/// bounds connect, send, and read individually (the same per-operation semantics as the sync
/// socket timeouts); every failure maps to the same `String` prefixes as [`call`].
#[cfg(feature = "async-client")]
pub async fn call_async(
    port: u16,
    secret: &str,
    method: &str,
    params: serde_json::Value,
    timeout_duration: Duration,
) -> Result<serde_json::Value, String> {
    let request = new_request(secret, method, params);
    let id = request.id;
    let request_bytes = encode_request_frame(&request)?;

    let mut stream = tokio::time::timeout(
        timeout_duration,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|elapsed| format!("Core is unavailable at 127.0.0.1:{port}: {elapsed}"))?
    .map_err(|error| format!("Core is unavailable at 127.0.0.1:{port}: {error}"))?;

    tokio::time::timeout(timeout_duration, async {
        stream.write_all(&request_bytes).await?;
        stream.flush().await
    })
    .await
    .map_err(|elapsed| format!("failed to send the Core request: {elapsed}"))?
    .map_err(|error: std::io::Error| format!("failed to send the Core request: {error}"))?;

    let mut reader = tokio::io::BufReader::new(stream);
    let frame = tokio::time::timeout(timeout_duration, read_frame_async(&mut reader))
        .await
        .map_err(|elapsed| format!("failed to read the Core response: {elapsed}"))?
        .map_err(|error: std::io::Error| {
            format!("failed to read the Core response: {error}")
        })?;
    let frame = match frame {
        Some(frame) => frame,
        None => return Err("Core closed the connection without a response".into()),
    };
    if !frame.ends_with('\n') {
        return Err("Core returned an unterminated response frame".into());
    }
    decode_response_frame(&frame, id)
}

/// Async variant of [`verify_server`]: ask the peer to prove it holds `token` before any
/// secret is disclosed to it. Challenge generation, proof comparison, error strings, and the
/// `timeout` budget are identical to the sync probe.
#[cfg(feature = "async-client")]
pub async fn verify_server_async(
    port: u16,
    token: &str,
    timeout_duration: Duration,
) -> Result<(), String> {
    let mut challenge_bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut challenge_bytes)
        .map_err(|error| format!("failed to generate a server-proof challenge: {error}"))?;
    let challenge = hex_encode(&challenge_bytes);

    let response = call_async(
        port,
        "",
        "getServerProof",
        serde_json::json!({ "challenge": challenge }),
        timeout_duration,
    )
    .await?;
    validate_server_proof(&response, token, &challenge)
}

/// Async variant of [`call_control`]: verify the peer via [`verify_server_async`] and only
/// then send the control token via [`call_async`]. The token is never sent to an unverified
/// peer.
///
/// **Control-token calls MUST use `call_control_async`, never bare [`call_async`]** — a bare
/// call leaks the control credential to whatever process happens to own the port.
#[cfg(feature = "async-client")]
pub async fn call_control_async(
    port: u16,
    token: &str,
    method: &str,
    params: serde_json::Value,
    timeout_duration: Duration,
) -> Result<serde_json::Value, String> {
    verify_server_async(port, token, timeout_duration).await?;
    call_async(port, token, method, params, timeout_duration).await
}

fn is_lowercase_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
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

    #[test]
    fn request_rejects_unknown_fields() {
        let encoded = r#"{"version":"0.1","id":7,"method":"getPlugin","params":{},"secret":"abc","extra":true}"#;
        let error = serde_json::from_str::<Request>(encoded).unwrap_err();
        assert!(error.to_string().contains("extra"));
        // Round-trip of the canonical shape still succeeds.
        let back: Request = serde_json::from_str(
            r#"{"version":"0.1","id":7,"method":"getPlugin","params":{},"secret":"abc"}"#,
        )
        .unwrap();
        assert_eq!(back.id, 7);
    }

    #[test]
    fn response_wire_shape_roundtrips_and_rejects_unknown_fields() {
        let ok: Response =
            serde_json::from_str(r#"{"version":"0.1","id":7,"result":{"accepted":3}}"#).unwrap();
        assert!(matches!(ok.result, ResponseResult::Ok { .. }));

        let err: Response = serde_json::from_str(
            r#"{"version":"0.1","id":7,"error":{"code":-32601,"message":"not found"}}"#,
        )
        .unwrap();
        let ResponseResult::Err { error } = err.result else {
            panic!("expected an error response");
        };
        assert_eq!(error.code, -32601);
        assert_eq!(error.message, "not found");

        // Unknown top-level fields, unknown fields inside `error`, and a payload with neither
        // `result` nor `error` are all rejected.
        assert!(serde_json::from_str::<Response>(
            r#"{"version":"0.1","id":7,"result":null,"extra":1}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Response>(
            r#"{"version":"0.1","id":7,"error":{"code":1,"message":"x","extra":1}}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Response>(r#"{"version":"0.1","id":7}"#).is_err());
    }

    /// Bind an ephemeral localhost listener, spawn a one-shot server that reads a single
    /// request line and replies with the bytes produced by `reply`, and return its port.
    fn spawn_reply_server(
        reply: impl FnOnce(&serde_json::Value) -> Vec<u8> + Send + 'static,
    ) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .expect("expected a request line");
            let request: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
            let reply = reply(&request);
            let mut stream = stream;
            stream.write_all(&reply).unwrap();
        });
        port
    }

    fn json_frame(value: &serde_json::Value) -> Vec<u8> {
        let mut encoded = serde_json::to_vec(value).unwrap();
        encoded.push(b'\n');
        encoded
    }

    #[test]
    fn client_round_trip_ok() {
        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "ok": true }
            }))
        });
        let result = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(result, serde_json::json!({ "ok": true }));
    }

    #[test]
    fn client_surfaces_rpc_error() {
        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "error": { "code": -32601, "message": "not found" }
            }))
        });
        let error = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("(-32601)"), "error: {error}");
        assert!(error.contains("not found"), "error: {error}");
    }

    #[test]
    fn client_rejects_id_and_version_mismatches() {
        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"].as_u64().unwrap() + 1,
                "result": { "unexpected": true }
            }))
        });
        let error = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("id did not match"), "error: {error}");

        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": "9.9",
                "id": request["id"],
                "result": { "unexpected": true }
            }))
        });
        let error = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(
            error.contains("unsupported protocol version"),
            "error: {error}"
        );
    }

    #[test]
    fn client_rejects_unterminated_and_oversized_frames() {
        let port =
            spawn_reply_server(|_| b"{\"version\":\"0.1\",\"id\":1,\"result\":null}".to_vec());
        let error = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("unterminated"), "error: {error}");

        let port = spawn_reply_server(|_| {
            let mut oversized = vec![b'x'; MAX_FRAME_SIZE + 1];
            oversized.push(b'\n');
            oversized
        });
        let error = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("frame too large"), "error: {error}");
    }

    #[test]
    fn client_reports_connection_refused() {
        // Reserve an ephemeral port, then release it so nothing is listening on it.
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = call(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(error.contains("Core is unavailable"), "error: {error}");
    }

    #[test]
    fn compute_server_proof_is_domain_separated_hmac_sha256() {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let challenge = "f".repeat(64);
        let proof = compute_server_proof(token, &challenge);
        assert_eq!(proof.len(), 64);
        assert!(is_lowercase_hex(&proof));

        // Independent recomputation with the documented key schedule and message.
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes()).unwrap();
        mac.update(b"tronhawk-server-proof-v1:");
        mac.update(challenge.as_bytes());
        assert_eq!(proof, hex_encode(&mac.finalize().into_bytes()));

        // RFC 4231 test case 2 pins the underlying HMAC-SHA256 wiring.
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(b"Jefe").unwrap();
        mac.update(b"what do ya want for nothing?");
        assert_eq!(
            hex_encode(&mac.finalize().into_bytes()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn call_control_probes_identity_before_sending_the_token() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "ab".repeat(32);
        let server_token = token.clone();
        let server = std::thread::spawn(move || {
            // Connection 1: the unauthenticated identity probe.
            let (stream, _) = listener.accept().unwrap();
            let mut probe = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut probe)
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(probe.trim_end()).unwrap();
            assert_eq!(request["method"], "getServerProof");
            assert_eq!(request["secret"], "");
            let challenge = request["params"]["challenge"].as_str().unwrap();
            let reply = serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "proof": compute_server_proof(&server_token, challenge) }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();

            // Connection 2: the authenticated control call carrying the real token.
            let (stream, _) = listener.accept().unwrap();
            let mut control = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut control)
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(control.trim_end()).unwrap();
            assert_eq!(request["method"], "getManagerSnapshot");
            assert_eq!(request["secret"], server_token);
            let reply = serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "ok": true }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();
        });

        let result = call_control(
            port,
            &token,
            "getManagerSnapshot",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(result, serde_json::json!({ "ok": true }));
        server.join().unwrap();
    }

    #[test]
    fn call_control_rejects_an_impostor_and_never_sends_the_token() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "cd".repeat(32);
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            // The impostor only ever sees the identity probe.
            let mut probe = String::new();
            reader.read_line(&mut probe).unwrap();
            let request: serde_json::Value = serde_json::from_str(probe.trim_end()).unwrap();
            assert_eq!(request["method"], "getServerProof");
            assert_eq!(request["secret"], "");

            // Reply with a wrong proof (impostor does not know the token).
            let reply = serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "proof": "0".repeat(64) }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();

            // A real control frame carrying the token must never arrive: the connection should
            // be dropped by the client (EOF) or, failing that, stay silent until the timeout.
            let mut second = String::new();
            match reader.read_line(&mut second) {
                Ok(0) => {} // client dropped the connection: good.
                Ok(_) => panic!("impostor received a control frame containing the token: {second}"),
                Err(error) => {
                    let kind = error.kind();
                    assert!(
                        kind == std::io::ErrorKind::WouldBlock
                            || kind == std::io::ErrorKind::TimedOut,
                        "unexpected read error: {error}"
                    );
                }
            }
        });

        let error = call_control(
            port,
            &token,
            "getManagerSnapshot",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(
            error.contains("identity verification failed"),
            "error: {error}"
        );
        server.join().unwrap();
    }

    #[test]
    fn a_slow_client_does_not_stall_other_connections() {
        use std::io::BufRead;
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Instant;

        // Reserve an ephemeral port, then release it for `serve`.
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let slow_started = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&slow_started);
        let server = std::thread::spawn(move || {
            let _ = serve(port, move |request: Request| {
                if request.method == "slow" {
                    flag.store(true, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(1500));
                    Response::ok(request.id, serde_json::json!({ "slow": true }))
                } else {
                    Response::ok(request.id, serde_json::json!({ "fast": true }))
                }
            });
        });

        fn connect(port: u16) -> TcpStream {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match TcpStream::connect(("127.0.0.1", port)) {
                    Ok(stream) => return stream,
                    Err(_) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(error) => panic!("connect failed: {error}"),
                }
            }
        }

        fn request_line(stream: &mut TcpStream, request: &[u8]) -> String {
            stream.write_all(request).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("timed out waiting for a response line");
            line
        }

        // Connection A issues the slow request; wait until its handler is actually sleeping.
        let mut slow = connect(port);
        slow.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        slow.set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        slow.write_all(
            b"{\"version\":\"0.1\",\"id\":1,\"method\":\"slow\",\"params\":{},\"secret\":\"\"}\n",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !slow_started.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "slow handler never started");
            std::thread::sleep(Duration::from_millis(10));
        }

        // Connection B must still be answered promptly while A is blocked.
        let mut fast = connect(port);
        fast.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        fast.set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let started = Instant::now();
        let response = request_line(
            &mut fast,
            b"{\"version\":\"0.1\",\"id\":2,\"method\":\"fast\",\"params\":{},\"secret\":\"\"}\n",
        );
        assert!(
            response.contains("\"fast\":true"),
            "unexpected response: {response}"
        );
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "fast request was stalled behind the slow client for {:?}",
            started.elapsed()
        );

        // Connection A still completes eventually with its own result (already queued).
        let mut slow_reader = BufReader::new(slow.try_clone().unwrap());
        let mut slow_response = String::new();
        slow_reader
            .read_line(&mut slow_response)
            .expect("timed out waiting for the slow response");
        assert!(slow_response.contains("\"slow\":true"));
        drop(server);
    }

    #[test]
    fn sync_and_async_share_the_same_request_encoding() {
        let request = Request {
            version: PROTOCOL_VERSION.into(),
            id: 42,
            method: "ping".into(),
            params: serde_json::json!({ "a": 1 }),
            secret: "secret".into(),
        };
        let encoded = encode_request_frame(&request).unwrap();
        let expected = format!("{}\n", serde_json::to_string(&request).unwrap());
        assert_eq!(encoded, expected.into_bytes());
        assert!(encoded.ends_with(b"\n"));
    }

    /// Regression for issue #4: a legitimate ExecutionPlan carrying full plugin sources
    /// (traffic-lights scale: ~50KiB css + ~8KiB renderer + ~6KiB second plugin, i.e. well
    /// over the old 64KiB cap but far below 1MiB) must round-trip through the frame layer.
    /// The payload shape mirrors `tronhawk_core::ExecutionPlan` (revision + PluginGrant
    /// list with css/renderer/main sources) without depending on the core crate.
    #[test]
    fn large_plan_sized_response_roundtrips_through_read_frame() {
        const OLD_LIMIT: usize = 64 * 1024;
        // Traffic-lights magnitude: plugin 1 carries ~50KiB css + ~8KiB renderer,
        // plugin 2 carries ~6KiB renderer; JSON envelope overhead pushes the total
        // just past 64KiB.
        // Mixed unit exercises JSON escape amplification (newline/quote/backslash
        // each grow by one byte on the wire) and multi-byte UTF-8 (`中`/`文` stay
        // 3 bytes/char raw and in JSON): `a`+LF+`b`+`"`+`c`+`\`+`d`+`中`+`文`.
        fn repeat_to_bytes(unit: &str, target: usize) -> String {
            let n = target.div_ceil(unit.as_bytes().len());
            unit.repeat(n)
        }
        const UNIT: &str = "a\nb\"c\\d中文";
        let css = repeat_to_bytes(UNIT, 50 * 1024);
        let renderer = repeat_to_bytes(UNIT, 8 * 1024);
        let second_renderer = repeat_to_bytes(UNIT, 6 * 1024);
        let plan = serde_json::json!({
            "revision": "test-revision",
            "plugins": [
                {
                    "id": "traffic-lights",
                    "version": "0.1.0",
                    "granted": ["renderer.css", "renderer.script"],
                    "css": css,
                    "renderer": renderer,
                    "main": null,
                    "config": {}
                },
                {
                    "id": "second-plugin",
                    "version": "0.1.0",
                    "granted": ["renderer.script"],
                    "css": null,
                    "renderer": second_renderer,
                    "main": null,
                    "config": {}
                }
            ]
        });
        let response = Response::ok(7, plan.clone());
        let mut encoded = serde_json::to_string(&response).unwrap();
        encoded.push('\n');
        let content_len = encoded.len() - 1; // newline excluded, like read_frame counts
        // Must sit in the regression window: rejected by the old 64KiB cap,
        // accepted by the new 1MiB cap.
        assert!(
            content_len > OLD_LIMIT,
            "fixture too small to reproduce issue #4: {content_len} bytes"
        );
        assert!(
            content_len < MAX_FRAME_SIZE,
            "fixture exceeds the new 1MiB cap: {content_len} bytes"
        );
        // Under the old limit this frame would have failed with "frame too large".
        // New limit: read_frame accepts it and preserves the newline framing.
        let frame = read_frame(&mut std::io::Cursor::new(encoded.as_bytes()))
            .expect("large plan frame must be accepted under the 1MiB cap")
            .expect("expected one complete frame");
        assert!(frame.ends_with('\n'));
        let decoded = decode_response_frame(&frame, 7).expect("large plan must decode");
        assert_eq!(decoded["revision"], "test-revision");
        // Escaped/multibyte sources must survive byte-for-byte (JSON escape
        // amplification on the wire plus multi-byte UTF-8 must not corrupt).
        assert_eq!(decoded["plugins"][0]["css"], plan["plugins"][0]["css"]);
        assert_eq!(
            decoded["plugins"][0]["renderer"],
            plan["plugins"][0]["renderer"]
        );
        assert_eq!(
            decoded["plugins"][1]["renderer"],
            plan["plugins"][1]["renderer"]
        );
    }

    /// The old 64KiB+1 boundary is now a legal frame; only frames past 1MiB are rejected.
    #[test]
    fn old_64kib_boundary_now_accepted_and_1mib_boundary_rejected() {
        // 64KiB+1 content bytes (plus newline on the wire) sat just past the old
        // limit — under the old cap this was the first rejected size.
        let mut just_over_old = vec![b'x'; 64 * 1024 + 1];
        just_over_old.push(b'\n');
        let frame = read_frame(&mut std::io::Cursor::new(just_over_old))
            .expect("64KiB+1 must be accepted under the 1MiB cap")
            .expect("expected one complete frame");
        assert!(frame.ends_with('\n'));

        // Exactly 1MiB content bytes (newline excluded) is accepted, mirroring async.
        let mut exact = vec![b'x'; MAX_FRAME_SIZE];
        exact.push(b'\n');
        let frame = read_frame(&mut std::io::Cursor::new(exact))
            .expect("exactly 1MiB must be accepted under the 1MiB cap")
            .expect("expected one complete frame");
        assert!(frame.ends_with('\n'));

        // The new boundary still rejects: MAX_FRAME_SIZE+1 content bytes.
        let mut over_new = vec![b'x'; MAX_FRAME_SIZE + 1];
        over_new.push(b'\n');
        let error = read_frame(&mut std::io::Cursor::new(over_new)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "frame too large");
    }

    /// Async `read_frame_async` enforces the same boundaries as sync `read_frame`
    /// (content bytes excluding the newline against 1MiB): 64KiB+1 and exactly
    /// 1MiB are accepted, 1MiB+1 is rejected.
    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_frame_boundaries_match_sync() {
        // 64KiB+1: first size rejected by the old cap, legal now.
        let mut just_over_old = vec![b'x'; 64 * 1024 + 1];
        just_over_old.push(b'\n');
        let mut reader = tokio::io::BufReader::new(&just_over_old[..]);
        let frame = read_frame_async(&mut reader)
            .await
            .expect("async: 64KiB+1 must be accepted")
            .expect("expected one complete frame");
        assert!(frame.ends_with('\n'));

        // Exactly 1MiB content bytes (newline excluded) is accepted, like sync.
        let mut exact = vec![b'x'; MAX_FRAME_SIZE];
        exact.push(b'\n');
        let mut reader = tokio::io::BufReader::new(&exact[..]);
        let frame = read_frame_async(&mut reader)
            .await
            .expect("async: exactly 1MiB must be accepted")
            .expect("expected one complete frame");
        assert!(frame.ends_with('\n'));

        // 1MiB+1 content bytes is rejected, like sync.
        let mut over_new = vec![b'x'; MAX_FRAME_SIZE + 1];
        over_new.push(b'\n');
        let mut reader = tokio::io::BufReader::new(&over_new[..]);
        let error = read_frame_async(&mut reader).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "frame too large");
    }

    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_client_round_trip_ok_against_a_sync_server() {
        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "ok": true }
            }))
        });
        let result = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(result, serde_json::json!({ "ok": true }));
    }

    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_client_surfaces_rpc_error_with_the_sync_prefix() {
        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "error": { "code": -32601, "message": "not found" }
            }))
        });
        let error = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.contains("(-32601)"), "error: {error}");
        assert!(error.contains("not found"), "error: {error}");
    }

    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_client_rejects_bad_frames_with_sync_errors() {
        // Wrong id.
        let port = spawn_reply_server(|request| {
            json_frame(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"].as_u64().unwrap() + 1,
                "result": { "unexpected": true }
            }))
        });
        let error = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.contains("id did not match"), "error: {error}");

        // Unterminated frame.
        let port =
            spawn_reply_server(|_| b"{\"version\":\"0.1\",\"id\":1,\"result\":null}".to_vec());
        let error = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.contains("unterminated"), "error: {error}");

        // Oversized frame.
        let port = spawn_reply_server(|_| {
            let mut oversized = vec![b'x'; MAX_FRAME_SIZE + 1];
            oversized.push(b'\n');
            oversized
        });
        let error = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.contains("frame too large"), "error: {error}");
    }

    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_client_reports_connection_refused_like_sync() {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(error.contains("Core is unavailable"), "error: {error}");
    }

    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_client_times_out_a_hung_server_with_the_sync_prefix() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            std::thread::sleep(Duration::from_secs(5));
            let _ = stream.write_all(b"{\"version\":\"0.1\",\"id\":1,\"result\":null}\n");
        });
        let error = call_async(
            port,
            "secret",
            "ping",
            serde_json::json!({}),
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("failed to read the Core response"),
            "error: {error}"
        );
    }

    #[cfg(feature = "async-client")]
    #[tokio::test]
    async fn async_call_control_probes_identity_before_sending_the_token() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "ab".repeat(32);
        let server_token = token.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut probe = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut probe)
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(probe.trim_end()).unwrap();
            assert_eq!(request["method"], "getServerProof");
            assert_eq!(request["secret"], "");
            let challenge = request["params"]["challenge"].as_str().unwrap();
            let reply = serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "proof": compute_server_proof(&server_token, challenge) }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();

            let (stream, _) = listener.accept().unwrap();
            let mut control = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut control)
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(control.trim_end()).unwrap();
            assert_eq!(request["method"], "getManagerSnapshot");
            assert_eq!(request["secret"], server_token);
            let reply = serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": request["id"],
                "result": { "ok": true }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();
        });

        let result = call_control_async(
            port,
            &token,
            "getManagerSnapshot",
            serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(result, serde_json::json!({ "ok": true }));
        server.join().unwrap();
    }
}

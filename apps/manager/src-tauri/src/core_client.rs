use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "0.1";
const DEFAULT_IPC_PORT: u16 = 17_777;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const RPC_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(3);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct CoreClient {
    root: PathBuf,
    port: u16,
    next_id: AtomicU64,
    startup: Mutex<()>,
}

#[derive(Serialize)]
struct Request<'a> {
    version: &'static str,
    id: u64,
    method: &'a str,
    params: Value,
    secret: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    version: String,
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RpcError {
    code: i32,
    message: String,
}

impl CoreClient {
    pub(crate) fn from_environment() -> Self {
        Self::new(storage_root(), ipc_port())
    }

    fn new(root: PathBuf, port: u16) -> Self {
        Self {
            root,
            port,
            next_id: AtomicU64::new(1),
            startup: Mutex::new(()),
        }
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_core_available()?;
        let token = self.read_control_token()?;
        self.call_with_token(method, params, &token)
    }

    fn call_with_token(
        &self,
        method: &str,
        params: Value,
        token: &str,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = Request {
            version: PROTOCOL_VERSION,
            id,
            method,
            params,
            secret: token,
        };
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port);
        let mut stream = TcpStream::connect_timeout(&address.into(), CONNECT_TIMEOUT)
            .map_err(|_| "Core is unavailable".to_owned())?;
        stream
            .set_read_timeout(Some(RPC_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(RPC_TIMEOUT)))
            .map_err(|_| "failed to configure the Core connection".to_owned())?;

        serde_json::to_writer(&mut stream, &request)
            .map_err(|_| "failed to encode the Core request".to_owned())?;
        stream
            .write_all(b"\n")
            .and_then(|_| stream.flush())
            .map_err(|_| "failed to send the Core request".to_owned())?;

        let mut encoded = String::new();
        let bytes = BufReader::new(stream)
            .take(MAX_RESPONSE_BYTES + 1)
            .read_line(&mut encoded)
            .map_err(|_| "failed to read the Core response".to_owned())?;
        if bytes == 0 {
            return Err("Core closed the connection without a response".into());
        }
        if bytes as u64 > MAX_RESPONSE_BYTES {
            return Err("Core response exceeded the size limit".into());
        }
        if !encoded.ends_with('\n') {
            return Err("Core returned an unterminated response frame".into());
        }

        parse_response(&encoded, id)
    }

    fn ensure_core_available(&self) -> Result<(), String> {
        if can_connect(self.port) {
            return Ok(());
        }

        let _guard = self
            .startup
            .lock()
            .map_err(|_| "Core startup state is unavailable".to_owned())?;
        if can_connect(self.port) {
            return Ok(());
        }

        let executable = core_executable().ok_or_else(|| {
            "Core is unavailable and no approved Core executable was found".to_owned()
        })?;
        Command::new(executable)
            .env("TRONHAWK_STORAGE_ROOT", &self.root)
            .env("TRONHAWK_IPC_PORT", self.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "failed to start Core".to_owned())?;

        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            if can_connect(self.port) {
                return Ok(());
            }
            thread::sleep(STARTUP_POLL_INTERVAL);
        }
        Err("Core did not become available in time".into())
    }

    fn read_control_token(&self) -> Result<String, String> {
        let contents = std::fs::read_to_string(self.root.join("config").join("control.token"))
            .map_err(|_| "failed to read the Core control credential".to_owned())?;
        let token = contents.trim();
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("invalid Core control credential".into());
        }
        Ok(token.to_owned())
    }
}

fn parse_response(encoded: &str, expected_id: u64) -> Result<Value, String> {
    let response: Response = serde_json::from_str(encoded.trim_end())
        .map_err(|_| "Core returned a malformed response".to_owned())?;
    if response.version != PROTOCOL_VERSION {
        return Err("Core returned an unsupported protocol version".into());
    }
    if response.id != expected_id {
        return Err("Core response id did not match the request".into());
    }
    match (response.result, response.error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(format!(
            "Core rejected the request ({}): {}",
            error.code, error.message
        )),
        _ => Err("Core returned an invalid response envelope".into()),
    }
}

fn can_connect(port: u16) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&address.into(), CONNECT_TIMEOUT).is_ok()
}

fn storage_root() -> PathBuf {
    if let Some(root) = std::env::var_os("TRONHAWK_STORAGE_ROOT") {
        return PathBuf::from(root);
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("TronHawk");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("TronHawk");
    }
    std::env::temp_dir().join("TronHawk")
}

fn ipc_port() -> u16 {
    std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_IPC_PORT)
}

fn core_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TRONHAWK_CORE_BIN") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }

    let directory = std::env::current_exe().ok()?.parent()?.to_owned();
    #[cfg(windows)]
    let name = "tronhawk-core.exe";
    #[cfg(not(windows))]
    let name = "tronhawk-core";
    approved_file(directory.join(name))
}

fn approved_file(path: PathBuf) -> Option<PathBuf> {
    Path::new(&path).is_file().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn sends_one_newline_delimited_request_and_accepts_matching_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert!(line.ends_with('\n'));
            let request: Value = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(request["version"], PROTOCOL_VERSION);
            assert_eq!(request["method"], "getManagerSnapshot");
            assert_eq!(request["secret"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            (&stream)
                .write_all(b"{\"version\":\"0.1\",\"id\":1,\"result\":{\"ok\":true}}\n")
                .unwrap();
        });

        let client = CoreClient::new(PathBuf::new(), port);
        let result = client
            .call_with_token(
                "getManagerSnapshot",
                serde_json::json!({}),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap();
        assert_eq!(result, serde_json::json!({ "ok": true }));
        server.join().unwrap();
    }

    #[test]
    fn rejects_unterminated_and_mismatched_response_frames() {
        assert!(parse_response(
            "{\"version\":\"0.1\",\"id\":9,\"result\":null}",
            1
        )
        .unwrap_err()
        .contains("id did not match"));

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .unwrap();
            stream
                .write_all(b"{\"version\":\"0.1\",\"id\":1,\"result\":null}")
                .unwrap();
        });
        let client = CoreClient::new(PathBuf::new(), port);
        assert!(client
            .call_with_token("getManagerSnapshot", serde_json::json!({}), "secret")
            .unwrap_err()
            .contains("unterminated"));
        server.join().unwrap();
    }
}

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_IPC_PORT: u16 = 17_777;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const RPC_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(3);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct CoreClient {
    root: PathBuf,
    port: u16,
    startup: Mutex<()>,
}

impl CoreClient {
    pub(crate) fn from_environment() -> Self {
        Self::new(storage_root(), ipc_port())
    }

    fn new(root: PathBuf, port: u16) -> Self {
        Self {
            root,
            port,
            startup: Mutex::new(()),
        }
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_core_available()?;
        let token = self.read_control_token()?;
        self.call_with_token(method, params, &token)
    }

    /// One authenticated control RPC over the shared `tronhawk-ipc` client. The client first
    /// makes the peer prove it holds the control token (`verify_server`) and only then sends the
    /// token, so the credential never reaches a port-squatter.
    fn call_with_token(&self, method: &str, params: Value, token: &str) -> Result<Value, String> {
        tronhawk_ipc::call_control(self.port, token, method, params, RPC_TIMEOUT)
    }

    fn ensure_core_available(&self) -> Result<(), String> {
        // Reachability is not "Core is available": only a peer that proves it holds the control
        // token counts. If a daemon already passes identity verification, reuse it.
        if self.verified_core().is_some() {
            return Ok(());
        }

        let _guard = self
            .startup
            .lock()
            .map_err(|_| "Core startup state is unavailable".to_owned())?;
        if self.verified_core().is_some() {
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
            if self.verified_core().is_some() {
                return Ok(());
            }
            thread::sleep(STARTUP_POLL_INTERVAL);
        }
        Err("Core did not pass server identity verification in time".into())
    }

    /// Returns the control token only when a peer on `self.port` proves it holds that token;
    /// otherwise `None` (missing token file, unreachable, or an impostor that fails the probe).
    fn verified_core(&self) -> Option<String> {
        let token = self.read_control_token().ok()?;
        tronhawk_ipc::verify_server(self.port, &token, PROBE_TIMEOUT).ok()?;
        Some(token)
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
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};

    const CONTROL_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn free_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    fn read_request_frame(stream: &TcpStream) -> Value {
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut line)
            .expect("expected a request frame");
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn write_frame(stream: &mut TcpStream, frame: &Value) {
        stream
            .write_all(serde_json::to_string(frame).unwrap().as_bytes())
            .and_then(|_| stream.write_all(b"\n"))
            .unwrap();
    }

    fn proof_response(request: &Value) -> Value {
        let challenge = request["params"]["challenge"].as_str().unwrap();
        serde_json::json!({
            "version": tronhawk_ipc::PROTOCOL_VERSION,
            "id": request["id"],
            "result": { "proof": tronhawk_ipc::compute_server_proof(CONTROL_TOKEN, challenge) }
        })
    }

    fn ok_response(request: &Value) -> Value {
        serde_json::json!({
            "version": tronhawk_ipc::PROTOCOL_VERSION,
            "id": request["id"],
            "result": { "ok": true }
        })
    }

    /// Answer the identity probe on the first accepted connection, then hand control to
    /// `control_handler` for the second (control) connection.
    fn serve_core(port: u16, control_handler: impl FnOnce(TcpStream, Value) + Send + 'static) {
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        thread::spawn(move || {
            // Connection 1: the unauthenticated identity probe.
            let (stream, _) = listener.accept().unwrap();
            let request = read_request_frame(&stream);
            assert_eq!(request["method"], "getServerProof");
            assert_eq!(request["secret"], "");
            let mut stream = stream;
            write_frame(&mut stream, &proof_response(&request));

            // Connection 2: the authenticated control call.
            let (stream, _) = listener.accept().unwrap();
            let request = read_request_frame(&stream);
            assert_eq!(request["version"], tronhawk_ipc::PROTOCOL_VERSION);
            assert_eq!(request["method"], "getManagerSnapshot");
            assert_eq!(request["secret"], CONTROL_TOKEN);
            control_handler(stream, request);
        });
    }

    #[test]
    fn sends_probe_then_control_and_accepts_matching_response() {
        let port = free_port();
        serve_core(port, |mut stream, request| {
            write_frame(&mut stream, &ok_response(&request));
        });

        let client = CoreClient::new(PathBuf::new(), port);
        let result = client
            .call_with_token("getManagerSnapshot", serde_json::json!({}), CONTROL_TOKEN)
            .unwrap();
        assert_eq!(result, serde_json::json!({ "ok": true }));
    }

    #[test]
    fn rejects_an_impostor_and_never_sends_the_control_secret() {
        let port = free_port();
        let server = thread::spawn(move || {
            let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let request = read_request_frame(&stream);
            // The impostor only ever sees the identity probe, never a control frame.
            assert_eq!(request["method"], "getServerProof");
            assert_eq!(request["secret"], "");
            let mut stream = stream;
            write_frame(
                &mut stream,
                &serde_json::json!({
                    "version": tronhawk_ipc::PROTOCOL_VERSION,
                    "id": request["id"],
                    "result": { "proof": "0".repeat(64) }
                }),
            );
            // A control frame carrying the token must never arrive on this connection.
            let mut second = String::new();
            match BufReader::new(stream.try_clone().unwrap()).read_line(&mut second) {
                Ok(0) => {}
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

        let client = CoreClient::new(PathBuf::new(), port);
        let error = client
            .call_with_token("getManagerSnapshot", serde_json::json!({}), CONTROL_TOKEN)
            .unwrap_err();
        assert!(
            error.contains("identity verification failed"),
            "error: {error}"
        );
        server.join().unwrap();
    }

    #[test]
    fn rejects_a_control_response_with_a_mismatched_id() {
        let port = free_port();
        serve_core(port, |mut stream, request| {
            write_frame(
                &mut stream,
                &serde_json::json!({
                    "version": tronhawk_ipc::PROTOCOL_VERSION,
                    "id": request["id"].as_u64().unwrap() + 1,
                    "result": { "ok": true }
                }),
            );
        });

        let client = CoreClient::new(PathBuf::new(), port);
        let error = client
            .call_with_token("getManagerSnapshot", serde_json::json!({}), CONTROL_TOKEN)
            .unwrap_err();
        assert!(error.contains("id did not match"), "error: {error}");
    }

    #[test]
    fn rejects_an_unterminated_control_response_frame() {
        let port = free_port();
        thread::spawn(move || {
            let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
            // Connection 1: identity probe.
            let (stream, _) = listener.accept().unwrap();
            let request = read_request_frame(&stream);
            let mut stream = stream;
            write_frame(&mut stream, &proof_response(&request));
            // Connection 2: control, answered with an unterminated frame.
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request_frame(&stream);
            assert_eq!(request["secret"], CONTROL_TOKEN);
            stream
                .write_all(br#"{"version":"0.1","id":1,"result":{"ok":true}}"#)
                .unwrap();
        });

        let client = CoreClient::new(PathBuf::new(), port);
        let error = client
            .call_with_token("getManagerSnapshot", serde_json::json!({}), CONTROL_TOKEN)
            .unwrap_err();
        assert!(error.contains("unterminated"), "error: {error}");
    }
}

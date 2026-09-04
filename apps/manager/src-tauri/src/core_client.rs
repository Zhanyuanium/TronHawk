use serde_json::Value;
use std::io::Read;
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

const STORAGE_ROOT_ENV: &str = "TRONHAWK_STORAGE_ROOT";
const IPC_PORT_ENV: &str = "TRONHAWK_IPC_PORT";

/// Maximum wall-clock time the launch-with-extensions command will wait for the injector launcher
/// to exit. A hung launcher (e.g. blocked reading a control credential or waiting on Core) must not
/// block the Manager's Tauri command indefinitely, so the command reaps and returns a fixed
/// path-free error after this bound.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Poll interval while waiting for the launcher to exit.
const LAUNCH_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Fixed, path-free failure strings for the launch-with-extensions flow. Some of them cross the
/// WebView boundary on failure, so none may ever embed the registered executable path or any
/// credential material.
const LAUNCHER_UNAVAILABLE_ERROR: &str = "the injector launcher is not available";
const LAUNCHER_START_ERROR: &str = "failed to start the injector launcher";
const LAUNCH_FAILED_ERROR: &str = "the application could not be launched with extensions";
const LAUNCH_LEVEL_ZERO_ERROR: &str = "Level 0 applications cannot be launched with extensions";
const MISSING_APPLICATION_ERROR: &str = "the application is not registered with Core";
const MISSING_EXECUTABLE_PATH_ERROR: &str = "the application has no registered executable path";
const INVALID_SUPPORT_LEVEL_ERROR: &str = "the application record has no valid support level";

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
            .env(STORAGE_ROOT_ENV, &self.root)
            .env(IPC_PORT_ENV, self.port.to_string())
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

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    /// Launches `application_id` with extensions by delegating to the co-located injector
    /// launcher. The registered executable path is read from the UN-redacted manager snapshot
    /// (redaction only happens at the WebView boundary in `lib.rs`), handed to the launcher as its
    /// single positional argument, and never returned here: the caller only ever sees a fixed
    /// `{ "launched": true }` acknowledgment or a fixed, path-free error.
    pub(crate) fn launch(&self, application_id: &str) -> Result<Value, String> {
        let snapshot = self.call("getManagerSnapshot", serde_json::json!({}))?;
        let executable_path = extract_executable_path(&snapshot, application_id)?;
        let application = application_record(&snapshot, application_id)?;
        ensure_supported_launch_level(application)?;

        let launcher = launcher_executable().ok_or_else(|| LAUNCHER_UNAVAILABLE_ERROR.to_owned())?;
        let mut command = Command::new(&launcher);
        command.arg(&executable_path);
        for (name, value) in launcher_environment(self.root(), self.port()) {
            command.env(name, value);
        }
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| LAUNCHER_START_ERROR.to_owned())?;

        // A hung launcher (e.g. blocked reading the control credential or waiting on Core) must
        // not hold the Manager's Tauri command indefinitely. Poll up to LAUNCH_TIMEOUT, then kill
        // and reap so we never leak a zombie; on timeout return a fixed path-free error.
        let outcome = wait_for_launcher(child, LAUNCH_TIMEOUT)?;

        // Launcher diagnostics may legitimately mention target paths; write them to the Manager's
        // own stderr only and never return them to the WebView.
        let mut stderr = outcome.stderr;
        let mut detail = String::new();
        let _ = stderr.read_to_string(&mut detail);
        if !outcome.exit_status.success() {
            if !detail.trim().is_empty() {
                eprintln!("[manager] injector launcher reported an error:\n{detail}");
            }
            return Err(LAUNCH_FAILED_ERROR.to_owned());
        }
        Ok(serde_json::json!({ "launched": true }))
    }
}

/// Outcome of waiting for the injector launcher: its exit status plus the (piped) stderr writer
/// once it has exited, so the caller can drain diagnostics without blocking on the pipe.
#[derive(Debug)]
struct LauncherOutcome {
    exit_status: std::process::ExitStatus,
    stderr: std::process::ChildStderr,
}

/// Wait for the launcher child to exit, polling up to `timeout`. On a hang, kill + reap the child
/// (no zombie) and return the fixed path-free LAUNCH_FAILED_ERROR; a start error returns
/// LAUNCHER_START_ERROR. `stderr` is piped, so a child that only writes a short diagnostic before
/// exiting will not fill the pipe buffer; the caller drains it after we return.
fn wait_for_launcher(mut child: std::process::Child, timeout: Duration) -> Result<LauncherOutcome, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                let stderr = child.stderr.take().expect("launcher stderr is piped");
                return Ok(LauncherOutcome { exit_status, stderr });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Terminate and reap so the child never lingers as a zombie.
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!(
                        "[manager] injector launcher did not exit within {}s; terminated",
                        timeout.as_secs()
                    );
                    return Err(LAUNCH_FAILED_ERROR.to_owned());
                }
                thread::sleep(LAUNCH_POLL_INTERVAL);
            }
            Err(_) => return Err(LAUNCHER_START_ERROR.to_owned()),
        }
    }
}

fn storage_root() -> PathBuf {
    if let Some(root) = std::env::var_os("TRONHAWK_STORAGE_ROOT") {
        return PathBuf::from(root);
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("com.tronhawk.manager")
            .join("core");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("com.tronhawk.manager")
            .join("core");
    }
    std::env::temp_dir()
        .join("com.tronhawk.manager")
        .join("core")
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

/// Resolves the co-located injector launcher: `TRONHAWK_INJECTOR_LAUNCHER_BIN` override first,
/// then `tronhawk-injector-launcher.exe` next to the Manager's own executable. Tauri's
/// `externalBin` mechanism places the launcher there (both in dev and in packaged installs).
fn launcher_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TRONHAWK_INJECTOR_LAUNCHER_BIN") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }

    let directory = std::env::current_exe().ok()?.parent()?.to_owned();
    #[cfg(windows)]
    let name = "tronhawk-injector-launcher.exe";
    #[cfg(not(windows))]
    let name = "tronhawk-injector-launcher";
    approved_file(directory.join(name))
}

/// Locates `snapshot.applications[application_id]`, returning a fixed error that never embeds
/// the application id or any path.
fn application_record<'a>(snapshot: &'a Value, application_id: &str) -> Result<&'a Value, String> {
    snapshot
        .get("applications")
        .and_then(|applications| applications.get(application_id))
        .ok_or_else(|| MISSING_APPLICATION_ERROR.to_owned())
}

/// Extracts `snapshot.applications[application_id].executablePath`. Errors are fixed strings that
/// never include the path, so a caller can surface them without leaking the registered location.
fn extract_executable_path(snapshot: &Value, application_id: &str) -> Result<String, String> {
    let application = application_record(snapshot, application_id)?;
    application
        .get("executablePath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| MISSING_EXECUTABLE_PATH_ERROR.to_owned())
}

/// Rejects Level 0 (unsupported) applications; Levels 1 and 2 may be launched with extensions.
fn ensure_supported_launch_level(application: &Value) -> Result<(), String> {
    match application.get("supportLevel").and_then(Value::as_u64) {
        Some(0) => Err(LAUNCH_LEVEL_ZERO_ERROR.to_owned()),
        Some(_) => Ok(()),
        None => Err(INVALID_SUPPORT_LEVEL_ERROR.to_owned()),
    }
}

/// The explicit child environment the injector launcher needs to reach Core: the storage root
/// that holds the control credential and the IPC port Core listens on.
fn launcher_environment(root: &Path, port: u16) -> Vec<(&'static str, String)> {
    vec![
        (STORAGE_ROOT_ENV, root.to_string_lossy().into_owned()),
        (IPC_PORT_ENV, port.to_string()),
    ]
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

    fn registered_application_snapshot() -> Value {
        serde_json::json!({
            "applications": {
                "app-one": {
                    "executablePath": "C:\\Tools\\Electron App\\app.exe",
                    "displayName": "One",
                    "supportLevel": 2,
                    "plugins": {}
                }
            }
        })
    }

    #[test]
    fn extract_executable_path_returns_the_registered_path() {
        let snapshot = registered_application_snapshot();
        assert_eq!(
            extract_executable_path(&snapshot, "app-one").unwrap(),
            "C:\\Tools\\Electron App\\app.exe"
        );
    }

    #[test]
    fn extract_executable_path_rejects_a_missing_application_without_leaking_the_path() {
        let snapshot = registered_application_snapshot();
        let error = extract_executable_path(&snapshot, "app-unknown").unwrap_err();
        assert_eq!(error, MISSING_APPLICATION_ERROR);
        assert!(!error.contains("app.exe") && !error.contains("app-unknown"));
    }

    #[test]
    fn extract_executable_path_rejects_a_redacted_snapshot_without_leaking_the_path() {
        // The Manager redacts executablePath only at the WebView boundary; CoreClient::launch
        // reads the un-redacted snapshot straight from Core. A redacted record (as the WebView
        // would see it) can therefore never drive a launch.
        let redacted = serde_json::json!({
            "applications": {
                "app-one": {
                    "displayName": "One",
                    "supportLevel": 2,
                    "plugins": {}
                }
            }
        });
        let error = extract_executable_path(&redacted, "app-one").unwrap_err();
        assert_eq!(error, MISSING_EXECUTABLE_PATH_ERROR);
        assert!(!error.contains("app.exe") && !error.contains("C:\\"));
    }

    #[test]
    fn extract_executable_path_rejects_a_non_string_executable_path() {
        let snapshot = serde_json::json!({
            "applications": {
                "app-one": {
                    "executablePath": 42,
                    "displayName": "One",
                    "supportLevel": 2,
                    "plugins": {}
                }
            }
        });
        let error = extract_executable_path(&snapshot, "app-one").unwrap_err();
        assert_eq!(error, MISSING_EXECUTABLE_PATH_ERROR);
        assert!(!error.contains("42"));
    }

    #[test]
    fn level_zero_application_is_rejected_with_the_fixed_message() {
        let level_zero = serde_json::json!({
            "executablePath": "C:\\private\\one.exe",
            "displayName": "One",
            "supportLevel": 0,
            "plugins": {}
        });
        let error = ensure_supported_launch_level(&level_zero).unwrap_err();
        assert_eq!(error, "Level 0 applications cannot be launched with extensions");
        assert_eq!(error, LAUNCH_LEVEL_ZERO_ERROR);
        assert!(!error.contains("one.exe"));

        for level in [1_u64, 2] {
            let supported = serde_json::json!({
                "executablePath": "C:\\private\\one.exe",
                "displayName": "One",
                "supportLevel": level,
                "plugins": {}
            });
            assert!(
                ensure_supported_launch_level(&supported).is_ok(),
                "Level {level} should be launchable"
            );
        }

        let missing_level = serde_json::json!({
            "executablePath": "C:\\private\\one.exe",
            "displayName": "One",
            "plugins": {}
        });
        let error = ensure_supported_launch_level(&missing_level).unwrap_err();
        assert_eq!(error, INVALID_SUPPORT_LEVEL_ERROR);
    }

    #[test]
    fn launcher_environment_carries_the_storage_root_and_ipc_port() {
        let environment = launcher_environment(Path::new(r"C:\TronHawk"), 17_777);
        assert_eq!(
            environment,
            vec![
                (STORAGE_ROOT_ENV, r"C:\TronHawk".to_owned()),
                (IPC_PORT_ENV, "17777".to_owned()),
            ]
        );
    }

    #[test]
    fn wait_for_launcher_times_out_and_reaps_a_hung_child() {
        // A launcher that blocks (e.g. waiting on a control credential) must not hold the Manager
        // command: wait_for_launcher kills + reaps it after the bound and returns LAUNCH_FAILED_ERROR
        // (a fixed, path-free message), never a hang.
        let child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 > NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a sleeping child");
        let error = wait_for_launcher(child, Duration::from_millis(300)).unwrap_err();
        assert_eq!(error, LAUNCH_FAILED_ERROR);
    }

    #[test]
    fn wait_for_launcher_returns_a_completed_child() {
        // A launcher that exits quickly returns its status + stderr, and the call succeeds.
        let child = Command::new("cmd")
            .args(["/C", "echo hi"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn a quick child");
        let outcome = wait_for_launcher(child, Duration::from_secs(5)).expect("quick child completes");
        assert!(outcome.exit_status.success());
    }
}

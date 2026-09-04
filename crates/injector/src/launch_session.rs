//! Core launch-session acquisition and the short child-environment handoff.

use serde::Deserialize;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_IPC_PORT: u16 = 17777;
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const EXPECTED_IDLE_SECONDS: u64 = 600;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchSessionResponse {
    token: String,
    application_id: String,
    expires_after_idle_seconds: u64,
}

/// The launch credential returned by Core. Its fields intentionally remain private so callers
/// cannot accidentally expose credential material while formatting this value.
pub struct LaunchSession {
    token: String,
}

pub fn storage_root() -> PathBuf {
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

pub fn ipc_port() -> u16 {
    std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_IPC_PORT)
}

pub fn read_control_token() -> Result<String, String> {
    let path = storage_root().join("config").join("control.token");
    let contents = std::fs::read_to_string(&path).map_err(|error| {
        format!(
            "failed to read Core control credential at {}: {error}",
            path.display()
        )
    })?;
    let token = contents.trim();
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "invalid Core control credential at {}",
            path.display()
        ));
    }
    Ok(token.to_owned())
}

/// Acquire a launch session via the shared `tronhawk-ipc` client. The client first makes the
/// peer prove it holds the control token (`call_control`) and owns the bounded newline framing,
/// per-call id, and envelope validation (protocol version, matching id, structured Core errors);
/// this layer validates the Core-specific `createLaunchSession` result shape before any
/// credential is handed onward.
pub fn create_launch_session(
    port: u16,
    executable_path: &str,
    control_token: &str,
) -> Result<LaunchSession, String> {
    let result = tronhawk_ipc::call_control(
        port,
        control_token,
        "createLaunchSession",
        serde_json::json!({ "executablePath": executable_path }),
        RPC_TIMEOUT,
    )?;
    parse_launch_session_result(result)
}

fn parse_launch_session_result(result: serde_json::Value) -> Result<LaunchSession, String> {
    let result: LaunchSessionResponse = serde_json::from_value(result)
        .map_err(|error| format!("malformed createLaunchSession result: {error}"))?;
    if result.token.is_empty() || result.token.trim() != result.token {
        return Err("malformed createLaunchSession result: invalid launch token".into());
    }
    if result.application_id.trim().is_empty() {
        return Err("malformed createLaunchSession result: invalid applicationId".into());
    }
    if result.expires_after_idle_seconds != EXPECTED_IDLE_SECONDS {
        return Err("malformed createLaunchSession result: unexpected idle expiry".into());
    }
    Ok(LaunchSession {
        token: result.token,
    })
}

/// Acquire a launch token and expose it only for the synchronous child-creation operation.
///
/// SEC-2 note: the launch token is handed to the target through the process environment
/// (`TRONHAWK_IPC_SECRET`), which means it is also inherited by every child process the target
/// spawns for as long as the target lives. Those children are outside our trust boundary (a
/// compromised target can already use the token, but a spawned child that outlives the target
/// extends the exposure window). This is accepted for the current MVP. The long-term mitigation
/// is a launch-token handoff that does not travel through the environment — e.g. an inherited
/// FD/socketpair the launcher passes directly to the target at creation — which removes the
/// ambient inheritance to grandchildren. Deliberately NOT changed here.
pub fn with_launch_session<T>(
    port: u16,
    executable_path: &str,
    control_token: &str,
    operation: impl FnOnce() -> T,
) -> Result<T, String> {
    let session = create_launch_session(port, executable_path, control_token)?;
    Ok(with_ipc_environment(port, &session.token, operation))
}

fn with_ipc_environment<T>(port: u16, launch_token: &str, operation: impl FnOnce() -> T) -> T {
    let _guard = EnvironmentGuard::set([
        ("TRONHAWK_IPC_PORT", OsString::from(port.to_string())),
        ("TRONHAWK_IPC_SECRET", OsString::from(launch_token)),
    ]);
    operation()
}

struct EnvironmentGuard {
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl EnvironmentGuard {
    fn set<const N: usize>(values: [(&'static str, OsString); N]) -> Self {
        let previous = values
            .iter()
            .map(|(name, _)| (*name, std::env::var_os(name)))
            .collect();
        for (name, value) in values {
            std::env::set_var(name, value);
        }
        Self { previous }
    }
}

impl Drop for EnvironmentGuard {
    fn drop(&mut self) {
        for (name, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::sync::Mutex;
    use std::thread;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn result_parser_validates_contract() {
        let valid = serde_json::json!({
            "token": "launch-token",
            "applicationId": "app-id",
            "expiresAfterIdleSeconds": 600
        });
        assert!(parse_launch_session_result(valid).is_ok());

        let missing_application = serde_json::json!({
            "token": "launch-token",
            "expiresAfterIdleSeconds": 600
        });
        assert!(parse_launch_session_result(missing_application)
            .err()
            .unwrap()
            .contains("malformed createLaunchSession result"));

        let wrong_expiry = serde_json::json!({
            "token": "launch-token",
            "applicationId": "app-id",
            "expiresAfterIdleSeconds": 30
        });
        assert!(parse_launch_session_result(wrong_expiry)
            .err()
            .unwrap()
            .contains("unexpected idle expiry"));

        let padded_token = serde_json::json!({
            "token": " launch-token",
            "applicationId": "app-id",
            "expiresAfterIdleSeconds": 600
        });
        assert!(parse_launch_session_result(padded_token)
            .err()
            .unwrap()
            .contains("invalid launch token"));

        let blank_application = serde_json::json!({
            "token": "launch-token",
            "applicationId": " ",
            "expiresAfterIdleSeconds": 600
        });
        assert!(parse_launch_session_result(blank_application)
            .err()
            .unwrap()
            .contains("invalid applicationId"));
    }

    #[test]
    fn mock_core_receives_control_token_but_child_gets_launch_token() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            // Connection 1: the unauthenticated identity probe must be answered first.
            let (stream, _) = listener.accept().unwrap();
            let mut probe_line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut probe_line)
                .unwrap();
            let probe: serde_json::Value = serde_json::from_str(probe_line.trim()).unwrap();
            assert_eq!(probe["version"], tronhawk_ipc::PROTOCOL_VERSION);
            assert_eq!(probe["method"], "getServerProof");
            assert_eq!(probe["secret"], "");
            let challenge = probe["params"]["challenge"].as_str().unwrap();
            let proof_reply = serde_json::json!({
                "version": tronhawk_ipc::PROTOCOL_VERSION,
                "id": probe["id"],
                "result": {
                    "proof": tronhawk_ipc::compute_server_proof("control-token", challenge)
                }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&proof_reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();

            // Connection 2: the authenticated createLaunchSession call.
            let (stream, _) = listener.accept().unwrap();
            let mut request_line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request_line)
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(request_line.trim()).unwrap();
            assert_eq!(request["version"], tronhawk_ipc::PROTOCOL_VERSION);
            // The shared client allocates a positive per-call id; echo it back like Core does.
            let request_id = request["id"].as_u64().unwrap();
            assert!(request_id >= 1);
            assert_eq!(request["method"], "createLaunchSession");
            assert_eq!(
                request["params"],
                serde_json::json!({"executablePath": "target.exe"})
            );
            assert_eq!(request["secret"], "control-token");

            let reply = serde_json::json!({
                "version": tronhawk_ipc::PROTOCOL_VERSION,
                "id": request_id,
                "result": {
                    "token": "launch-token",
                    "applicationId": "app-id",
                    "expiresAfterIdleSeconds": 600
                }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();
        });

        let prior_port = std::env::var_os("TRONHAWK_IPC_PORT");
        let prior_secret = std::env::var_os("TRONHAWK_IPC_SECRET");
        let observed = with_launch_session(port, "target.exe", "control-token", || {
            (
                std::env::var("TRONHAWK_IPC_PORT").unwrap(),
                std::env::var("TRONHAWK_IPC_SECRET").unwrap(),
            )
        })
        .unwrap();

        assert_eq!(observed, (port.to_string(), "launch-token".into()));
        assert_eq!(std::env::var_os("TRONHAWK_IPC_PORT"), prior_port);
        assert_eq!(std::env::var_os("TRONHAWK_IPC_SECRET"), prior_secret);
        server.join().unwrap();
    }

    #[test]
    fn impostor_fails_the_probe_and_create_launch_session_is_never_sent() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut probe_line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut probe_line)
                .unwrap();
            let probe: serde_json::Value = serde_json::from_str(probe_line.trim()).unwrap();
            assert_eq!(probe["method"], "getServerProof");
            assert_eq!(probe["secret"], "");

            // Wrong proof: this peer does not hold the control token.
            let proof_reply = serde_json::json!({
                "version": tronhawk_ipc::PROTOCOL_VERSION,
                "id": probe["id"],
                "result": { "proof": "0".repeat(64) }
            });
            let mut stream = stream;
            stream
                .write_all(serde_json::to_string(&proof_reply).unwrap().as_bytes())
                .and_then(|_| stream.write_all(b"\n"))
                .unwrap();

            // A createLaunchSession request carrying the control token must never arrive.
            let mut second = String::new();
            match BufReader::new(stream.try_clone().unwrap()).read_line(&mut second) {
                Ok(0) => {}
                Ok(_) => panic!(
                    "impostor received a createLaunchSession request with the control token: {second}"
                ),
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

        let error = create_launch_session(port, "target.exe", "control-token")
            .err()
            .unwrap();
        assert!(
            error.contains("identity verification failed"),
            "error: {error}"
        );
        server.join().unwrap();
    }

    #[test]
    fn scoped_environment_restores_prior_values_after_failure() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let previous_port = std::env::var_os("TRONHAWK_IPC_PORT");
        let previous_secret = std::env::var_os("TRONHAWK_IPC_SECRET");
        std::env::set_var("TRONHAWK_IPC_PORT", "old-port");
        std::env::set_var("TRONHAWK_IPC_SECRET", "old-secret");

        let result: Result<(), ()> = with_ipc_environment(4321, "launch-token", || {
            assert_eq!(std::env::var("TRONHAWK_IPC_PORT").unwrap(), "4321");
            assert_eq!(
                std::env::var("TRONHAWK_IPC_SECRET").unwrap(),
                "launch-token"
            );
            Err(())
        });
        assert!(result.is_err());
        assert_eq!(std::env::var("TRONHAWK_IPC_PORT").unwrap(), "old-port");
        assert_eq!(std::env::var("TRONHAWK_IPC_SECRET").unwrap(), "old-secret");

        restore("TRONHAWK_IPC_PORT", previous_port.as_deref());
        restore("TRONHAWK_IPC_SECRET", previous_secret.as_deref());
    }

    fn restore(name: &str, value: Option<&OsStr>) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

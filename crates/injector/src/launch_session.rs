//! Core launch-session acquisition and the short child-environment handoff.

use serde::Deserialize;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::time::Duration;
use tronhawk_ipc::{Request, Response, ResponseResult, PROTOCOL_VERSION};

pub const DEFAULT_IPC_PORT: u16 = 17777;
const RPC_ID: u64 = 1;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
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

pub fn create_launch_session(
    port: u16,
    executable_path: &str,
    control_token: &str,
) -> Result<LaunchSession, String> {
    let request = Request {
        version: PROTOCOL_VERSION.into(),
        id: RPC_ID,
        method: "createLaunchSession".into(),
        params: serde_json::json!({ "executablePath": executable_path }),
        secret: control_token.into(),
    };

    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), RPC_TIMEOUT)
        .map_err(|error| format!("Core is unavailable at 127.0.0.1:{port}: {error}"))?;
    stream
        .set_read_timeout(Some(RPC_TIMEOUT))
        .map_err(|error| format!("failed to configure Core connection: {error}"))?;
    stream
        .set_write_timeout(Some(RPC_TIMEOUT))
        .map_err(|error| format!("failed to configure Core connection: {error}"))?;

    serde_json::to_writer(&mut stream, &request)
        .map_err(|error| format!("failed to encode createLaunchSession request: {error}"))?;
    stream
        .write_all(b"\n")
        .and_then(|_| stream.flush())
        .map_err(|error| format!("failed to send createLaunchSession request: {error}"))?;

    let mut response_line = String::new();
    let bytes = BufReader::new(stream)
        .take(MAX_RESPONSE_BYTES + 1)
        .read_line(&mut response_line)
        .map_err(|error| format!("failed to read createLaunchSession response: {error}"))?;
    if bytes == 0 {
        return Err("Core closed the connection without a createLaunchSession response".into());
    }
    if bytes as u64 > MAX_RESPONSE_BYTES {
        return Err("createLaunchSession response exceeded the size limit".into());
    }

    parse_launch_session_response(&response_line)
}

fn parse_launch_session_response(encoded: &str) -> Result<LaunchSession, String> {
    let response: Response = serde_json::from_str(encoded.trim())
        .map_err(|error| format!("malformed createLaunchSession response: {error}"))?;
    if response.version != PROTOCOL_VERSION {
        return Err("malformed createLaunchSession response: unsupported protocol version".into());
    }
    if response.id != RPC_ID {
        return Err("malformed createLaunchSession response: request id mismatch".into());
    }
    let value = match response.result {
        ResponseResult::Ok { result } => result,
        ResponseResult::Err { error } => {
            return Err(format!(
                "Core rejected createLaunchSession ({}): {}",
                error.code, error.message
            ))
        }
    };
    let result: LaunchSessionResponse = serde_json::from_value(value)
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
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::thread;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn response_parser_validates_contract() {
        let valid = r#"{"version":"0.1","id":1,"result":{"token":"launch-token","applicationId":"app-id","expiresAfterIdleSeconds":600}}"#;
        assert!(parse_launch_session_response(valid).is_ok());

        let missing_application = r#"{"version":"0.1","id":1,"result":{"token":"launch-token","expiresAfterIdleSeconds":600}}"#;
        assert!(parse_launch_session_response(missing_application)
            .err()
            .unwrap()
            .contains("malformed createLaunchSession result"));

        let wrong_expiry = r#"{"version":"0.1","id":1,"result":{"token":"launch-token","applicationId":"app-id","expiresAfterIdleSeconds":30}}"#;
        assert!(parse_launch_session_response(wrong_expiry)
            .err()
            .unwrap()
            .contains("unexpected idle expiry"));
    }

    #[test]
    fn mock_core_receives_control_token_but_child_gets_launch_token() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut request_line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request_line)
                .unwrap();
            let request: serde_json::Value = serde_json::from_str(request_line.trim()).unwrap();
            assert_eq!(request["version"], PROTOCOL_VERSION);
            assert_eq!(request["id"], RPC_ID);
            assert_eq!(request["method"], "createLaunchSession");
            assert_eq!(
                request["params"],
                serde_json::json!({"executablePath": "target.exe"})
            );
            assert_eq!(request["secret"], "control-token");

            let mut stream = stream;
            stream.write_all(
                br#"{"version":"0.1","id":1,"result":{"token":"launch-token","applicationId":"app-id","expiresAfterIdleSeconds":600}}
"#,
            ).unwrap();
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

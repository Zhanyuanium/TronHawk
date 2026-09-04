//! Core boot autostart: the persisted `coreAutostart` preference and the Windows HKCU Run
//! registration that launches `<core.exe> /autostart` at logon.
//!
//! The registration is idempotent (a present Run entry is never rewritten) and requires no
//! elevation (HKCU is user-writable). The actual command handling is delegated to the `reg`
//! utility so the process/registry surface stays out of tests: callers inject a fake
//! [`AutostartStore`]. On non-Windows systems registering returns a readable error and the
//! store reports "not registered".

use std::path::Path;

/// Run-entry value name under `HKCU\...\CurrentVersion\Run`.
pub const RUN_VALUE_NAME: &str = "TronHawkCore";
/// Marker argument appended to the registered Core command line.
pub const AUTOSTART_ARG: &str = "/autostart";

#[cfg(windows)]
const RUN_KEY_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// Injectable autostart registration backend.
pub trait AutostartStore: Send + Sync {
    /// Whether a Core autostart Run entry currently exists.
    fn is_registered(&self) -> bool;
    /// Create the Run entry that executes `command`. When the entry already exists the store is
    /// free to treat this as a no-op; callers normally check [`is_registered`](Self::is_registered)
    /// first so the entry is written at most once.
    fn register(&self, command: &str) -> Result<(), String>;
    /// Remove the Run entry. Removing an absent entry is Ok (idempotent).
    fn unregister(&self) -> Result<(), String>;
}

/// The default Windows backend: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` through the
/// `reg.exe` CLI. Non-Windows builds return readable errors instead of pretending to register.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunKeyAutostart;

impl AutostartStore for RunKeyAutostart {
    fn is_registered(&self) -> bool {
        #[cfg(windows)]
        {
            run_reg(["query", RUN_KEY_PATH, "/v", RUN_VALUE_NAME])
                .is_some_and(|status| status.success())
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    fn register(&self, command: &str) -> Result<(), String> {
        #[cfg(windows)]
        {
            let status = run_reg([
                "add",
                RUN_KEY_PATH,
                "/v",
                RUN_VALUE_NAME,
                "/t",
                "REG_SZ",
                "/d",
                command,
                "/f",
            ])
            .ok_or_else(|| "failed to run `reg add`".to_owned())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("`reg add` exited with {status}"))
            }
        }
        #[cfg(not(windows))]
        {
            let _ = command;
            Err("Core autostart is only supported on Windows".to_owned())
        }
    }

    fn unregister(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if !self.is_registered() {
                return Ok(()); // idempotent: nothing to remove
            }
            let status = run_reg(["delete", RUN_KEY_PATH, "/v", RUN_VALUE_NAME, "/f"])
                .ok_or_else(|| "failed to run `reg delete`".to_owned())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("`reg delete` exited with {status}"))
            }
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
}

/// Build the Run-entry command that boots Core at logon: `"<core.exe>" /autostart`.
pub fn autostart_command(core_executable: &Path) -> String {
    format!("\"{}\" {}", core_executable.display(), AUTOSTART_ARG)
}

/// Whether a daemon command-line argument is the autostart marker passed by the Run entry.
/// `--autostart` is tolerated in addition to `/autostart` for convenience on other platforms.
pub fn is_autostart_arg(argument: &str) -> bool {
    argument == AUTOSTART_ARG || argument == "--autostart"
}

#[cfg(windows)]
fn run_reg<const N: usize>(args: [&str; N]) -> Option<std::process::ExitStatus> {
    std::process::Command::new("reg")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_command_quotes_the_executable_and_appends_the_flag() {
        let command = autostart_command(Path::new(r"C:\Program Files\TronHawk\core.exe"));
        assert_eq!(
            command,
            r#""C:\Program Files\TronHawk\core.exe" /autostart"#
        );
    }

    #[test]
    fn autostart_marker_arguments_are_recognized() {
        assert!(is_autostart_arg("/autostart"));
        assert!(is_autostart_arg("--autostart"));
        assert!(!is_autostart_arg("--serve"));
        assert!(!is_autostart_arg("autostart"));
    }
}

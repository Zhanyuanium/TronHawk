//! HKLM IFEO (Image File Execution Options) registration for transparent launch.
//!
//! Writing an IFEO entry requires elevation. Core cannot link the injector crate (layering), so
//! the elevated write shells out to the co-located `tronhawk-injector-launcher` binary (the
//! injector crate's own `register`/`unregister` subcommands, which own the actual registry
//! mutation) by re-launching it with ShellExecuteExW(verb = "runas"). Reading the current state
//! needs no elevation and is done directly against HKLM right here.
//!
//! Both surfaces are behind injectable traits ([`IefoWriter`], [`IefoReader`]) so the daemon's
//! tests never touch the registry, the UAC prompt, or any process API. Non-Windows builds return
//! readable errors / a degraded read instead of pretending to work.

use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;

/// Registry path (under HKLM) holding per-executable launch redirection. Kept in sync with
/// `crates/injector/src/registry.rs`; the injector writes these names, Core reads them.
pub const IFEO_REGISTRY_PATH: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options";
/// Marker value TronHawk writes to claim ownership of an IFEO entry it created.
pub const OWNER_VALUE: &str = "TronHawkOwned";
/// The value that redirects a launch; its presence means an entry is registered.
pub const DEBUGGER_VALUE: &str = "Debugger";

/// Outcome of one elevated IFEO write attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IefoWriteOutcome {
    /// The elevated launcher completed successfully; the registry now reflects the request.
    Applied,
    /// The user declined the UAC elevation prompt; nothing was written.
    Cancelled,
}
/// The current IFEO registration for one executable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IefoSnapshot {
    /// Whether a `Debugger` redirection is currently registered.
    pub registered: bool,
    /// Whether the entry carries TronHawk's `TronHawkOwned == 1` marker.
    pub owned: bool,
}

/// Backend that mutates the HKLM IFEO registration (elevation required).
pub trait IefoWriter: Send + Sync {
    /// Enable/disable the IFEO registration for `target_exe`. `Applied` means the registry now
    /// reflects `enabled`; `Cancelled` means the user dismissed the UAC prompt and nothing was
    /// written. Any other failure is returned as an error string.
    fn apply(&self, target_exe: &str, enabled: bool) -> Result<IefoWriteOutcome, String>;
}

/// Backend that reads the current HKLM IFEO registration (no elevation).
pub trait IefoReader: Send + Sync {
    /// Snapshot the IFEO registration for `target_exe`. `Err` when the platform has no IFEO or
    /// the key is absent/unreadable; callers degrade any error to `{registered: false,
    /// owned: false}`.
    fn read(&self, target_exe: &str) -> Result<IefoSnapshot, String>;
}

/// Production writer: re-launch the co-located injector launcher elevated. Non-Windows builds
/// return a readable error instead of pretending to register.
#[derive(Debug, Clone, Copy, Default)]
pub struct LauncherIefoWriter;

impl IefoWriter for LauncherIefoWriter {
    fn apply(&self, target_exe: &str, enabled: bool) -> Result<IefoWriteOutcome, String> {
        #[cfg(windows)]
        {
            let launcher = launcher_executable()
                .ok_or_else(|| "the injector launcher is not available".to_owned())?;
            let verb = if enabled { "register" } else { "unregister" };
            runas_launcher(&launcher, verb, target_exe)
        }
        #[cfg(not(windows))]
        {
            let _ = (target_exe, enabled);
            Err("IFEO registration is only supported on Windows".to_owned())
        }
    }
}

/// Production reader: direct HKLM read through winreg. Non-Windows builds report "not
/// registered" as an error so the daemon degrades to `{registered: false, owned: false}`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RegistryIefoReader;

impl IefoReader for RegistryIefoReader {
    fn read(&self, target_exe: &str) -> Result<IefoSnapshot, String> {
        #[cfg(windows)]
        {
            read_windows(target_exe)
        }
        #[cfg(not(windows))]
        {
            // Validate the executable shape even where IFEO does not exist, so callers get
            // consistent errors for pathless inputs on every platform.
            let _ = ifeo_subkey_name(target_exe)?;
            Err("IFEO is only supported on Windows".to_owned())
        }
    }
}

/// The IFEO subkey name for a target executable: its file name. Handles both `/` and `\`
/// separators (Core stores canonical Windows paths with forward slashes).
pub fn ifeo_subkey_name(target_exe: &str) -> Result<String, String> {
    Path::new(target_exe)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "target executable path has no file name".to_owned())
}

/// Locate the injector launcher binary Core shells out to for elevated IFEO writes: the same
/// `TRONHAWK_INJECTOR_LAUNCHER_BIN` override the Manager's `core_client` recognizes, then the
/// task-documented `TRONHAWK_INJECTOR_BIN`, then `tronhawk-injector-launcher(.exe)` next to
/// Core's own executable. Tauri's `externalBin` places the Manager, Core, and the launcher side
/// by side, so the sibling lookup matches both dev and packaged layouts.
#[cfg(windows)]
fn launcher_executable() -> Option<PathBuf> {
    for variable in ["TRONHAWK_INJECTOR_LAUNCHER_BIN", "TRONHAWK_INJECTOR_BIN"] {
        if let Some(path) = std::env::var_os(variable) {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
    #[cfg(windows)]
    let name = "tronhawk-injector-launcher.exe";
    #[cfg(not(windows))]
    let name = "tronhawk-injector-launcher";
    let candidate = directory.join(name);
    candidate.is_file().then_some(candidate)
}

/// Wall-clock bound for waiting on the (already elevated, post-UAC) launcher process. The
/// registry write itself is sub-second; this only guards a hung launcher. The UAC decision
/// happens inside `ShellExecuteExW` before this wait begins.
#[cfg(windows)]
const ELEVATED_WAIT_MS: u32 = 60_000;

/// Launch `launcher` with `verb <target-exe>` elevated via ShellExecuteExW(runas) and map the
/// outcome: exit code 0 → [`IefoWriteOutcome::Applied`]; a dismissed UAC prompt
/// (`ERROR_CANCELLED`/`SE_ERR_ACCESSDENIED`) → [`IefoWriteOutcome::Cancelled`]; anything else is
/// an error. `SEE_MASK_NOASYNC` keeps the call synchronous on this (console/service) thread, and
/// `SEE_MASK_NOCLOSEPROCESS` yields the process handle we wait on.
#[cfg(windows)]
fn runas_launcher(
    launcher: &Path,
    verb: &str,
    target_exe: &str,
) -> Result<IefoWriteOutcome, String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    use winapi::shared::minwindef::{FALSE, DWORD};
    use winapi::shared::winerror::{ERROR_CANCELLED, WAIT_TIMEOUT};
    use winapi::um::errhandlingapi::GetLastError;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::processthreadsapi::{GetExitCodeProcess, TerminateProcess};
    use winapi::um::shellapi::{
        ShellExecuteExW, SE_ERR_ACCESSDENIED, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW,
    };
    use winapi::um::synchapi::WaitForSingleObject;
    use winapi::um::winbase::WAIT_FAILED;

    if target_exe.contains('"') {
        return Err("target executable path contains a double quote".to_owned());
    }
    let parameters = format!("{verb} \"{target_exe}\"");
    let verb_wide: Vec<u16> = "runas".encode_utf16().chain(once(0)).collect();
    let file_wide: Vec<u16> = launcher
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect();
    let params_wide: Vec<u16> = parameters.encode_utf16().chain(once(0)).collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as DWORD;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb_wide.as_ptr();
    info.lpFile = file_wide.as_ptr();
    info.lpParameters = params_wide.as_ptr();
    // nShow stays 0 (SW_HIDE) from the zeroed struct.

    let launched = unsafe { ShellExecuteExW(&mut info) };
    if launched == FALSE {
        // A dismissed UAC prompt surfaces as ERROR_CANCELLED; a runas that cannot be elevated
        // (e.g. the target cannot run elevated) surfaces as SE_ERR_ACCESSDENIED. Both mean the
        // user/OS declined and nothing was written.
        let error = unsafe { GetLastError() };
        if error == ERROR_CANCELLED || error == SE_ERR_ACCESSDENIED {
            return Ok(IefoWriteOutcome::Cancelled);
        }
        return Err(format!(
            "failed to start the elevated injector launcher (Windows error {error})"
        ));
    }
    if info.hProcess.is_null() {
        return Err("the elevated injector launcher exposed no process handle".to_owned());
    }

    let process = info.hProcess;
    let wait = unsafe { WaitForSingleObject(process, ELEVATED_WAIT_MS) };
    if wait == WAIT_TIMEOUT || wait == WAIT_FAILED {
        let _ = unsafe { TerminateProcess(process, 1) };
        unsafe { CloseHandle(process) };
        return Err("the elevated injector launcher did not exit in time".to_owned());
    }

    let mut exit_code: DWORD = 0;
    let ok = unsafe { GetExitCodeProcess(process, &mut exit_code) };
    unsafe { CloseHandle(process) };
    if ok == FALSE {
        let error = unsafe { GetLastError() };
        return Err(format!(
            "failed to read the elevated injector launcher exit code (Windows error {error})"
        ));
    }
    if exit_code == 0 {
        Ok(IefoWriteOutcome::Applied)
    } else {
        Err(format!(
            "the elevated injector launcher exited with code {exit_code}"
        ))
    }
}

/// Direct (non-elevated) HKLM read of the IFEO entry for `target_exe`. A missing key or any
/// read failure is an error the caller degrades to `{registered: false, owned: false}`.
#[cfg(windows)]
fn read_windows(target_exe: &str) -> Result<IefoSnapshot, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let name = ifeo_subkey_name(target_exe)?;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let ifeo = hklm
        .open_subkey_with_flags(IFEO_REGISTRY_PATH, KEY_READ | KEY_WOW64_64KEY)
        .map_err(|e| format!("failed to open the IFEO hive: {e}"))?;
    // The 64-bit view is used because the elevated launcher registers through KEY_WOW64_64KEY.
    let key = ifeo
        .open_subkey_with_flags(&name, KEY_READ | KEY_WOW64_64KEY)
        .map_err(|_| format!("no IFEO entry for `{name}`"))?;
    let owned: Option<u32> = key.get_value(OWNER_VALUE).ok();
    let registered = key.get_value::<String, _>(DEBUGGER_VALUE).is_ok();
    Ok(IefoSnapshot {
        registered,
        owned: owned == Some(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ifeo_subkey_name_is_the_exe_file_name_across_separator_spellings() {
        assert_eq!(ifeo_subkey_name(r"C:\Tools\App.exe").unwrap(), "App.exe");
        assert_eq!(
            ifeo_subkey_name(r"C:\Program Files\Obsidian\Obsidian.exe").unwrap(),
            "Obsidian.exe"
        );
        // Core stores canonicalized Windows paths with forward slashes (possibly verbatim).
        assert_eq!(
            ifeo_subkey_name("//?/c:/program files/obsidian/obsidian.exe").unwrap(),
            "obsidian.exe"
        );
        assert_eq!(
            ifeo_subkey_name("//?/C:/Tools/Tool.exe").unwrap(),
            "Tool.exe"
        );
        assert_eq!(ifeo_subkey_name("notepad.exe").unwrap(), "notepad.exe");
        assert!(ifeo_subkey_name("").is_err());
    }

    #[test]
    fn degraded_snapshot_defaults_to_unregistered_and_unowned() {
        assert_eq!(
            IefoSnapshot::default(),
            IefoSnapshot {
                registered: false,
                owned: false
            }
        );
    }
}

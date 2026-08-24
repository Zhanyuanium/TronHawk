//! IFEO (Image File Execution Options) registration for transparent launch.
//!
//! When the `Debugger` value is set for a target executable, Windows routes launching that
//! executable through our launcher, so injection happens without changing the user's
//! launch flow. Writing `HKLM\...\Image File Execution Options` requires elevation.
//!
//! Safety:
//! - `FilterFullPath` limits the entry to the exact target path (not every `electron.exe`).
//! - A `TronHawkOwned` marker means we only modify entries we created.
//! - The previous `Debugger` is backed up and restored on unregister; we never delete a
//!   subkey wholesale (which could destroy a third-party configuration).

use std::path::Path;

use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, KEY_WOW64_64KEY};
use winreg::RegKey;

const IFEO_PATH: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options";

const OWNER_VALUE: &str = "TronHawkOwned";
const PREV_DEBUGGER_VALUE: &str = "TronHawkPrevDebugger";

fn exe_name(target_exe: &str) -> Result<&str, String> {
    Path::new(target_exe)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid target executable path".to_string())
}

fn launcher_path() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| format!("failed to resolve launcher path: {e}"))?
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "non-UTF8 launcher path".to_string())
}

/// Register IFEO so launching `target_exe` transparently routes through this launcher.
pub fn register(target_exe: &str) -> Result<(), String> {
    let name = exe_name(target_exe)?;
    let canonical_target = Path::new(target_exe)
        .canonicalize()
        .map_err(|e| format!("failed to resolve target: {e}"))?
        .to_str()
        .ok_or("non-UTF8 target path")?
        .to_string();
    let launcher = launcher_path()?;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let ifeo = hklm
        .open_subkey_with_flags(IFEO_PATH, KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| format!("failed to open IFEO (elevation required?): {e}"))?;
    let (key, _) = ifeo
        .create_subkey(name)
        .map_err(|e| format!("failed to create IFEO key for `{name}`: {e}"))?;

    // Back up any pre-existing Debugger so we can restore it later.
    let prev_debugger: Option<String> = key.get_value("Debugger").ok();
    if let Some(prev) = &prev_debugger {
        key.set_value(PREV_DEBUGGER_VALUE, prev)
            .map_err(|e| format!("failed to back up Debugger: {e}"))?;
    }

    key.set_value("Debugger", &format!("\"{launcher}\""))
        .map_err(|e| format!("failed to set Debugger: {e}"))?;
    key.set_value("FilterFullPath", &canonical_target)
        .map_err(|e| format!("failed to set FilterFullPath: {e}"))?;
    key.set_value(OWNER_VALUE, &1u32)
        .map_err(|e| format!("failed to set ownership marker: {e}"))?;

    Ok(())
}

/// Remove the IFEO registration for `target_exe`, restoring any pre-existing Debugger.
pub fn unregister(target_exe: &str) -> Result<(), String> {
    let name = exe_name(target_exe)?;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let ifeo = hklm
        .open_subkey_with_flags(IFEO_PATH, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| format!("failed to open IFEO (elevation required?): {e}"))?;
    let key = match ifeo.open_subkey_with_flags(name, KEY_READ | KEY_WRITE) {
        Ok(k) => k,
        Err(_) => return Ok(()), // no entry — nothing to do
    };

    // Refuse to touch an entry we did not create.
    let owned: Option<u32> = key.get_value(OWNER_VALUE).ok();
    if owned != Some(1) {
        return Err(format!(
            "IFEO entry for `{name}` is not TronHawk-owned; refusing to modify it"
        ));
    }

    // Restore the previous Debugger, or remove ours if there was none.
    let prev_debugger: Option<String> = key.get_value(PREV_DEBUGGER_VALUE).ok();
    match prev_debugger {
        Some(prev) => key
            .set_value("Debugger", &prev)
            .map_err(|e| format!("failed to restore Debugger: {e}"))?,
        None => {
            let _ = key.delete_value("Debugger");
        }
    }

    for value in [PREV_DEBUGGER_VALUE, OWNER_VALUE, "FilterFullPath"] {
        let _ = key.delete_value(value);
    }

    Ok(())
}

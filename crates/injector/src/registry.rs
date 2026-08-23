//! IFEO (Image File Execution Options) registration for transparent launch.
//!
//! When the `Debugger` value is set for a target executable, Windows routes launching that
//! executable through our launcher, so injection happens without changing the user's
//! launch flow. Writing `HKLM\...\Image File Execution Options` requires elevation.

use std::path::Path;

use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_WRITE, KEY_WOW64_64KEY};
use winreg::RegKey;

const IFEO_PATH: &str =
    r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options";

fn exe_name(target_exe: &str) -> Result<&str, String> {
    Path::new(target_exe)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid target executable path".to_string())
}

/// Register IFEO so launching `target_exe` transparently routes through this launcher.
pub fn register(target_exe: &str) -> Result<(), String> {
    let name = exe_name(target_exe)?;
    let launcher = std::env::current_exe()
        .map_err(|e| format!("failed to resolve launcher path: {e}"))?
        .to_str()
        .ok_or("non-UTF8 launcher path")?
        .to_string();

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let ifeo = hklm
        .open_subkey_with_flags(IFEO_PATH, KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| format!("failed to open IFEO (elevation required?): {e}"))?;
    let (key, _) = ifeo
        .create_subkey(name)
        .map_err(|e| format!("failed to create IFEO key for `{name}`: {e}"))?;
    key.set_value("Debugger", &format!("\"{launcher}\""))
        .map_err(|e| format!("failed to set Debugger value: {e}"))?;

    Ok(())
}

/// Remove the IFEO registration for `target_exe`.
pub fn unregister(target_exe: &str) -> Result<(), String> {
    let name = exe_name(target_exe)?;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let ifeo = hklm
        .open_subkey_with_flags(IFEO_PATH, KEY_WRITE | KEY_WOW64_64KEY)
        .map_err(|e| format!("failed to open IFEO (elevation required?): {e}"))?;
    ifeo.delete_subkey_all(name)
        .map_err(|e| format!("failed to delete IFEO key for `{name}`: {e}"))?;

    Ok(())
}

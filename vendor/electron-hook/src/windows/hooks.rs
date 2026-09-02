use std::{
    ffi::{c_char, c_void, CStr, CString},
    mem::transmute,
    str::FromStr,
};

use detours_sys::{
    DetourAttach, DetourCreateProcessWithDllW, DetourIsHelperProcess, DetourRestoreAfterWith,
    DetourTransactionAbort, DetourTransactionBegin, DetourTransactionCommit, DetourUpdateThread,
};
use widestring::U16CString;
use winapi::{
    shared::minwindef::{BOOL, DWORD, HINSTANCE, LPVOID},
    um::{
        libloaderapi::{GetModuleFileNameW, GetModuleHandleA, GetProcAddress},
        minwinbase::LPSECURITY_ATTRIBUTES,
        processthreadsapi::{
            GetCurrentThread, ResumeThread, LPPROCESS_INFORMATION, LPSTARTUPINFOW,
        },
        processenv::SetEnvironmentVariableW,
        winnt::{DLL_PROCESS_ATTACH, HANDLE, LPCWSTR, LPWSTR},
        winuser::MessageBoxA,
    },
};

#[cfg(debug_assertions)]
#[link(name = "kernel32")]
unsafe extern "system" {
    unsafe fn AllocConsole() -> BOOL;
}

// Environment variables
mod env {
    use std::sync::LazyLock;

    macro_rules! lazy_env {
        ($name:expr) => {
            LazyLock::new(|| std::env::var($name).unwrap_or_default())
        };
    }

    pub static ASAR_PATH: LazyLock<String> = lazy_env!("MODLOADER_ASAR_PATH");
    pub static DLL_PATH: LazyLock<String> = lazy_env!("MODLOADER_LIBRARY_PATH");

    pub fn folder_name() -> String {
        std::env::var("MODLOADER_FOLDER_NAME").unwrap_or_default()
    }
}

// Import the original functions to be hooked
#[allow(non_upper_case_globals)]
mod original {
    use winapi::um::{
        fileapi::{CreateFileW as CreateFileW_, GetFileAttributesW as GetFileAttributesW_},
        processthreadsapi::CreateProcessW as CreateProcessW_,
    };

    type FnPtr = *mut std::ffi::c_void;

    pub static mut GetFileAttributesW: FnPtr = GetFileAttributesW_ as _;
    pub static mut CreateFileW: FnPtr = CreateFileW_ as _;
    pub static mut CreateProcessW: FnPtr = CreateProcessW_ as _;
    pub static mut uv_fs_lstat: FnPtr = std::ptr::null_mut();
}

macro_rules! error_hooking_msg {
    ($msg:expr) => {
        MessageBoxA(
            std::ptr::null_mut(),
            $msg.as_ptr() as *const i8,
            "Error Hooking".as_ptr() as *const i8,
            0,
        );
    };
}

/// Reads `<dll dir>/tronhawk-sidecar.json` and applies every key/value to the current process
/// environment via `SetEnvironmentVariableW`.
///
/// On the AUMID-activation path the packaged app does NOT inherit the launcher's environment
/// (activation bypasses our `CreateProcess`), so `DllMain` must re-establish the `MODLOADER_*`
/// / `TRONHAWK_IPC_*` values itself before the `mod env` statics are first read. The sidecar
/// sits next to the injector DLL, i.e. next to the launcher that wrote it.
///
/// Guarded to be a strict no-op on any failure: the normal Detours launch path never writes a
/// sidecar (it inherits the env from the parent), so a missing/unreadable/unparseable sidecar
/// must not change that path's behavior.
fn load_sidecar_env(hinst_dll: HINSTANCE) {
    use std::os::windows::ffi::OsStrExt;

    let mut buffer = [0u16; 4096];
    let len = unsafe {
        GetModuleFileNameW(
            hinst_dll,
            buffer.as_mut_ptr(),
            buffer.len() as DWORD,
        )
    };
    if len == 0 || len as usize >= buffer.len() {
        return; // Resolve failed or was truncated — nothing sensible to do.
    }

    let Some(dll_dir) = std::path::Path::new(&String::from_utf16_lossy(&buffer[..len as usize]))
        .parent()
        .map(|dir| dir.to_path_buf())
    else {
        return;
    };
    let sidecar_path = dll_dir.join("tronhawk-sidecar.json");
    let Ok(contents) = std::fs::read_to_string(&sidecar_path) else {
        return; // No sidecar: normal Detours launch path.
    };
    let Ok(serde_json::Value::Object(entries)) =
        serde_json::from_str::<serde_json::Value>(&contents)
    else {
        return; // Unparseable sidecar: ignore rather than break the launch.
    };

    for (key, value) in entries {
        let Some(value) = value.as_str() else {
            continue; // Only string values are environment variables.
        };
        let key_wide: Vec<u16> =
            std::ffi::OsStr::new(&key).encode_wide().chain(std::iter::once(0)).collect();
        let value_wide: Vec<u16> =
            std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            SetEnvironmentVariableW(key_wide.as_ptr(), value_wide.as_ptr());
        }
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllMain(
    hinst_dll: HINSTANCE,
    fwd_reason: DWORD,
    _lpv_reserved: LPVOID,
) -> i32 {
    if DetourIsHelperProcess() == 1 {
        return 1;
    }

    if fwd_reason != DLL_PROCESS_ATTACH {
        return 1;
    }

    // Sidecar env first: on the AUMID race-attach path the process has no inherited
    // MODLOADER_* / TRONHAWK_IPC_* variables, and the `mod env` LazyLock statics below (and the
    // runtime, later) read them. Must run before the Detour transaction so every hook callback
    // observes the values.
    load_sidecar_env(hinst_dll);

    DetourRestoreAfterWith();

    DetourTransactionBegin();
    DetourUpdateThread(GetCurrentThread() as _);

    #[cfg(debug_assertions)]
    AllocConsole();

    macro_rules! attach {
        ($orig:ident, $target:ident) => {
            let result = DetourAttach(&raw mut original::$orig, $target as _);

            if result != 0 {
                error_hooking_msg!(format!(
                    "Failed to hook {}. Please report this issue.",
                    stringify!($orig)
                ));
                DetourTransactionAbort();
                return 1;
            };
        };
    }

    attach!(GetFileAttributesW, get_file_attributes_w);
    attach!(CreateFileW, create_file_w);
    attach!(CreateProcessW, create_process_w);

    fn get_executable_name() -> Option<CString> {
        let current_exe = std::env::current_exe().ok()?;
        let file_name = current_exe.file_name()?;
        let file_name = file_name.to_str()?;
        let file_name_cstr = CString::new(file_name).ok()?;
        Some(file_name_cstr)
    }

    if let Some(current_exe) = get_executable_name() {
        let process_handle = GetModuleHandleA(current_exe.as_ptr());
        if !process_handle.is_null() {
            let uv_fs_lstat_ptr = GetProcAddress(process_handle as _, c"uv_fs_lstat".as_ptr());
            if !uv_fs_lstat_ptr.is_null() {
                original::uv_fs_lstat = uv_fs_lstat_ptr as _;
                attach!(uv_fs_lstat, uv_fs_lstat);
            }
        }
    }

    DetourTransactionCommit();

    1
}

type UvFsLstat = unsafe extern "C" fn(
    _loop: *const c_void,
    req: *const c_void,
    path: *const c_char,
    cb: *const c_void,
) -> i32;
unsafe extern "C" fn uv_fs_lstat(
    _loop: *const c_void,
    _req: *const c_void,
    path: *const c_char,
    _cb: *const c_void,
) -> i32 {
    let uv_fs_lstat: UvFsLstat = transmute(original::uv_fs_lstat);

    let Ok(file_name) = CStr::from_ptr(path as _).to_str() else {
        return uv_fs_lstat(_loop, _req, path, _cb);
    };

    match crate::paths::redirect_asar_path(
        file_name,
        &env::ASAR_PATH,
        Some(env::folder_name().as_str()),
    ) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            uv_fs_lstat(_loop, _req, redirect_to_c.as_ptr() as _, _cb)
        }
        None => uv_fs_lstat(_loop, _req, path, _cb),
    }
}

type GetFileAttributesW = unsafe extern "C" fn(LPCWSTR) -> DWORD;

unsafe extern "C" fn get_file_attributes_w(lp_file_name: LPCWSTR) -> DWORD {
    let get_file_attributes_w: GetFileAttributesW = transmute(original::GetFileAttributesW);

    let Some(file_name) = U16CString::from_ptr_str(lp_file_name).to_string().ok() else {
        return get_file_attributes_w(lp_file_name);
    };

    match crate::paths::redirect_asar_path(
        &file_name,
        &env::ASAR_PATH,
        Some(env::folder_name().as_str()),
    ) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            let redirect_to = U16CString::from_str(redirect_to_c.to_str().unwrap()).unwrap();

            get_file_attributes_w(redirect_to.as_ptr())
        }
        None => get_file_attributes_w(lp_file_name),
    }
}

type CreateFileW = unsafe extern "C" fn(
    LPCWSTR,
    DWORD,
    DWORD,
    LPSECURITY_ATTRIBUTES,
    DWORD,
    DWORD,
    HANDLE,
) -> HANDLE;

unsafe extern "C" fn create_file_w(
    lp_file_name: LPCWSTR,
    dw_desired_access: DWORD,
    dw_share_mode: DWORD,
    lp_security_attributes: LPSECURITY_ATTRIBUTES,
    dw_creation_disposition: DWORD,
    dw_flags_and_attributes: DWORD,
    h_template_file: HANDLE,
) -> HANDLE {
    let create_file_w: CreateFileW = transmute(original::CreateFileW);

    let Some(file_name) = U16CString::from_ptr_str(lp_file_name).to_string().ok() else {
        return create_file_w(
            lp_file_name,
            dw_desired_access,
            dw_share_mode,
            lp_security_attributes,
            dw_creation_disposition,
            dw_flags_and_attributes,
            h_template_file,
        );
    };

    match crate::paths::redirect_asar_path(
        &file_name,
        &env::ASAR_PATH,
        Some(env::folder_name().as_str()),
    ) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            let redirect_to = U16CString::from_str(redirect_to_c.to_str().unwrap()).unwrap();

            create_file_w(
                redirect_to.as_ptr(),
                dw_desired_access,
                dw_share_mode,
                lp_security_attributes,
                dw_creation_disposition,
                dw_flags_and_attributes,
                h_template_file,
            )
        }
        None => create_file_w(
            lp_file_name,
            dw_desired_access,
            dw_share_mode,
            lp_security_attributes,
            dw_creation_disposition,
            dw_flags_and_attributes,
            h_template_file,
        ),
    }
}

type CreateProcessW = unsafe extern "C" fn(
    lp_application_name: LPCWSTR,
    lp_command_line: LPWSTR,
    lp_process_attributes: LPSECURITY_ATTRIBUTES,
    lp_thread_attributes: LPSECURITY_ATTRIBUTES,
    b_inherit_handles: BOOL,
    dw_creation_flags: DWORD,
    lp_environment: LPVOID,
    lp_current_directory: LPCWSTR,
    lp_startup_info: LPSTARTUPINFOW,
    lp_process_information: LPPROCESS_INFORMATION,
) -> BOOL;

unsafe extern "C" fn create_process_w(
    lp_application_name: LPCWSTR,
    lp_command_line: LPWSTR,
    lp_process_attributes: LPSECURITY_ATTRIBUTES,
    lp_thread_attributes: LPSECURITY_ATTRIBUTES,
    b_inherit_handles: BOOL,
    dw_creation_flags: DWORD,
    lp_environment: LPVOID,
    lp_current_directory: LPCWSTR,
    lp_startup_info: LPSTARTUPINFOW,
    lp_process_information: LPPROCESS_INFORMATION,
) -> BOOL {
    let create_process_w: CreateProcessW = transmute(original::CreateProcessW);

    let Some(command_line) = U16CString::from_ptr_str(lp_command_line)
        .to_string()
        .ok()
    else {
        return create_process_w(
            lp_application_name,
            lp_command_line,
            lp_process_attributes,
            lp_thread_attributes,
            b_inherit_handles,
            dw_creation_flags,
            lp_environment,
            lp_current_directory,
            lp_startup_info,
            lp_process_information,
        );
    };

    // When the updater "restarts" Discord, it doesn't seem to pass any arguments to the process.
    // So we can just check if the command contains "--" to make sure we hook the new Discord instance.
    if command_line.contains("--") && !command_line.contains("--type=renderer") {
        // Run the original CreateProcessW
        return create_process_w(
            lp_application_name,
            lp_command_line,
            lp_process_attributes,
            lp_thread_attributes,
            b_inherit_handles,
            dw_creation_flags,
            lp_environment,
            lp_current_directory,
            lp_startup_info,
            lp_process_information,
        );
    }

    let dll_path = CString::from_str(env::DLL_PATH.as_str()).unwrap();

    #[allow(
        clippy::missing_transmute_annotations,
        reason = "Excessive boilerplate"
    )]
    let success = DetourCreateProcessWithDllW(
        lp_application_name,
        lp_command_line,
        lp_process_attributes as _,
        lp_thread_attributes as _,
        b_inherit_handles,
        dw_creation_flags,
        lp_environment as _,
        lp_current_directory,
        lp_startup_info as _,
        lp_process_information as _,
        dll_path.as_ptr(),
        Some(std::mem::transmute(original::CreateProcessW)),
    );

    if success != 1 {
        eprintln!("[Electron Hook] Failed to create process");
        return success;
    }

    ResumeThread((*lp_process_information).hThread as _);

    success
}

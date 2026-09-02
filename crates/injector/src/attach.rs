//! Win32 primitives for the AUMID race-attach probe (ADR 0005).
//!
//! The MSIX-packaged ChatGPT Desktop cannot be launched with a `CREATE_SUSPENDED` handle
//! (activation is done by Windows, not by our `DetourCreateProcessWithDllExA` launcher), so
//! this module implements the classic post-spawn attach: enumerate processes with toolhelp,
//! `OpenProcess` the new one, and `CreateRemoteThread` + `LoadLibraryW` to make the target
//! load `tronhawk_injector.dll` before Electron's first read of `app.asar`.
//!
//! Probe-only code: keep it explicit, fail-open, and behind clear `Result<_, String>` errors.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use winapi::{
    ctypes::c_void,
    shared::minwindef::{DWORD, FARPROC},
    um::{
        errhandlingapi::GetLastError,
        handleapi::CloseHandle,
        libloaderapi::{GetModuleHandleW, GetProcAddress},
        memoryapi::{VirtualAllocEx, VirtualFreeEx, WriteProcessMemory},
        processthreadsapi::{CreateRemoteThread, OpenProcess},
        shellapi::ShellExecuteW,
        synchapi::WaitForSingleObject,
        tlhelp32::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        winnt::{
            MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, PROCESS_CREATE_THREAD,
            PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
        },
        winuser::SW_SHOWNORMAL,
    },
};

/// `WaitForSingleObject` result when the wait timed out (`STATUS_TIMEOUT`).
const WAIT_TIMEOUT: DWORD = 0x0000_0102;
/// `WaitForSingleObject` result on failure (`STATUS_FAILED` / `WAIT_FAILED`).
const WAIT_FAILED: DWORD = 0xFFFF_FFFF;
/// How long to wait for the remote `LoadLibraryW` thread to finish before cleaning up.
const ATTACH_WAIT_MS: DWORD = 10_000;

/// Encode a Rust string as a NUL-terminated UTF-16 buffer (for `*const u16` Win32 parameters).
fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

/// The last Win32 error, formatted for a diagnostic message.
fn last_error() -> String {
    format!("Win32 error {}", unsafe { GetLastError() })
}

/// Decode a fixed `WCHAR` array (e.g. `PROCESSENTRY32W::szExeFile`) up to its NUL terminator.
fn wide_array_to_string(units: &[u16]) -> String {
    let end = units.iter().position(|&unit| unit == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// Enumerate the PIDs of every running process whose image name matches one of `names`
/// (case-insensitive, e.g. `ChatGPT.exe` / `Codex.exe`).
///
/// The launcher snapshots the result *before* AUMID activation and again *after*, then looks for
/// a PID that only appeared in the later snapshot — that is the freshly activated process.
pub fn process_pids_by_image(names: &[&str]) -> Result<Vec<u32>, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() {
            return Err(format!("CreateToolhelp32Snapshot failed: {}", last_error()));
        }

        let mut pids = Vec::new();
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;

        let mut ok = Process32FirstW(snapshot, &mut entry);
        while ok != 0 {
            let image = wide_array_to_string(&entry.szExeFile);
            if names.iter().any(|name| image.eq_ignore_ascii_case(name)) {
                pids.push(entry.th32ProcessID);
            }
            ok = Process32NextW(snapshot, &mut entry);
        }

        CloseHandle(snapshot);
        Ok(pids)
    }
}

/// Activate a packaged app by AUMID through the Windows shell (`shell:AppsFolder\<AUMID>`).
///
/// `ShellExecuteW` reports failure as a return value `<= 32`; in that case we retry via
/// PowerShell `Start-Process`, which covers activation paths the shell verb alone rejects.
pub fn activate_aumid(aumid: &str) -> Result<(), String> {
    let shell_path = format!("shell:AppsFolder\\{aumid}");
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            to_wide("open").as_ptr(),
            to_wide(&shell_path).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as usize > 32 {
        return Ok(());
    }

    // ShellExecuteW failed: retry via PowerShell Start-Process.
    let script = format!("Start-Process \"shell:AppsFolder\\{aumid}\"");
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|error| format!("failed to run powershell (Start-Process fallback): {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    Err(format!(
        "ShellExecuteW failed (result {}), and the PowerShell Start-Process fallback also failed{}",
        result as usize,
        if stderr.is_empty() { String::new() } else { format!(": {stderr}") }
    ))
}

/// Inject `dll_path` into the process with id `pid` via the classic
/// `OpenProcess` → `VirtualAllocEx` → `WriteProcessMemory` → `CreateRemoteThread(LoadLibraryW)`
/// sequence, then wait for the remote thread and clean up.
pub fn inject_dll_into_process(pid: u32, dll_path: &str) -> Result<(), String> {
    let dll_wide = to_wide(dll_path);
    let dll_len = dll_wide.len() * std::mem::size_of::<u16>();

    unsafe {
        // 1) Open the target with just enough access to write + spawn a thread.
        let process = OpenProcess(
            PROCESS_CREATE_THREAD
                | PROCESS_VM_OPERATION
                | PROCESS_VM_WRITE
                | PROCESS_VM_READ
                | PROCESS_QUERY_INFORMATION,
            0, // FALSE: do not inherit the handle
            pid,
        );
        if process.is_null() {
            return Err(format!("OpenProcess(pid {pid}) failed: {}", last_error()));
        }

        // 2) Reserve + commit a writable region in the target for the DLL path.
        let remote_addr = VirtualAllocEx(
            process,
            std::ptr::null_mut(),
            dll_len,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote_addr.is_null() {
            let error = last_error();
            CloseHandle(process);
            return Err(format!("VirtualAllocEx(pid {pid}) failed: {error}"));
        }

        // 3) Copy the NUL-terminated UTF-16 DLL path into the remote region.
        let written = WriteProcessMemory(
            process,
            remote_addr,
            dll_wide.as_ptr() as *const c_void,
            dll_len,
            std::ptr::null_mut(),
        );
        if written == 0 {
            let error = last_error();
            VirtualFreeEx(process, remote_addr, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err(format!("WriteProcessMemory(pid {pid}) failed: {error}"));
        }

        // 4) Resolve LoadLibraryW in the target's kernel32.
        let kernel32 = GetModuleHandleW(to_wide("kernel32.dll").as_ptr());
        if kernel32.is_null() {
            let error = last_error();
            VirtualFreeEx(process, remote_addr, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err(format!("GetModuleHandleW(kernel32.dll) failed: {error}"));
        }
        let load_library_w = GetProcAddress(kernel32, c"LoadLibraryW".as_ptr());
        if load_library_w.is_null() {
            VirtualFreeEx(process, remote_addr, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err("GetProcAddress(LoadLibraryW) returned NULL".to_string());
        }
        // Both are thin pointers to functions; FARPROC → the thread start-routine type.
        let start_routine: winapi::um::minwinbase::LPTHREAD_START_ROUTINE =
            std::mem::transmute::<FARPROC, winapi::um::minwinbase::LPTHREAD_START_ROUTINE>(
                load_library_w,
            );

        // 5) Run LoadLibraryW(remote_addr) on a fresh thread in the target.
        let thread = CreateRemoteThread(
            process,
            std::ptr::null_mut(),
            0,
            start_routine,
            remote_addr,
            0,
            std::ptr::null_mut(),
        );
        if thread.is_null() {
            let error = last_error();
            VirtualFreeEx(process, remote_addr, 0, MEM_RELEASE);
            CloseHandle(process);
            return Err(format!("CreateRemoteThread(pid {pid}) failed: {error}"));
        }

        // 6) Wait for LoadLibraryW to finish (DllMain runs inside it), then release everything.
        let wait = WaitForSingleObject(thread, ATTACH_WAIT_MS);
        CloseHandle(thread);
        VirtualFreeEx(process, remote_addr, 0, MEM_RELEASE);
        CloseHandle(process);

        if wait == WAIT_TIMEOUT {
            return Err(format!("inject thread into pid {pid} did not finish within 10s"));
        }
        if wait == WAIT_FAILED {
            return Err(format!("WaitForSingleObject(pid {pid}) failed: {}", last_error()));
        }
        Ok(())
    }
}

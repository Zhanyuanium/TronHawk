use std::ffi::{c_char, c_void};

use retour::static_detour;

mod env {
    use std::sync::LazyLock;

    macro_rules! lazy_env {
        ($name:expr) => {
            LazyLock::new(|| std::env::var($name).unwrap_or_default())
        };
    }

    pub static MODLOADER_ASAR_PATH: LazyLock<String> = lazy_env!("MODLOADER_ASAR_PATH");
    pub static MODLOADER_LIBRARY_PATH: LazyLock<String> = lazy_env!("MODLOADER_LIBRARY_PATH");

    // The app-<version> folder this process was launched from.
    pub static CURRENT_APP_FOLDER: LazyLock<Option<String>> = LazyLock::new(|| {
        std::env::current_exe()
            .ok()?
            .parent()?
            .file_name()?
            .to_str()
            .map(|s| s.to_string())
    });
}

#[link(name = "dl")]
unsafe extern "C" {
    unsafe fn dlsym(handle: *const c_void, symbol: *const c_char) -> *const c_void;
}

static_detour! {
    static UvFsLstatDetour: fn(*const c_void, *const c_void, *const c_char, *mut c_void) -> i32;
}

#[ctor::ctor]
unsafe fn init_dynamic_hooks() {
    let original = dlsym(libc::RTLD_DEFAULT, c"uv_fs_lstat".as_ptr());

    if original.is_null() {
        eprintln!("[electron-hook] uv_fs_lstat not found in the executable; skipping hook");
        return;
    }

    #[allow(clippy::missing_transmute_annotations, clippy::transmute_ptr_to_fn)]
    UvFsLstatDetour
        .initialize(
            std::mem::transmute::<*const c_void, _>(original),
            uv_fs_lstat,
        )
        .unwrap();

    UvFsLstatDetour.enable().unwrap();
}

// This is a fix needed for flatpak support, as zypak is stripping our LD_PRELOAD incorrectly
// See: https://github.com/refi64/zypak/issues/42
#[no_mangle]
unsafe extern "C" fn unsetenv(name: *const c_char) -> i32 {
    let original_unsetenv: unsafe extern "C" fn(*const c_char) -> i32 =
        std::mem::transmute(dlsym(libc::RTLD_NEXT, c"unsetenv".as_ptr()));

    let Ok(name_str) = unsafe { std::ffi::CStr::from_ptr(name) }.to_str() else {
        return original_unsetenv(name);
    };

    if name_str == "LD_PRELOAD" {
        std::env::set_var("LD_PRELOAD", &*env::MODLOADER_LIBRARY_PATH);
        return 0;
    }

    original_unsetenv(name)
}

fn uv_fs_lstat(
    loop_: *const c_void,
    req: *const c_void,
    path: *const c_char,
    buf: *mut c_void,
) -> i32 {
    let Ok(path_str) = (unsafe { std::ffi::CStr::from_ptr(path) }).to_str() else {
        return UvFsLstatDetour.call(loop_, req, path, buf);
    };

    match crate::paths::redirect_asar_path(path_str, &env::MODLOADER_ASAR_PATH, env::CURRENT_APP_FOLDER.as_deref()) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            UvFsLstatDetour.call(loop_, req, redirect_to_c.as_ptr(), buf)
        }
        None => UvFsLstatDetour.call(loop_, req, path, buf),
    }
}

type XStat64 = unsafe extern "C" fn(i32, *const c_char, *mut libc::stat64) -> i64;

#[no_mangle]
unsafe extern "C" fn __xstat64(ver: i32, path: *const c_char, out: *mut libc::stat64) -> i64 {
    use std::sync::LazyLock;

    static ORIGINAL_XSTAT64: LazyLock<XStat64> = LazyLock::new(|| unsafe {
        std::mem::transmute(dlsym(libc::RTLD_NEXT, c"__xstat64".as_ptr()))
    });

    let Ok(path_str) = (unsafe { std::ffi::CStr::from_ptr(path) }).to_str() else {
        return ORIGINAL_XSTAT64(ver, path, out);
    };

    match crate::paths::redirect_asar_path(path_str, &env::MODLOADER_ASAR_PATH, env::CURRENT_APP_FOLDER.as_deref()) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            ORIGINAL_XSTAT64(ver, redirect_to_c.as_ptr(), out)
        }
        None => ORIGINAL_XSTAT64(ver, path, out),
    }
}

type Open64 = unsafe extern "C" fn(*const c_char, i32, i32) -> i32;

#[no_mangle]
unsafe extern "C" fn open64(path: *const c_char, flags: i32, mode: i32) -> i32 {
    use std::sync::LazyLock;

    static ORIGINAL_OPEN64: LazyLock<Open64> = LazyLock::new(|| unsafe {
        std::mem::transmute(dlsym(libc::RTLD_NEXT, c"open64".as_ptr()))
    });

    let Ok(path_str) = (unsafe { std::ffi::CStr::from_ptr(path) }).to_str() else {
        return ORIGINAL_OPEN64(path, flags, mode);
    };

    // Only proxy reads. Writes go to the original asar.
    if !crate::paths::should_proxy_open(flags) {
        return ORIGINAL_OPEN64(path, flags, mode);
    }

    match crate::paths::redirect_asar_path(path_str, &env::MODLOADER_ASAR_PATH, env::CURRENT_APP_FOLDER.as_deref()) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            ORIGINAL_OPEN64(redirect_to_c.as_ptr(), flags, mode)
        }
        None => ORIGINAL_OPEN64(path, flags, mode),
    }
}

type OpenAt64 = unsafe extern "C" fn(i32, *const c_char, i32, i32) -> i32;

#[no_mangle]
unsafe extern "C" fn openat64(dirfd: i32, path: *const c_char, flags: i32, mode: i32) -> i32 {
    use std::sync::LazyLock;

    static ORIGINAL_OPENAT64: LazyLock<OpenAt64> = LazyLock::new(|| unsafe {
        std::mem::transmute(dlsym(libc::RTLD_NEXT, c"openat64".as_ptr()))
    });

    let Ok(path_str) = (unsafe { std::ffi::CStr::from_ptr(path) }).to_str() else {
        return ORIGINAL_OPENAT64(dirfd, path, flags, mode);
    };

    // Only proxy reads. Writes go to the original asar.
    if !crate::paths::should_proxy_open(flags) {
        return ORIGINAL_OPENAT64(dirfd, path, flags, mode);
    }

    match crate::paths::redirect_asar_path(path_str, &env::MODLOADER_ASAR_PATH, env::CURRENT_APP_FOLDER.as_deref()) {
        Some(redirect_to) => {
            let redirect_to_c = std::ffi::CString::new(redirect_to).unwrap();
            ORIGINAL_OPENAT64(dirfd, redirect_to_c.as_ptr(), flags, mode)
        }
        None => ORIGINAL_OPENAT64(dirfd, path, flags, mode),
    }
}

//! TronHawk injector launcher.
//!
//! Usage:
//!   tronhawk-injector-launcher <target-exe> [target-args...]   # inject + launch
//!   tronhawk-injector-launcher register <target-exe>           # register IFEO (elevated)
//!   tronhawk-injector-launcher unregister <target-exe>         # unregister IFEO (elevated)
//!   tronhawk-injector-launcher --aumid <AUMID>                 # AUMID-activate + race-attach (probe)
//!
//! The injector DLL, bootstrap, and runtime are resolved relative to the launcher's own location,
//! so the four artifacts (`launcher.exe`, `tronhawk_injector.dll`, `bootstrap.js`, `runtime.js`)
//! are deployed side by side.

use std::path::{Path, PathBuf};

use electron_hook::asar::Asar;

#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use std::time::{Duration, Instant};

const DLL_NAME: &str = "tronhawk_injector.dll";
const BOOTSTRAP_NAME: &str = "bootstrap.js";
// bootstrap.js `require(path.join(__dirname, "runtime.js"))` at injection time, so a missing
// runtime.js must fail fast here rather than deep inside the launched target.
const RUNTIME_NAME: &str = "runtime.js";

fn launcher_dir() -> PathBuf {
    std::env::current_exe()
        .expect("failed to resolve launcher path")
        .parent()
        .expect("launcher has no parent dir")
        .to_path_buf()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: tronhawk-injector-launcher <target-exe> [target-args...]");
        eprintln!("       tronhawk-injector-launcher register <target-exe>");
        eprintln!("       tronhawk-injector-launcher unregister <target-exe>");
        eprintln!("       tronhawk-injector-launcher --aumid <AUMID>");
        std::process::exit(2);
    }

    match args[0].as_str() {
        "register" => {
            let target = require_arg(&args, 1, "register <target-exe>");
            #[cfg(windows)]
            {
                if let Err(e) = tronhawk_injector::registry::register(target) {
                    eprintln!("[launcher] register failed: {e}");
                    std::process::exit(1);
                }
            }
            println!("[launcher] registered IFEO for {target}");
        }
        "unregister" => {
            let target = require_arg(&args, 1, "unregister <target-exe>");
            #[cfg(windows)]
            {
                if let Err(e) = tronhawk_injector::registry::unregister(target) {
                    eprintln!("[launcher] unregister failed: {e}");
                    std::process::exit(1);
                }
            }
            println!("[launcher] unregistered IFEO for {target}");
        }
        "--aumid" => {
            let aumid_value = require_arg(&args, 1, "--aumid <AUMID>");
            if let Err(error) = aumid(aumid_value) {
                eprintln!("[probe] aumid attach failed: {error}");
                std::process::exit(1);
            }
        }
        target => {
            if let Err(error) = launch(target, &args[1..]) {
                eprintln!("[launcher] launch failed: {error}");
                std::process::exit(1);
            }
        }
    }
}

fn require_arg<'a>(args: &'a [String], idx: usize, usage: &str) -> &'a str {
    match args.get(idx) {
        Some(v) => v.as_str(),
        None => {
            eprintln!("usage: {usage}");
            std::process::exit(2);
        }
    }
}

/// The minimal-stub asar (only index.js + package.json) — the pre-Path-I behavior, kept behind
/// the explicit `TRONHAWK_MINIMAL_ASAR` lever and as the fallback when no real app.asar exists
/// or the merged build fails.
fn minimal_stub(bootstrap: &Path) -> Result<PathBuf, String> {
    let entrypoint = bootstrap
        .to_str()
        .ok_or_else(|| format!("bootstrap path is not valid UTF-8: {}", bootstrap.display()))?;
    Asar::new()
        .with_id("tronhawk")
        .with_template(tronhawk_injector::asar_merge::ENTRY_TEMPLATE)
        .with_mod_entrypoint(entrypoint)
        .create()
        .map_err(|error| format!("failed to create modded asar: {error:?}"))
}

/// Find the real `resources/app.asar` for the target executable, used as the source of the
/// merged asar. Candidates, in order:
///   - `<exe_dir>/resources/app.asar` (flat layout, e.g. Obsidian)
///   - `<exe_dir>/app-*/resources/app.asar` (electron-hook `app-<version>` layout)
/// Returns the first that exists, canonicalized best-effort.
fn find_real_asar(target_exe: &str) -> Option<PathBuf> {
    let exe_dir = Path::new(target_exe).parent()?;
    let mut candidates = vec![exe_dir.join("resources").join("app.asar")];
    if let Some(app_dir) = std::fs::read_dir(exe_dir).ok()?.find_map(|entry| {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        name.starts_with("app-").then_some(entry.path())
    }) {
        candidates.push(app_dir.join("resources").join("app.asar"));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| std::fs::canonicalize(candidate).ok())
}

fn launch(target_exe: &str, target_args: &[String]) -> Result<(), String> {
    let dir = launcher_dir();
    let dll = dir.join(DLL_NAME);
    let bootstrap = dir.join(BOOTSTRAP_NAME);
    let runtime = dir.join(RUNTIME_NAME);

    if !dll.exists() {
        return Err(format!("injector dll not found: {}", dll.display()));
    }
    if !bootstrap.exists() {
        return Err(format!("bootstrap not found: {}", bootstrap.display()));
    }
    if !runtime.exists() {
        return Err(format!("runtime not found: {}", runtime.display()));
    }

    let bootstrap_abs = bootstrap
        .to_str()
        .ok_or_else(|| format!("bootstrap path is not valid UTF-8: {}", bootstrap.display()))?
        .to_string();

    // Path I: prefer a merged asar (entire real app.asar + overridden entrypoint) so that
    // app.getAppPath()/module resolution serve real files. Kept only in electron-hook's cache
    // dir; the target's own files are never touched.
    let asar_path = if std::env::var_os("TRONHAWK_MINIMAL_ASAR").is_some() {
        minimal_stub(&bootstrap)? // explicit A/B lever
    } else if let Some(real) = find_real_asar(target_exe) {
        let cache = electron_hook::paths::asar_cache_path("tronhawk");
        match tronhawk_injector::asar_merge::build_merged_asar(&real, &cache, &bootstrap_abs) {
            Ok(report) => {
                println!(
                    "[launcher] merged asar: {} entries, {} bytes from {}",
                    report.entries,
                    report.output_bytes,
                    report.source.display()
                );
                cache
            }
            Err(e) => {
                eprintln!("[launcher] merged asar failed ({e}); falling back to minimal stub");
                minimal_stub(&bootstrap)?
            }
        }
    } else {
        minimal_stub(&bootstrap)? // unpacked app (no app.asar): unchanged behavior
    };

    let dll_str = dll
        .to_str()
        .ok_or_else(|| format!("injector dll path is not valid UTF-8: {}", dll.display()))?;
    let asar_str = asar_path
        .to_str()
        .ok_or_else(|| format!("asar path is not valid UTF-8: {}", asar_path.display()))?;

    println!("[launcher] asar: {}", asar_path.display());
    println!("[launcher] dll: {}", dll.display());
    println!("[launcher] bootstrap: {}", bootstrap.display());
    println!("[launcher] runtime: {}", runtime.display());

    let port = tronhawk_injector::launch_session::ipc_port();
    let control_token = tronhawk_injector::launch_session::read_control_token()?;
    tronhawk_injector::launch_session::with_launch_session(
        port,
        target_exe,
        &control_token,
        || {
            electron_hook::launch(
                target_exe,
                dll_str,
                asar_str,
                target_args.to_vec(),
                true,
            )
        },
    )?
    .map_err(|error| format!("electron_hook::launch failed: {error:?}"))?;

    println!("[launcher] launched {target_exe}");
    Ok(())
}

/// `--aumid` is a Windows-only probe (ADR 0005): AUMID-activate the MSIX-packaged ChatGPT Desktop
/// and race-attach the injector DLL to the newly spawned process. Not supported elsewhere.
#[cfg(not(windows))]
fn aumid(_aumid: &str) -> Result<(), String> {
    Err("--aumid activation is only supported on Windows".to_string())
}

/// AUMID-activation attach probe. Unlike `launch`, there is no `CREATE_SUSPENDED` handle, so the
/// Detours-at-creation path cannot be used; instead we build the merged asar + sidecar config,
/// activate the packaged app, and attach via `CreateRemoteThread` + `LoadLibraryW` the moment the
/// new `ChatGPT.exe`/`Codex.exe` process appears.
#[cfg(windows)]
fn aumid(aumid: &str) -> Result<(), String> {
    use tronhawk_injector::{asar_merge, attach, launch_session};

    let dir = launcher_dir();
    let dll = dir.join(DLL_NAME);
    let bootstrap = dir.join(BOOTSTRAP_NAME);
    let runtime = dir.join(RUNTIME_NAME);

    if !dll.exists() {
        return Err(format!("injector dll not found: {}", dll.display()));
    }
    if !bootstrap.exists() {
        return Err(format!("bootstrap not found: {}", bootstrap.display()));
    }
    if !runtime.exists() {
        return Err(format!("runtime not found: {}", runtime.display()));
    }

    let dll_str = dll
        .to_str()
        .ok_or_else(|| format!("injector dll path is not valid UTF-8: {}", dll.display()))?
        .to_string();
    let bootstrap_abs = bootstrap
        .to_str()
        .ok_or_else(|| format!("bootstrap path is not valid UTF-8: {}", bootstrap.display()))?
        .to_string();

    // 1) Resolve the MSIX install root and the `\app` layout (ChatGPT.exe + resources/app.asar).
    let install_root = resolve_install_root("OpenAI.Codex")?;
    println!("[probe] install root: {}", install_root.display());
    let (exe_dir, real_asar) = resolve_codex_layout(&install_root)?;
    let exe_path = exe_dir.join("ChatGPT.exe");
    let folder_name = exe_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "cannot derive MODLOADER_FOLDER_NAME from install layout".to_string())?;
    println!("[probe] real asar: {}", real_asar.display());
    println!("[probe] exe: {}", exe_path.display());

    // 2) Build the merged asar into electron-hook's cache. No minimal-stub fallback here: the
    //    whole point of the probe is the asar remap, so activate only if the merged asar exists.
    let cache = electron_hook::paths::asar_cache_path("tronhawk");
    let report = asar_merge::build_merged_asar(&real_asar, &cache, &bootstrap_abs)
        .map_err(|error| format!("merged asar failed: {error}"))?;
    println!(
        "[launcher] merged asar: {} entries, {} bytes from {}",
        report.entries,
        report.output_bytes,
        report.source.display()
    );
    let asar_str = cache
        .to_str()
        .ok_or_else(|| format!("asar cache path is not valid UTF-8: {}", cache.display()))?
        .to_string();

    // 3) Sidecar config next to the launcher. The activated process does not inherit our
    //    environment, so the injected DLL's DllMain re-applies these via SetEnvironmentVariableW
    //    before the MODLOADER_* / TRONHAWK_IPC_* values are first read.
    let sidecar_path = dir.join("tronhawk-sidecar.json");
    let exe_str = exe_path
        .to_str()
        .ok_or_else(|| format!("exe path is not valid UTF-8: {}", exe_path.display()))?
        .to_string();
    let port = launch_session::ipc_port();
    let ipc_secret = launch_session_secret(port, &exe_str);

    let mut sidecar = serde_json::Map::new();
    sidecar.insert(
        "MODLOADER_ASAR_PATH".into(),
        serde_json::Value::String(asar_str),
    );
    sidecar.insert(
        "MODLOADER_LIBRARY_PATH".into(),
        serde_json::Value::String(dll_str.clone()),
    );
    sidecar.insert(
        "MODLOADER_FOLDER_NAME".into(),
        serde_json::Value::String(folder_name.to_string()),
    );
    sidecar.insert(
        "MODLOADER_ORIGINAL_ASAR_RELATIVE".into(),
        serde_json::Value::String("../_app.asar".into()),
    );
    sidecar.insert(
        "MODLOADER_PROCESS_ARGV".into(),
        serde_json::Value::String("[]".into()),
    );
    sidecar.insert(
        "MODLOADER_MOD_ENTRYPOINT".into(),
        serde_json::Value::String(bootstrap_abs),
    );
    sidecar.insert(
        "MODLOADER_EXECUTABLE".into(),
        serde_json::Value::String(exe_str),
    );
    sidecar.insert(
        "TRONHAWK_IPC_PORT".into(),
        serde_json::Value::String(port.to_string()),
    );
    sidecar.insert(
        "TRONHAWK_IPC_SECRET".into(),
        serde_json::Value::String(ipc_secret),
    );
    let sidecar_text = serde_json::to_string_pretty(&serde_json::Value::Object(sidecar))
        .map_err(|error| format!("serialize sidecar: {error}"))?;
    std::fs::write(&sidecar_path, sidecar_text)
        .map_err(|error| format!("write sidecar {}: {error}", sidecar_path.display()))?;
    println!("[probe] sidecar: {}", sidecar_path.display());

    // 4) Activate via the shell, remembering the processes that already exist.
    let names = ["ChatGPT.exe", "Codex.exe"];
    let before = attach::process_pids_by_image(&names)
        .map_err(|error| format!("pre-activation process snapshot failed: {error}"))?;
    println!("[probe] activating {aumid} ...");
    attach::activate_aumid(aumid)
        .map_err(|error| format!("activation failed: {error}"))?;

    // 5) Wait for a process that was NOT there before, then race-attach the DLL.
    let deadline = Instant::now() + Duration::from_secs(15);
    let new_pid = loop {
        let pids = attach::process_pids_by_image(&names)
            .map_err(|error| format!("post-activation process snapshot failed: {error}"))?;
        if let Some(pid) = pids.into_iter().find(|pid| !before.contains(pid)) {
            break pid;
        }
        if Instant::now() >= deadline {
            return Err(
                "no new ChatGPT.exe/Codex.exe process appeared within 15s (already running? \
                 single-instance activation only focuses the existing window)"
                    .to_string(),
            );
        }
        thread::sleep(Duration::from_millis(250));
    };
    println!("[probe] new process: pid {new_pid}");

    attach::inject_dll_into_process(new_pid, &dll_str)
        .map_err(|error| format!("inject pid {new_pid}: {error}"))?;
    println!("[probe] attached to pid {new_pid}");

    Ok(())
}

/// Best-effort launch token for the sidecar: ask Core for a launch session only if it is
/// reachable. On any error the secret is left empty so the runtime's plan poll simply fails
/// rather than the whole attach probe aborting.
#[cfg(windows)]
fn launch_session_secret(port: u16, exe_path: &str) -> String {
    use tronhawk_injector::launch_session;

    let Ok(control) = launch_session::read_control_token() else {
        return String::new();
    };
    launch_session::with_launch_session(port, exe_path, &control, || {
        std::env::var("TRONHAWK_IPC_SECRET").unwrap_or_default()
    })
    .unwrap_or_default()
}

/// Resolve the MSIX install root for a package: `Get-AppxPackage` first, falling back to a scan
/// of `C:\Program Files\WindowsApps` for a directory named `<package>_...`.
#[cfg(windows)]
fn resolve_install_root(package_name: &str) -> Result<PathBuf, String> {
    let script = format!(
        "Get-AppxPackage -Name {package_name} | Select-Object -ExpandProperty InstallLocation"
    );
    // Any PowerShell failure (missing exe, non-zero exit, empty output) falls through to the
    // WindowsApps scan below rather than aborting the probe.
    let powershell_root = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(PathBuf::from)
        });
    if let Some(root) = powershell_root {
        return Ok(root);
    }

    let prefix = format!("{package_name}_");
    let apps_dir = Path::new(r"C:\Program Files\WindowsApps");
    let entries = std::fs::read_dir(apps_dir)
        .map_err(|error| format!("failed to scan {}: {error}", apps_dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) {
            return Ok(entry.path());
        }
    }

    Err(format!(
        "could not resolve install root for {package_name} (PowerShell query and WindowsApps scan both failed)"
    ))
}

/// Locate the Codex app layout inside an MSIX install root. Codex ships as `app\resources\app.asar`
/// (`app\ChatGPT.exe`); the flat `<root>\resources\app.asar` layout is tried as a fallback.
/// Returns the directory that directly contains `resources` (the exe dir) and the real app.asar.
#[cfg(windows)]
fn resolve_codex_layout(install_root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let app_dir = install_root.join("app");
    let app_asar = app_dir.join("resources").join("app.asar");
    let flat_asar = install_root.join("resources").join("app.asar");

    if app_asar.is_file() {
        Ok((app_dir, app_asar))
    } else if flat_asar.is_file() {
        Ok((install_root.to_path_buf(), flat_asar))
    } else {
        Err(format!(
            "no app.asar under {} (tried {} and {})",
            install_root.display(),
            app_asar.display(),
            flat_asar.display()
        ))
    }
}

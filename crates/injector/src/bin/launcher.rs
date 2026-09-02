//! TronHawk injector launcher.
//!
//! Usage:
//!   tronhawk-injector-launcher <target-exe> [target-args...]   # inject + launch
//!   tronhawk-injector-launcher register <target-exe>           # register IFEO (elevated)
//!   tronhawk-injector-launcher unregister <target-exe>         # unregister IFEO (elevated)
//!
//! The injector DLL, bootstrap, and runtime are resolved relative to the launcher's own location,
//! so the four artifacts (`launcher.exe`, `tronhawk_injector.dll`, `bootstrap.js`, `runtime.js`)
//! are deployed side by side.

use std::path::{Path, PathBuf};

use electron_hook::asar::Asar;

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

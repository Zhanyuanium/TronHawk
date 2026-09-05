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
//!
//! Diagnostics: every run appends a timestamped line to `<storage root>/logs/launcher.log`
//! (directory auto-created; append-only) covering the key phases of each mode. Console output is
//! preserved unchanged so the Manager's stdout contract for `launch` and the existing `register`/
//! `unregister` console output stay byte-for-byte identical.

use std::io::Write;
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

// ---------------------------------------------------------------------------------------------
// Launcher log (storage_root()/logs/launcher.log). Best-effort: a failed log write never fails
// the launcher itself; console echo is independent of it.
// ---------------------------------------------------------------------------------------------

fn launcher_log_path() -> PathBuf {
    tronhawk_injector::launch_session::storage_root()
        .join("logs")
        .join("launcher.log")
}

fn log_line(message: &str) {
    let path = launcher_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{timestamp}] {message}");
        let _ = file.sync_data();
    }
}

/// Console-stderr echo plus a launcher.log line (used for failure paths).
fn log_stderr(message: &str) {
    eprintln!("{message}");
    log_line(message);
}

/// Console-stdout echo plus a launcher.log line (used for success paths that keep a stdout
/// contract, e.g. `register`/`unregister`).
fn log_stdout(message: &str) {
    println!("{message}");
    log_line(message);
}

// ---------------------------------------------------------------------------------------------
// Per-target asar cache naming
// ---------------------------------------------------------------------------------------------

/// Stable 8-hex-digit hash of a byte string (FNV-1a 64, low 32 bits). Deterministic across runs
/// and processes — unlike `DefaultHasher`.
fn stable_hash8(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in data {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:08x}", (hash & 0xffff_ffff) as u32)
}

/// Cache id for one target executable: `tronhawk-<hash8>` where the hash is computed from the
/// canonicalized target path. Each target gets its own merged-asar cache name (and therefore its
/// own `.asar.unpacked` junction), so launching target A can never clobber target B's merged asar
/// or leave B's junction pointing at the wrong app's native modules.
fn asar_cache_id(target_exe: &str) -> String {
    let path = std::fs::canonicalize(target_exe).unwrap_or_else(|_| PathBuf::from(target_exe));
    let mut key = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        key = key.to_lowercase();
    }
    format!("tronhawk-{}", stable_hash8(key.as_bytes()))
}

// ---------------------------------------------------------------------------------------------
// app.asar.unpacked junction (reparse-aware)
// ---------------------------------------------------------------------------------------------

fn launcher_dir() -> PathBuf {
    std::env::current_exe()
        .expect("failed to resolve launcher path")
        .parent()
        .expect("launcher has no parent dir")
        .to_path_buf()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    log_line(&format!("launcher start: {}", args.join(" ")));
    if args.is_empty() {
        let usage = "usage: tronhawk-injector-launcher <target-exe> [target-args...]\n       tronhawk-injector-launcher register <target-exe>\n       tronhawk-injector-launcher unregister <target-exe>\n       tronhawk-injector-launcher --aumid <AUMID>";
        log_stderr(usage);
        std::process::exit(2);
    }

    match args[0].as_str() {
        "register" => {
            let target = require_arg(&args, 1, "register <target-exe>");
            log_line(&format!("register: {target}"));
            #[cfg(windows)]
            {
                if let Err(e) = tronhawk_injector::registry::register(target) {
                    log_stderr(&format!("[launcher] register failed: {e}"));
                    std::process::exit(1);
                }
            }
            log_stdout(&format!("[launcher] registered IFEO for {target}"));
        }
        "unregister" => {
            let target = require_arg(&args, 1, "unregister <target-exe>");
            log_line(&format!("unregister: {target}"));
            #[cfg(windows)]
            {
                if let Err(e) = tronhawk_injector::registry::unregister(target) {
                    log_stderr(&format!("[launcher] unregister failed: {e}"));
                    std::process::exit(1);
                }
            }
            log_stdout(&format!("[launcher] unregistered IFEO for {target}"));
        }
        "--aumid" => {
            let aumid_value = require_arg(&args, 1, "--aumid <AUMID>");
            log_line(&format!("probe start: aumid={aumid_value}"));
            if let Err(error) = aumid(aumid_value) {
                log_stderr(&format!("[probe] aumid attach failed: {error}"));
                std::process::exit(1);
            }
        }
        target => {
            log_line(&format!(
                "launch: target={target} args={:?}",
                &args[1..]
            ));
            if let Err(error) = launch(target, &args[1..]) {
                log_stderr(&format!("[launcher] launch failed: {error}"));
                std::process::exit(1);
            }
        }
    }
    log_line("launcher exit: ok");
}

fn require_arg<'a>(args: &'a [String], idx: usize, usage: &str) -> &'a str {
    match args.get(idx) {
        Some(v) => v.as_str(),
        None => {
            let message = format!("usage: {usage}");
            log_stderr(&message);
            std::process::exit(2);
        }
    }
}

/// The minimal-stub asar (only index.js + package.json) — the pre-Path-I behavior, kept behind
/// the explicit `TRONHAWK_MINIMAL_ASAR` lever and as the fallback when no real app.asar exists
/// or the merged build fails. The stub is written under `asar_cache_id`, matching the merged
/// asar naming so a target never shares a cache slot with another target.
fn minimal_stub(bootstrap: &Path, cache_id: &str) -> Result<PathBuf, String> {
    let entrypoint = bootstrap
        .to_str()
        .ok_or_else(|| format!("bootstrap path is not valid UTF-8: {}", bootstrap.display()))?;
    Asar::new()
        .with_id(cache_id)
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

/// Whether `metadata` describes a reparse point / symlink. Junctions are reparse points whose
/// attributes are reported by `symlink_metadata` (which never follows them).
fn is_reparse_or_symlink(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(windows)]
fn paths_equivalent(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn paths_equivalent(left: &Path, right: &Path) -> bool {
    left == right
}

/// State of the merged-asar `.unpacked` sibling path relative to the expected real unpacked dir.
#[derive(Debug, PartialEq, Eq)]
enum UnpackedLinkState {
    /// Nothing occupies the path yet.
    Absent,
    /// A reparse point resolving to `expected_target`, and that target is a reachable directory.
    Linked,
    /// A reparse point that is stale: wrong target, or its target is unreachable.
    Stale,
    /// A non-reparse entry (real directory, regular file, ...) occupies the path.
    Occupied,
}

/// Classify the `.unpacked` sibling path using `symlink_metadata` (never `exists()`, which
/// follows the junction and cannot distinguish a stale/dangling link from a missing one).
fn classify_unpacked_link(
    merged_unpacked: &Path,
    expected_target: &Path,
) -> Result<UnpackedLinkState, String> {
    let metadata = match std::fs::symlink_metadata(merged_unpacked) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UnpackedLinkState::Absent);
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect {}: {error}",
                merged_unpacked.display()
            ));
        }
    };
    if !is_reparse_or_symlink(&metadata) {
        return Ok(UnpackedLinkState::Occupied);
    }
    let linked = std::fs::read_link(merged_unpacked)
        .map(|actual| {
            paths_equivalent(&actual, expected_target)
                && std::fs::metadata(expected_target)
                    .map(|target| target.is_dir())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    Ok(if linked {
        UnpackedLinkState::Linked
    } else {
        UnpackedLinkState::Stale
    })
}

/// Remove a stale junction/symlink entry at `path` without touching its target. `remove_dir_all`
/// is used because Rust removes a top-level reparse point / symlink itself (it never follows it),
/// and on Windows junctions are NOT reported as directories by `Metadata::is_dir()` — so any
/// `is_dir`-based remove_dir/remove_file choice lands on the wrong syscall and fails with
/// ERROR_ACCESS_DENIED. A file symlink falls back to `remove_file`.
fn remove_link_entry(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "cannot inspect stale link {}: {error}",
                path.display()
            ));
        }
    }
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
            std::fs::remove_file(path)
                .map_err(|error| format!("cannot remove stale link {}: {error}", path.display()))
        }
        Err(error) => Err(format!(
            "cannot remove stale link {}: {error}",
            path.display()
        )),
    }
}

/// Create a directory junction at `link` pointing at `target` (no elevation required) and verify
/// it after creation.
#[cfg(windows)]
fn create_unpacked_junction(link: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create junction parent {}: {error}", parent.display()))?;
    }
    let link_str = link
        .to_str()
        .ok_or_else(|| format!("junction path is not valid UTF-8: {}", link.display()))?;
    let target_str = target
        .to_str()
        .ok_or_else(|| format!("junction target is not valid UTF-8: {}", target.display()))?;
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J", link_str, target_str])
        .status()
        .map_err(|error| {
            format!(
                "failed to run mklink /J for {} -> {}: {error}",
                link.display(),
                target.display()
            )
        })?;
    if !status.success() {
        return Err(format!(
            "mklink /J failed for {} -> {} (exit {status})",
            link.display(),
            target.display()
        ));
    }
    if classify_unpacked_link(link, target)? != UnpackedLinkState::Linked {
        return Err(format!(
            "mklink /J reported success but {} is not a junction to {}",
            link.display(),
            target.display()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_unpacked_junction(_link: &Path, _target: &Path) -> Result<(), String> {
    Err("app.asar.unpacked junctions are only supported on Windows".to_owned())
}

/// Reconcile `merged_unpacked` to be a junction onto `real_unpacked`: create it when absent,
/// repair it when stale (the occupying reparse point is removed first — safe, a junction is a
/// link, never the target's data), and reject a non-reparse occupant with a descriptive error.
fn reconcile_unpacked_link(merged_unpacked: &Path, real_unpacked: &Path) -> Result<(), String> {
    match classify_unpacked_link(merged_unpacked, real_unpacked)? {
        UnpackedLinkState::Linked => Ok(()),
        UnpackedLinkState::Absent => create_unpacked_junction(merged_unpacked, real_unpacked),
        UnpackedLinkState::Stale => {
            remove_link_entry(merged_unpacked)?;
            create_unpacked_junction(merged_unpacked, real_unpacked)
        }
        UnpackedLinkState::Occupied => Err(format!(
            "cannot link app.asar.unpacked at {}: a non-junction entry already exists there",
            merged_unpacked.display()
        )),
    }
}

/// After building a merged asar into electron-hook's cache, make its `<merged>.asar.unpacked`
/// sibling resolve to the target's real `resources\app.asar.unpacked` via a junction (no admin
/// needed). Native modules (e.g. `better-sqlite3`) live in that `.unpacked` dir and must be
/// reachable from the merged asar's unpacked path; otherwise Electron resolves the sibling in the
/// cache dir (absent) and the native binding fails to load.
fn link_app_asar_unpacked(real_asar: &Path, merged_asar: &Path) -> Result<(), String> {
    let Some(real_unpacked) = real_asar
        .parent()
        .map(|parent| parent.join("app.asar.unpacked"))
        .filter(|path| path.is_dir())
    else {
        return Ok(()); // no native modules
    };
    let merged_unpacked = PathBuf::from(format!("{}.unpacked", merged_asar.display()));
    reconcile_unpacked_link(&merged_unpacked, &real_unpacked)
}

// ---------------------------------------------------------------------------------------------
// Target executable path normalization
// ---------------------------------------------------------------------------------------------

/// Convert an executable path into the ordinary Win32 absolute form that CreateProcess / Detours
/// can actually launch.
///
/// Core stores application executable paths in canonical form: `std::fs::canonicalize` on Windows
/// yields a `\\?\...` extended-length (verbatim) path, and Core's own normalization rewrites the
/// separators to `/` (so the stored form looks like `//?/C:/Program Files/Obsidian/Obsidian.exe`).
/// `electron_hook::launch` fails to start such extended-path executables (the process does not
/// survive creation), while the plain `C:\Program Files\...` form works.
///
/// This strips the verbatim prefix — in either the `\\?\` or the forward-slash `//?/` spelling —
/// and normalizes the remaining separators to `\`, preserving the real on-disk casing (the
/// filesystem is case-insensitive). A path without the extended prefix is returned as-is apart
/// from `/`→`\` separator normalization, so genuine UNC paths (`\\server\share\...`) are left
/// alone, and verbatim UNC (`\\?\UNC\server\share\...`) is recovered as `\\server\share\...`.
fn normalize_win_exe_path(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let mut normalized = stripped.replace('/', r"\");
    if normalized.len() > 4 && normalized[..4].eq_ignore_ascii_case(r"UNC\") {
        normalized = format!(r"\\{}", &normalized[4..]);
    }
    normalized
}

fn launch(target_exe: &str, target_args: &[String]) -> Result<(), String> {
    // Core hands us the canonical `//?/...` path; CreateProcess/Detours cannot launch that form,
    // so normalize once up front and use the plain Win32 path everywhere below (asar discovery,
    // cache keying, the launch-session handoff, and electron_hook::launch itself).
    let target_exe = normalize_win_exe_path(target_exe);
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
    // dir; the target's own files are never touched. Cache names are derived from the target
    // executable (asar_cache_id) so concurrent/multiple targets never share a merged asar or its
    // `.unpacked` junction.
    let cache_id = asar_cache_id(&target_exe);
    log_line(&format!("asar cache id: {cache_id}"));
    let asar_path = if std::env::var_os("TRONHAWK_MINIMAL_ASAR").is_some() {
        log_line("using minimal asar stub (TRONHAWK_MINIMAL_ASAR set)");
        minimal_stub(&bootstrap, &cache_id)? // explicit A/B lever
    } else if let Some(real) = find_real_asar(&target_exe) {
        let cache = electron_hook::paths::asar_cache_path(&cache_id);
        match tronhawk_injector::asar_merge::build_merged_asar(&real, &cache, &bootstrap_abs) {
            Ok(report) => {
                let report_line = format!(
                    "[launcher] merged asar: {} entries, {} bytes from {}",
                    report.entries,
                    report.output_bytes,
                    report.source.display()
                );
                log_stdout(&report_line);
                if let Err(error) = link_app_asar_unpacked(&report.source, &cache) {
                    log_stderr(&format!(
                        "[launcher] failed to link app.asar.unpacked: {error}"
                    ));
                }
                cache
            }
            Err(e) => {
                log_stderr(&format!(
                    "[launcher] merged asar failed ({e}); falling back to minimal stub"
                ));
                minimal_stub(&bootstrap, &cache_id)?
            }
        }
    } else {
        log_line("no real app.asar found; using minimal stub");
        minimal_stub(&bootstrap, &cache_id)? // unpacked app (no app.asar): unchanged behavior
    };

    let dll_str = dll
        .to_str()
        .ok_or_else(|| format!("injector dll path is not valid UTF-8: {}", dll.display()))?;
    let asar_str = asar_path
        .to_str()
        .ok_or_else(|| format!("asar path is not valid UTF-8: {}", asar_path.display()))?;

    let asar_line = format!("[launcher] asar: {}", asar_path.display());
    let dll_line = format!("[launcher] dll: {}", dll.display());
    let bootstrap_line = format!("[launcher] bootstrap: {}", bootstrap.display());
    let runtime_line = format!("[launcher] runtime: {}", runtime.display());
    log_stdout(&asar_line);
    log_stdout(&dll_line);
    log_stdout(&bootstrap_line);
    log_stdout(&runtime_line);

    let port = tronhawk_injector::launch_session::ipc_port();
    let control_token = tronhawk_injector::launch_session::read_control_token()?;
    tronhawk_injector::launch_session::with_launch_session(
        port,
        &target_exe,
        &control_token,
        || {
            electron_hook::launch(
                &target_exe,
                dll_str,
                asar_str,
                target_args.to_vec(),
                true,
            )
        },
    )?
    .map_err(|error| format!("electron_hook::launch failed: {error:?}"))?;

    log_stdout(&format!("[launcher] launched {target_exe}"));
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

    // 2) Build the merged asar into electron-hook's cache under the per-target id. No
    //    minimal-stub fallback here: the whole point of the probe is the asar remap, so activate
    //    only if the merged asar exists.
    let cache_id = asar_cache_id(&exe_path.to_string_lossy());
    let cache = electron_hook::paths::asar_cache_path(&cache_id);
    let report = asar_merge::build_merged_asar(&real_asar, &cache, &bootstrap_abs)
        .map_err(|error| format!("merged asar failed: {error}"))?;
    log_stdout(&format!(
        "[launcher] merged asar: {} entries, {} bytes from {}",
        report.entries,
        report.output_bytes,
        report.source.display()
    ));
    if let Err(error) = link_app_asar_unpacked(&real_asar, &cache) {
        log_stderr(&format!("[probe] failed to link app.asar.unpacked: {error}"));
    }
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

    // The sidecar is re-applied by the injected DLL's DllMain from the DLL's own directory, so it
    // must never outlive the attach: a stale sidecar (e.g. from a previous `--aumid` probe) would
    // clobber a later normal launch with old MODLOADER_FOLDER_NAME / a dead IPC secret, silently
    // breaking asar-remap (bootstrap never runs). Delete it best-effort now that attach is done.
    if let Err(error) = std::fs::remove_file(&sidecar_path) {
        eprintln!(
            "[probe] warning: could not remove sidecar {}: {error}",
            sidecar_path.display()
        );
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static LOG_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tronhawk-launcher-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// Run `body` with `TRONHAWK_STORAGE_ROOT` pointed at `root`, restoring the prior value
    /// afterwards. Serialized against other tests that read the environment.
    fn with_storage_root<T>(root: &Path, body: impl FnOnce() -> T) -> T {
        let _lock = LOG_ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("TRONHAWK_STORAGE_ROOT");
        std::env::set_var("TRONHAWK_STORAGE_ROOT", root);
        let result = body();
        match previous {
            Some(previous) => std::env::set_var("TRONHAWK_STORAGE_ROOT", previous),
            None => std::env::remove_var("TRONHAWK_STORAGE_ROOT"),
        }
        result
    }

    #[test]
    fn launcher_log_path_is_under_storage_root_logs_dir() {
        let root = temp_dir("log-path");
        with_storage_root(&root, || {
            assert_eq!(launcher_log_path(), root.join("logs").join("launcher.log"));
        });
    }

    #[test]
    fn launcher_log_appends_creating_directories() {
        let root = temp_dir("log-append");
        with_storage_root(&root, || {
            log_line("alpha stage");
            log_line("beta stage");
            let contents = std::fs::read_to_string(launcher_log_path()).unwrap();
            assert!(contents.contains("alpha stage"));
            assert!(contents.contains("beta stage"));
        });
    }

    #[test]
    fn normalize_win_exe_path_strips_extended_prefixes_and_unifies_separators() {
        // Core-stored canonical form: `\\?\` verbatim prefix written with forward slashes.
        assert_eq!(
            normalize_win_exe_path("//?/C:/Program Files/Obsidian/Obsidian.exe"),
            r"C:\Program Files\Obsidian\Obsidian.exe"
        );
        // Backslash verbatim spelling.
        assert_eq!(
            normalize_win_exe_path(r"\\?\C:\a\b.exe"),
            r"C:\a\b.exe"
        );
        // No extended prefix: unchanged apart from `/` -> `\`.
        assert_eq!(
            normalize_win_exe_path(r"C:\Program Files\Obsidian\Obsidian.exe"),
            r"C:\Program Files\Obsidian\Obsidian.exe"
        );
        assert_eq!(
            normalize_win_exe_path("C:/Program Files/Obsidian/Obsidian.exe"),
            r"C:\Program Files\Obsidian\Obsidian.exe"
        );
        // Mixed separators after the prefix are unified.
        assert_eq!(
            normalize_win_exe_path(r"\\?\C:\a/b\c.exe"),
            r"C:\a\b\c.exe"
        );
        // Whitespace around the argument is trimmed.
        assert_eq!(
            normalize_win_exe_path("  //?/C:/a/b.exe  "),
            r"C:\a\b.exe"
        );
        // A genuine UNC path is untouched.
        assert_eq!(
            normalize_win_exe_path(r"\\server\share\apps\x.exe"),
            r"\\server\share\apps\x.exe"
        );
        // A verbatim UNC path is recovered to the ordinary UNC form.
        assert_eq!(
            normalize_win_exe_path(r"\\?\UNC\server\share\apps\x.exe"),
            r"\\server\share\apps\x.exe"
        );
        assert_eq!(
            normalize_win_exe_path("//?/UNC/server/share/apps/x.exe"),
            r"\\server\share\apps\x.exe"
        );
    }

    #[test]
    fn normalize_win_exe_path_preserves_given_case() {
        // The path is treated case-insensitively by the filesystem; normalization must not
        // uppercase/lowercase anything (only the prefix and separators change).
        assert_eq!(
            normalize_win_exe_path("//?/c:/program files/obsidian/Obsidian.exe"),
            r"c:\program files\obsidian\Obsidian.exe"
        );
        assert_eq!(
            normalize_win_exe_path(r"\\?\D:\Mixed\Case\App.exe"),
            r"D:\Mixed\Case\App.exe"
        );
    }

    #[test]
    fn normalize_win_exe_path_of_a_plain_name_is_unchanged() {
        assert_eq!(normalize_win_exe_path("notepad.exe"), "notepad.exe");
        assert_eq!(
            normalize_win_exe_path("./relative/tool.exe"),
            r".\relative\tool.exe"
        );
    }

    #[test]
    fn asar_cache_id_is_deterministic_and_distinct_per_target() {
        let first = asar_cache_id(r"C:\Apps\One\One.exe");
        let second = asar_cache_id(r"C:\Apps\Two\Two.exe");
        assert_ne!(first, second, "distinct targets must not share a cache id");
        assert_eq!(
            first,
            asar_cache_id(r"C:\Apps\One\One.exe"),
            "same target must hash deterministically"
        );
        assert!(first.starts_with("tronhawk-"), "cache id prefix: {first}");
        assert_eq!(
            first.len(),
            "tronhawk-".len() + 8,
            "cache id must carry an 8-hex-digit hash"
        );
    }

    #[test]
    fn asar_cache_id_ignores_path_case_on_windows_only() {
        let upper = asar_cache_id(r"C:\Apps\Case\Case.exe");
        #[cfg(windows)]
        let lower = asar_cache_id(r"c:\apps\case\case.exe");
        #[cfg(not(windows))]
        let lower = asar_cache_id(r"C:\apps\Case\Case.exe");
        #[cfg(windows)]
        assert_eq!(upper, lower, "Windows paths compare case-insensitively");
        #[cfg(not(windows))]
        assert_ne!(upper, lower);
    }

    #[test]
    fn unpacked_sibling_absent_and_occupied_are_classified_without_links() {
        let base = temp_dir("link-classify-plain");
        let target = base.join("resources").join("app.asar.unpacked");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("native.node"), b"native").unwrap();
        let link = base.join("cache").join("tronhawk-01234567.asar.unpacked");

        // Absent path -> Absent.
        assert_eq!(
            classify_unpacked_link(&link, &target).unwrap(),
            UnpackedLinkState::Absent
        );

        // A real directory occupying the path is NOT a junction -> Occupied.
        std::fs::create_dir_all(&link).unwrap();
        assert_eq!(
            classify_unpacked_link(&link, &target).unwrap(),
            UnpackedLinkState::Occupied
        );
    }

    #[cfg(windows)]
    #[test]
    fn unpacked_sibling_junction_states_are_classified_via_symlink_metadata() {
        let base = temp_dir("link-classify");
        let target = base.join("resources").join("app.asar.unpacked");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("native.node"), b"native").unwrap();
        let link = base.join("cache").join("tronhawk-01234567.asar.unpacked");

        // A stale junction (correct type, wrong target) -> Stale.
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        make_junction(&link, &other);
        assert_eq!(
            classify_unpacked_link(&link, &target).unwrap(),
            UnpackedLinkState::Stale
        );

        // A correct junction -> Linked.
        std::fs::remove_dir_all(&link).unwrap();
        make_junction(&link, &target);
        assert_eq!(
            classify_unpacked_link(&link, &target).unwrap(),
            UnpackedLinkState::Linked
        );

        // A dangling junction (target directory removed) -> Stale (symlink_metadata still sees
        // the reparse point even though `exists()` would report false).
        let gone = base.join("gone");
        std::fs::create_dir_all(&gone).unwrap();
        std::fs::remove_dir_all(&link).unwrap();
        make_junction(&link, &gone);
        std::fs::remove_dir_all(&gone).unwrap();
        assert!(!link.exists(), "dangling junction must not report exists()");
        assert_eq!(
            classify_unpacked_link(&link, &target).unwrap(),
            UnpackedLinkState::Stale
        );
    }

    #[cfg(windows)]
    #[test]
    fn reconcile_creates_replaces_stale_and_rejects_occupied() {
        let base = temp_dir("link-reconcile");
        let real = base.join("resources").join("app.asar.unpacked");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("native.node"), b"native").unwrap();
        let link = base.join("cache").join("tronhawk-89abcdef.asar.unpacked");

        // Absent -> created and usable (files reachable through the junction).
        reconcile_unpacked_link(&link, &real).unwrap();
        assert_eq!(classify_unpacked_link(&link, &real).unwrap(), UnpackedLinkState::Linked);
        assert!(link.join("native.node").is_file());

        // Idempotent second pass: a correct junction is left alone (no error, no rewrite).
        reconcile_unpacked_link(&link, &real).unwrap();
        assert_eq!(classify_unpacked_link(&link, &real).unwrap(), UnpackedLinkState::Linked);

        // A junction pointing at a now-unreachable target is stale; pointing it at a *wrong*
        // existing target must be repaired to the real one.
        let wrong = base.join("wrong");
        std::fs::create_dir_all(&wrong).unwrap();
        std::fs::remove_dir_all(&link).unwrap();
        make_junction(&link, &wrong);
        assert_eq!(classify_unpacked_link(&link, &real).unwrap(), UnpackedLinkState::Stale);
        reconcile_unpacked_link(&link, &real).unwrap();
        assert_eq!(classify_unpacked_link(&link, &real).unwrap(), UnpackedLinkState::Linked);
        // Repairing a junction must never destroy the data of either directory.
        assert!(wrong.is_dir(), "the wrong-target directory must survive");
        assert!(link.join("native.node").is_file());
        assert!(real.join("native.node").is_file());

        // A dangling junction (its target directory removed) is classified stale and reconciled
        // to the real dir (the stale link is removed first, then recreated).
        let gone = base.join("gone");
        std::fs::create_dir_all(&gone).unwrap();
        std::fs::remove_dir_all(&link).unwrap();
        make_junction(&link, &gone);
        std::fs::remove_dir_all(&gone).unwrap();
        assert_eq!(classify_unpacked_link(&link, &real).unwrap(), UnpackedLinkState::Stale);
        reconcile_unpacked_link(&link, &real).unwrap();
        assert_eq!(classify_unpacked_link(&link, &real).unwrap(), UnpackedLinkState::Linked);
        assert!(link.join("native.node").is_file());

        // A non-reparse directory occupant is rejected with a reason, never deleted.
        std::fs::remove_dir_all(&link).unwrap();
        std::fs::create_dir_all(&link).unwrap();
        std::fs::write(link.join("precious.txt"), b"keep").unwrap();
        let error = reconcile_unpacked_link(&link, &real).unwrap_err();
        assert!(
            error.contains("non-junction entry"),
            "unexpected error: {error}"
        );
        assert!(link.join("precious.txt").is_file(), "occupant must survive");
    }

    #[cfg(windows)]
    fn make_junction(link: &Path, target: &Path) {
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let status = Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                link.to_str().unwrap(),
                target.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(
            status.success(),
            "mklink /J {} -> {} failed with {status}",
            link.display(),
            target.display()
        );
    }
}

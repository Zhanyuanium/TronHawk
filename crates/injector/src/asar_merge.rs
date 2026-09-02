//! Build a merged asar: the real app.asar content + an overridden entrypoint, so
//! app.getAppPath()/module resolution serve real files (Path I — fixes apps whose
//! renderer resolves runtime deps from the app path, e.g. Obsidian's @electron/remote).

use std::path::{Path, PathBuf};

/// The entrypoint template, byte-for-byte identical to the minimal stub's template. In the
/// merged asar this becomes `index.js`; the template itself is unchanged and only the
/// surrounding archive content differs.
pub const ENTRY_TEMPLATE: &str =
    r#"require(process.env.MODLOADER_MOD_ENTRYPOINT)(require("path").resolve(__dirname, "../_app.asar"));"#;

/// What `build_merged_asar` produced, for launcher logging / tests.
#[derive(Debug)]
pub struct MergeReport {
    pub source: PathBuf,
    /// Number of entries copied verbatim from the source archive (overrides excluded).
    pub entries: usize,
    pub output_bytes: u64,
}

/// Build a merged asar at `out` from the real `resources/app.asar` at `real_asar`, replacing
/// `index.js` with [`ENTRY_TEMPLATE`] and patching `package.json` so `main` points at it.
///
/// The env var `MODLOADER_MOD_ENTRYPOINT` is set to `mod_entrypoint` (parity with
/// `electron_hook::asar::Asar::with_mod_entrypoint`, whose `create()` performs the same
/// `set_var` for the minimal stub).
pub fn build_merged_asar(
    real_asar: &Path,
    out: &Path,
    mod_entrypoint: &str,
) -> Result<MergeReport, String> {
    let bytes =
        std::fs::read(real_asar).map_err(|e| format!("failed to read {}: {e}", real_asar.display()))?;
    let reader = asar::AsarReader::new(&bytes, Some(real_asar.to_path_buf()))
        .map_err(|e| format!("failed to open asar reader: {e}"))?;
    let mut writer = asar::AsarWriter::new();

    // 1) Copy everything from the real archive EXCEPT the two files we override.
    let mut entries = 0usize;
    for (path, file) in reader.files() {
        if path == Path::new("index.js") || path == Path::new("package.json") {
            continue;
        }
        // NOTE: the `executable` flag of a source entry is not readable from an `AsarFile`, so
        // entries are copied as non-executable. On Windows Chromium ignores the flag for asar
        // require/dlopen, so this is benign. POSIX porting TODO: re-derive the flag.
        writer
            .write_file(path, file.data(), false)
            .map_err(|e| format!("failed to write asar entry {}: {e}", path.display()))?;
        entries += 1;
    }
    for (path, link) in reader.symlinks() {
        writer
            .write_symlink(path, link)
            .map_err(|e| format!("failed to write asar symlink {}: {e}", path.display()))?;
    }

    // 2) Overrides.
    writer
        .write_file("index.js", ENTRY_TEMPLATE.as_bytes(), false)
        .map_err(|e| format!("failed to write index.js: {e}"))?;
    let package_json = patched_package_json(&reader)?.into_bytes();
    writer
        .write_file("package.json", &package_json, false)
        .map_err(|e| format!("failed to write package.json: {e}"))?;

    // 3) Write to the cache path and set the entrypoint env (parity with Asar::with_mod_entrypoint).
    let mut file = std::fs::File::create(out)
        .map_err(|e| format!("failed to create {}: {e}", out.display()))?;
    let output_bytes = writer.finalize(&mut file).map_err(|e| format!("failed to finalize: {e}"))?;
    std::env::set_var("MODLOADER_MOD_ENTRYPOINT", mod_entrypoint);
    Ok(MergeReport {
        source: real_asar.to_path_buf(),
        entries,
        output_bytes: output_bytes as u64,
    })
}

/// Re-serialize the source `package.json` with `main` forced to our entrypoint. Any failure or
/// absence falls back to a minimal `{"main":"index.js"}`. `name`/`productName`/`version` are
/// preserved so Electron derives userData + app.getName from the real app identity.
fn patched_package_json(reader: &asar::AsarReader<'_>) -> Result<String, String> {
    for (path, file) in reader.files() {
        if path == Path::new("package.json") {
            let raw = String::from_utf8_lossy(file.data());
            match serde_json::from_str::<serde_json::Value>(raw.as_ref()) {
                Ok(mut value) => {
                    if let serde_json::Value::Object(map) = &mut value {
                        map.insert("main".into(), serde_json::Value::String("index.js".into()));
                    }
                    return serde_json::to_string(&value)
                        .map_err(|e| format!("re-serialize package.json: {e}"));
                }
                Err(_) => {
                    // Unparseable: fall back to a minimal package.json pointing at our entrypoint.
                    return Ok(r#"{"main":"index.js"}"#.to_string());
                }
            }
        }
    }
    // No package.json in the source: fall back.
    Ok(r#"{"main":"index.js"}"#.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    /// `build_merged_asar` sets a process-global env var, and `std::env::set_var` is not
    /// thread-safe; serialize the tests that touch it.
    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = format!(
            "tronhawk-injector-asar-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    const REMOTE_INDEX: &[u8] = b"module.exports = { ready: true };\n";

    /// A tiny real-world-shaped asar: index.js + package.json (name/main/version) + a runtime
    /// dep under node_modules (Obsidian's @electron/remote) + a symlink.
    fn build_source_asar(dir: &Path) -> PathBuf {
        let asar_path = dir.join("app.asar");
        let mut writer = asar::AsarWriter::new();
        writer
            .write_file("index.js", b"module.exports = 'original index';", false)
            .expect("write index.js");
        writer
            .write_file(
                "package.json",
                br#"{"name":"x","main":"main.js","version":"4.2.0"}"#,
                false,
            )
            .expect("write package.json");
        writer
            .write_file("main.js", b"console.log('main');", false)
            .expect("write main.js");
        writer
            .write_file("node_modules/@electron/remote/index.js", REMOTE_INDEX, false)
            .expect("write remote index.js");
        writer
            .write_symlink("dep-link", "main.js")
            .expect("write symlink");
        let mut file = std::fs::File::create(&asar_path).expect("create app.asar");
        writer.finalize(&mut file).expect("finalize source asar");
        asar_path
    }

    #[test]
    fn merged_asar_preserves_real_files_and_overrides_entrypoint() {
        let _guard = env_lock().lock().unwrap();
        let dir = temp_dir("merged");
        let source = build_source_asar(&dir);
        let out = dir.join("tronhawk.asar");

        let report = build_merged_asar(&source, &out, "C:/bootstrap.js").expect("merge should succeed");
        assert_eq!(report.entries, 2, "main.js + node_modules dep copied; overrides excluded");
        assert_eq!(
            std::fs::metadata(&out).expect("merged asar metadata").len(),
            report.output_bytes
        );

        let bytes = std::fs::read(&out).expect("read merged asar");
        let reader = asar::AsarReader::new(&bytes, None).expect("open merged asar");

        let index = reader
            .files()
            .get(&PathBuf::from("index.js"))
            .expect("index.js present");
        assert_eq!(index.data(), ENTRY_TEMPLATE.as_bytes());

        let pkg: serde_json::Value = serde_json::from_slice(
            reader
                .files()
                .get(&PathBuf::from("package.json"))
                .expect("package.json present")
                .data(),
        )
        .expect("package.json parses");
        assert_eq!(pkg["name"], "x", "name preserved");
        assert_eq!(pkg["version"], "4.2.0", "version preserved");
        assert_eq!(pkg["main"], "index.js", "main overridden to entrypoint");

        let remote = reader
            .files()
            .get(&PathBuf::from("node_modules/@electron/remote/index.js"))
            .expect("runtime dep preserved");
        assert_eq!(remote.data(), REMOTE_INDEX, "runtime dep byte-identical");
        assert_eq!(
            reader
                .files()
                .get(&PathBuf::from("main.js"))
                .expect("main.js preserved")
                .data(),
            b"console.log('main');"
        );

        assert_eq!(
            reader.symlinks().get(&PathBuf::from("dep-link")),
            Some(&PathBuf::from("main.js")),
            "symlink preserved"
        );

        assert_eq!(
            std::env::var("MODLOADER_MOD_ENTRYPOINT").expect("env set"),
            "C:/bootstrap.js"
        );

        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }

    #[test]
    fn missing_source_asar_is_an_error() {
        let dir = temp_dir("missing");
        let err = build_merged_asar(&dir.join("nope.asar"), &dir.join("out.asar"), "b")
            .expect_err("missing source must fail");
        assert!(err.contains("failed to read"), "unexpected error: {err}");
        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }

    #[test]
    fn unparseable_package_json_falls_back() {
        let _guard = env_lock().lock().unwrap();
        let dir = temp_dir("unparseable");
        let source = dir.join("app.asar");
        let mut writer = asar::AsarWriter::new();
        writer
            .write_file("index.js", b"x", false)
            .expect("write index.js");
        writer
            .write_file("package.json", br#"{not json"#, false)
            .expect("write broken package.json");
        let mut file = std::fs::File::create(&source).expect("create source asar");
        writer.finalize(&mut file).expect("finalize source asar");

        let out = dir.join("tronhawk.asar");
        build_merged_asar(&source, &out, "b").expect("merge should succeed");
        let bytes = std::fs::read(&out).expect("read merged asar");
        let reader = asar::AsarReader::new(&bytes, None).expect("open merged asar");
        let pkg = reader
            .files()
            .get(&PathBuf::from("package.json"))
            .expect("package.json present")
            .data();
        assert_eq!(pkg, br#"{"main":"index.js"}"#);
        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }

    #[test]
    fn missing_package_json_falls_back() {
        let _guard = env_lock().lock().unwrap();
        let dir = temp_dir("no-pkg");
        let source = dir.join("app.asar");
        let mut writer = asar::AsarWriter::new();
        writer
            .write_file("index.js", b"x", false)
            .expect("write index.js");
        let mut file = std::fs::File::create(&source).expect("create source asar");
        writer.finalize(&mut file).expect("finalize source asar");

        let out = dir.join("tronhawk.asar");
        build_merged_asar(&source, &out, "b").expect("merge should succeed");
        let bytes = std::fs::read(&out).expect("read merged asar");
        let reader = asar::AsarReader::new(&bytes, None).expect("open merged asar");
        let pkg = reader
            .files()
            .get(&PathBuf::from("package.json"))
            .expect("package.json present")
            .data();
        assert_eq!(pkg, br#"{"main":"index.js"}"#);
        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }

    #[test]
    fn asar_cache_path_is_reachable_via_electron_hook() {
        // The launcher writes the merged asar to electron-hook's asar cache path.
        let path = electron_hook::paths::asar_cache_path("tronhawk");
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
            "tronhawk.asar"
        );
    }
}

//! Build a merged asar: the real app.asar content + an overridden entrypoint, so
//! app.getAppPath()/module resolution serve real files (Path I — fixes apps whose
//! renderer resolves runtime deps from the app path, e.g. Obsidian's @electron/remote).

use std::collections::HashSet;
use std::io::Write;
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
    /// Number of entries copied verbatim from the source archive (overrides and `unpacked`
    /// entries excluded).
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

    // Source entries marked `"unpacked": true` (native modules) must NOT be re-archived: their
    // real bytes live in the sibling `*.asar.unpacked` directory on disk and Electron resolves
    // them from there. The typed `asar` API cannot express unpacked entries (`File::location()`
    // is private and `AsarWriter` always packs), so collect their header nodes (path + size +
    // integrity) from the source header JSON and re-insert them after the archive is written.
    let (source_header, _) = parse_asar(&bytes)?;
    let unpacked = collect_unpacked_entries(&source_header);
    let unpacked_paths: HashSet<PathBuf> = unpacked
        .iter()
        .map(|(components, _)| {
            components
                .iter()
                .fold(PathBuf::new(), |path, name| path.join(name))
        })
        .collect();

    let mut writer = asar::AsarWriter::new();

    // 1) Copy everything from the real archive EXCEPT the two files we override and the unpacked
    //    entries (those are re-added to the header as `unpacked` after finalize).
    let mut entries = 0usize;
    for (path, file) in reader.files() {
        if path == Path::new("index.js") || path == Path::new("package.json") {
            continue;
        }
        if unpacked_paths.contains(path) {
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

    // 3) Finalize into a buffer first. Entry offsets are relative to the payload start, so the
    //    payload can be relocated verbatim when the header is rewritten below.
    let mut intermediate = Vec::new();
    writer
        .finalize(&mut intermediate)
        .map_err(|e| format!("failed to finalize: {e}"))?;

    let output_bytes = if unpacked.is_empty() {
        // Nothing to restore: write the archive exactly as the writer produced it.
        std::fs::write(out, &intermediate)
            .map_err(|e| format!("failed to write {}: {e}", out.display()))?;
        intermediate.len()
    } else {
        // 4) Rewrite the merged header, re-inserting the unpacked source entries so the merged
        //    archive carries the same `unpacked` index as the real one.
        let (mut merged_header, payload_start) = parse_asar(&intermediate)?;
        insert_unpacked_entries(&mut merged_header, &unpacked).map_err(|e| {
            format!("failed to restore unpacked entries in merged asar header: {e}")
        })?;
        let payload = &intermediate[payload_start..];
        write_asar(out, &merged_header, payload)?
    };

    std::env::set_var("MODLOADER_MOD_ENTRYPOINT", mod_entrypoint);
    Ok(MergeReport {
        source: real_asar.to_path_buf(),
        entries,
        output_bytes: output_bytes as u64,
    })
}

/// Parse an asar file's leading region from raw bytes: the 16-byte pickle prefix (matching
/// `asar::Header::read` / `AsarWriter::finalize`) followed by the header JSON.
///
/// Returns the header JSON (the root directory object, whose `files` map holds the archive tree)
/// and the byte offset at which the file payload begins. Entry `offset`s are relative to that
/// payload start, so relocating the header in the file does not invalidate any offsets.
fn parse_asar(bytes: &[u8]) -> Result<(serde_json::Value, usize), String> {
    let head = bytes
        .get(0..16)
        .ok_or_else(|| "asar is too small to contain a header".to_string())?;
    let header_size = u32::from_le_bytes(
        head[4..8]
            .try_into()
            .map_err(|_| "invalid asar header size".to_string())?,
    ) as usize;
    let json_size = u32::from_le_bytes(
        head[12..16]
            .try_into()
            .map_err(|_| "invalid asar header json size".to_string())?,
    ) as usize;
    let json_end = 16usize
        .checked_add(json_size)
        .ok_or_else(|| "asar header json size overflow".to_string())?;
    let json = bytes
        .get(16..json_end)
        .ok_or_else(|| "asar header json extends past the end of the file".to_string())?;
    let header = serde_json::from_slice(json)
        .map_err(|e| format!("failed to parse asar header json: {e}"))?;
    Ok((header, header_size + 8))
}

/// Recursively collect every file entry in the archive whose header object carries
/// `"unpacked": true`, as a list of `(component path, original header node)`.
///
/// The node is kept verbatim so `size`, `integrity`, etc. round-trip byte-for-byte.
fn collect_unpacked_entries(
    header: &serde_json::Value,
) -> Vec<(Vec<String>, serde_json::Value)> {
    let mut entries = Vec::new();
    if let Some(files) = header.get("files").and_then(|v| v.as_object()) {
        collect_unpacked_entries_in(files, &mut Vec::new(), &mut entries);
    }
    entries
}

fn collect_unpacked_entries_in(
    files: &serde_json::Map<String, serde_json::Value>,
    prefix: &mut Vec<String>,
    out: &mut Vec<(Vec<String>, serde_json::Value)>,
) {
    for (name, node) in files {
        if node.get("unpacked").and_then(|v| v.as_bool()) == Some(true) {
            let mut path = prefix.clone();
            path.push(name.clone());
            out.push((path, node.clone()));
        }
        if let Some(child_files) = node.get("files").and_then(|v| v.as_object()) {
            prefix.push(name.clone());
            collect_unpacked_entries_in(child_files, prefix, out);
            prefix.pop();
        }
    }
}

/// Re-insert `entries` into `header`'s root `files` tree as `unpacked` nodes, creating any
/// missing intermediate directory nodes (a directory whose children are all unpacked has no
/// packed counterpart in the merged archive).
fn insert_unpacked_entries(
    header: &mut serde_json::Value,
    entries: &[(Vec<String>, serde_json::Value)],
) -> Result<(), String> {
    let root = header
        .as_object_mut()
        .ok_or_else(|| "asar header is not an object".to_string())?;
    let root_files = root
        .get_mut("files")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "asar header has no root files map".to_string())?;
    for (components, node) in entries {
        insert_into_files(root_files, components, node)?;
    }
    Ok(())
}

fn insert_into_files(
    files: &mut serde_json::Map<String, serde_json::Value>,
    components: &[String],
    node: &serde_json::Value,
) -> Result<(), String> {
    let (head, rest) = components
        .split_first()
        .ok_or_else(|| "cannot insert an unpacked entry with an empty path".to_string())?;
    if rest.is_empty() {
        files.insert(head.clone(), node.clone());
        return Ok(());
    }
    let child = files
        .entry(head.clone())
        .or_insert_with(|| serde_json::json!({ "files": {} }));
    let child_files = child
        .as_object_mut()
        .and_then(|object| object.get_mut("files"))
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| {
            format!("unpacked path component `{head}` collides with a file entry")
        })?;
    insert_into_files(child_files, rest, node)
}

/// Serialize `header` and write a complete asar file: the 16-byte pickle prefix (replicating
/// `AsarWriter::finalize` exactly), the header JSON padded to a 4-byte boundary, then `payload`
/// verbatim. Returns the number of bytes written.
fn write_asar(out: &Path, header: &serde_json::Value, payload: &[u8]) -> Result<usize, String> {
    let mut json = serde_json::to_vec(header)
        .map_err(|e| format!("failed to serialize asar header: {e}"))?;
    let json_size = json.len() as u32;
    let aligned_json_size = json_size + (4 - (json_size % 4)) % 4;
    json.resize(aligned_json_size as usize, 0);

    let mut file = std::fs::File::create(out)
        .map_err(|e| format!("failed to create {}: {e}", out.display()))?;
    let mut written = 0usize;
    for word in [4u32, aligned_json_size + 8, aligned_json_size + 4, json_size] {
        file.write_all(&word.to_le_bytes())
            .map_err(|e| format!("failed to write {}: {e}", out.display()))?;
        written += std::mem::size_of::<u32>();
    }
    file.write_all(&json)
        .map_err(|e| format!("failed to write {}: {e}", out.display()))?;
    written += json.len();
    file.write_all(payload)
        .map_err(|e| format!("failed to write {}: {e}", out.display()))?;
    written += payload.len();
    Ok(written)
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

    /// A 64-char SHA-256 hex digest placeholder, so handcrafted integrity objects round-trip.
    fn dummy_hash() -> String {
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string()
    }

    /// Author a SOURCE asar whose header marks native modules `unpacked: true`. The typed
    /// `asar::AsarWriter` cannot express unpacked entries, so the header is written by hand with
    /// [`super::write_asar`]; the unpacked real bytes must exist next to the archive because
    /// `AsarReader` reads them eagerly from `<asar>.unpacked`.
    fn build_source_asar_with_unpacked(dir: &Path) -> PathBuf {
        let asar_path = dir.join("app.asar");
        let index: &[u8] = b"module.exports = 'original index';";
        let pkg: &[u8] = br#"{"name":"codex","main":"main.js","version":"26.831.21537"}"#;
        let native_len = 4096usize;
        let integrity = serde_json::json!({
            "algorithm": "SHA256",
            "hash": dummy_hash(),
            "blockSize": 4 * 1024 * 1024,
            "blocks": []
        });
        let header = serde_json::json!({
            "files": {
                "index.js": { "size": index.len(), "offset": "0" },
                "package.json": { "size": pkg.len(), "offset": index.len().to_string() },
                "native.node": {
                    "size": native_len,
                    "unpacked": true,
                    "integrity": integrity.clone()
                },
                "node_modules": {
                    "files": {
                        "better-sqlite3": {
                            "files": {
                                "build": {
                                    "files": {
                                        "Release": {
                                            "files": {
                                                "better_sqlite3.node": {
                                                    "size": native_len,
                                                    "unpacked": true,
                                                    "integrity": integrity
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        let mut payload = Vec::new();
        payload.extend_from_slice(index);
        payload.extend_from_slice(pkg);
        write_asar(&asar_path, &header, &payload).expect("write source asar");

        // The eager AsarReader reads unpacked files from disk, so provide real siblings.
        let native_bytes = vec![0xabu8; native_len];
        let unpacked_root = dir.join("app.asar.unpacked");
        std::fs::create_dir_all(
            unpacked_root.join("node_modules/better-sqlite3/build/Release"),
        )
        .expect("create unpacked dirs");
        std::fs::write(unpacked_root.join("native.node"), &native_bytes).expect("write native.node");
        std::fs::write(
            unpacked_root.join("node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
            &native_bytes,
        )
        .expect("write better_sqlite3.node");
        asar_path
    }

    #[test]
    fn merged_asar_preserves_unpacked_native_module_entries() {
        let _guard = env_lock().lock().unwrap();
        let dir = temp_dir("unpacked");
        let source = build_source_asar_with_unpacked(&dir);
        let out = dir.join("tronhawk.asar");

        let report =
            build_merged_asar(&source, &out, "C:/bootstrap.js").expect("merge should succeed");
        assert_eq!(
            report.entries, 0,
            "unpacked native modules are not re-archived (nothing else is copied in this fixture)"
        );
        assert_eq!(
            std::fs::metadata(&out).expect("merged asar metadata").len(),
            report.output_bytes
        );

        let merged = std::fs::read(&out).expect("read merged asar");
        let (header, _) = parse_asar(&merged).expect("parse merged header");

        // A root-level unpacked entry keeps `unpacked: true`, its integrity, and gains no offset.
        let native = &header["files"]["native.node"];
        assert_eq!(
            native.get("unpacked"),
            Some(&serde_json::Value::Bool(true)),
            "native.node must stay unpacked"
        );
        assert!(
            native.get("offset").is_none(),
            "unpacked entry must not carry a payload offset: {native}"
        );
        assert_eq!(native["size"].as_u64(), Some(4096));
        assert_eq!(
            native["integrity"]["algorithm"].as_str(),
            Some("SHA256"),
            "source integrity preserved verbatim"
        );
        assert_eq!(native["integrity"]["hash"].as_str(), Some(dummy_hash().as_str()));

        // Nested unpacked entries survive too, with their intermediate directories recreated.
        let nested = &header["files"]["node_modules"]["files"]["better-sqlite3"]["files"]["build"]
            ["files"]["Release"]["files"]["better_sqlite3.node"];
        assert_eq!(
            nested.get("unpacked"),
            Some(&serde_json::Value::Bool(true)),
            "nested .node entry must stay unpacked"
        );
        assert!(
            nested.get("offset").is_none(),
            "nested unpacked entry must not carry a payload offset"
        );
        assert_eq!(nested["integrity"]["algorithm"].as_str(), Some("SHA256"));

        // The overridden entries are still packed and served from the payload.
        assert!(header["files"]["index.js"].get("offset").is_some());
        assert!(header["files"]["package.json"].get("offset").is_some());

        // The merged archive is still a valid asar readable by the typed API.
        let reader = asar::AsarReader::new(&merged, None).expect("open merged asar");
        assert!(reader.files().contains_key(&PathBuf::from("native.node")));
        assert!(reader.files().contains_key(&PathBuf::from(
            "node_modules/better-sqlite3/build/Release/better_sqlite3.node"
        )));
        assert_eq!(
            reader
                .files()
                .get(&PathBuf::from("index.js"))
                .expect("index.js present")
                .data(),
            ENTRY_TEMPLATE.as_bytes()
        );

        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }
}

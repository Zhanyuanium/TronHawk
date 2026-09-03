//! `.thx` (ZIP) package format mechanics: pack, safe extraction, and manifest schema
//! validation. A support crate for the Core layer — it does NOT make permission decisions,
//! perform install orchestration, or register plugins.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const KNOWN_PERMISSIONS: &[&str] = &[
    "renderer.css",
    "renderer.script",
    "renderer.dom",
    "electron.window",
    "electron.webContents",
    "electron.session",
    "electron.ipc",
    "network.access",
    "network.proxy",
    "runtime.unsafe",
];

/// Maximum `manifest.json` size (bytes) read from a `.thx` archive.
const MAX_MANIFEST_SIZE: u64 = 1024 * 1024;
/// Archive hardening limits.
const MAX_ENTRIES: usize = 1000;
const MAX_SINGLE_FILE: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_SIZE: u64 = 64 * 1024 * 1024;
/// A compressed payload may not expand beyond this multiple of its compressed size (per entry and
/// cumulatively). Combined with the absolute byte caps above this stops a small zip bomb from
/// expanding far beyond a sane ratio even when it stays under the byte caps.
const MAX_COMPRESSION_RATIO: u64 = 100;

/// Current host runtime protocol version, in semver `major.minor.patch` form.
///
/// A plugin's `manifest.json` `tronhawk` field is a semver `VersionReq` over this *runtime
/// protocol* version (not the SDK/npm version). This constant is the single source of truth used
/// by the legacy [`extract`]/[`validate_manifest`] entry points. It mirrors the workspace release
/// version (`0.1.0`) and matches the `^0.1` ranges used by the repository's own plugin fixtures.
///
/// Callers that know a different host version should pass it explicitly via
/// [`extract_for_host`] / [`validate_manifest_schema_for_host`] / [`validate_tronhawk_protocol`]
/// instead of relying on this default; when the host runtime bumps its protocol version, update
/// this constant (and prefer migrating callers to the explicit-version variants).
pub const HOST_PROTOCOL_VERSION: &str = "0.1.0";

/// A parsed plugin manifest and its execution plan (MVP: declared == granted).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub tronhawk: String,
    pub permissions: Vec<String>,
    /// CSS data to inject for `renderer.css` — injected via `insertCSS`, never executed as JS.
    pub css: Option<String>,
    /// Renderer JS source for `renderer.script`/`renderer.dom`.
    pub renderer: Option<String>,
    /// Main-process JS source for `electron.*` capabilities.
    pub main: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    author: String,
    tronhawk: String,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    entry: Option<Entry>,
    #[serde(default)]
    #[allow(dead_code)] // accepted for forward-compat; not processed yet
    config: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    renderer: Option<String>,
    #[serde(default)]
    main: Option<String>,
}

/// Validate a manifest's SCHEMA and semantic rules (no entry-file reads) against the default host
/// protocol version [`HOST_PROTOCOL_VERSION`]. Call this before extracting an archive so that an
/// invalid/unauthorized package never writes to disk.
pub fn validate_manifest_schema(manifest: &serde_json::Value) -> Result<(), String> {
    validate_manifest_schema_for_host(manifest, HOST_PROTOCOL_VERSION)
}

/// Validate a manifest's SCHEMA and semantic rules against an explicit host runtime protocol
/// version. Behaves exactly like [`validate_manifest_schema`] plus the [`tronhawk` protocol gate]
/// (validate_tronhawk_protocol): a plugin whose `tronhawk` range is not satisfied by the host's
/// protocol version is rejected here, i.e. before anything is written to disk or installed.
///
/// `host_version` is provided by the caller (in semver form, e.g. `"0.1.0"`); this crate never
/// hardcodes the host version inside the check itself.
pub fn validate_manifest_schema_for_host(
    manifest: &serde_json::Value,
    host_version: &str,
) -> Result<(), String> {
    // Parse into a strict typed DTO (rejects unknown fields and wrong types).
    let m: Manifest = serde_json::from_value(manifest.clone())
        .map_err(|e| format!("manifest schema: {e}"))?;

    validate_id(&m.id)?;
    if m.name.trim().is_empty() {
        return Err("`name` must not be empty".to_string());
    }
    if m.author.trim().is_empty() {
        return Err("`author` must not be empty".to_string());
    }
    semver::Version::parse(&m.version).map_err(|e| format!("invalid `version`: {e}"))?;
    validate_tronhawk_protocol(host_version, &m.tronhawk)?;

    // Permissions: known + no duplicates.
    let mut seen = std::collections::HashSet::new();
    for p in &m.permissions {
        if !KNOWN_PERMISSIONS.contains(&p.as_str()) {
            return Err(format!("unknown permission `{p}`"));
        }
        if !seen.insert(p.clone()) {
            return Err(format!("duplicate permission `{p}`"));
        }
    }

    // Mutually exclusive CSS sources.
    if m.css.is_some() && m.entry.as_ref().and_then(|e| e.css.as_ref()).is_some() {
        return Err("`css` and `entry.css` are mutually exclusive".to_string());
    }

    // Entry-permission coherence.
    let has_css = m.css.is_some() || m.entry.as_ref().and_then(|e| e.css.as_ref()).is_some();
    if has_css && !m.permissions.iter().any(|p| p == "renderer.css") {
        return Err("a CSS entry requires the `renderer.css` permission".to_string());
    }
    let has_renderer = m.entry.as_ref().and_then(|e| e.renderer.as_ref()).is_some();
    if has_renderer
        && !m
            .permissions
            .iter()
            .any(|p| p == "renderer.script" || p == "renderer.dom")
    {
        return Err("a `renderer` entry requires `renderer.script` or `renderer.dom`".to_string());
    }

    // Entry paths must be safe.
    if let Some(entry) = &m.entry {
        for rel in [
            entry.css.as_ref(),
            entry.renderer.as_ref(),
            entry.main.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            check_entry_path(rel)?;
        }
    }

    Ok(())
}

/// Check that a plugin's declared `tronhawk` protocol range is satisfied by the host runtime's
/// protocol version.
///
/// The `tronhawk` manifest field is the *runtime protocol* version the plugin was built against
/// (e.g. `^0.1`), expressed as a semver `VersionReq`; it is NOT the SDK/npm version. `host_version`
/// is the semver version of the `tronhawk` protocol the host runtime implements and is provided
/// explicitly by the caller (e.g. [`HOST_PROTOCOL_VERSION`]) — never hardcoded here. A well-formed
/// but incompatible range is rejected with a message naming both sides.
pub fn validate_tronhawk_protocol(host_version: &str, tronhawk: &str) -> Result<(), String> {
    let req = semver::VersionReq::parse(tronhawk)
        .map_err(|e| format!("invalid `tronhawk` range: {e}"))?;
    let host = semver::Version::parse(host_version)
        .map_err(|e| format!("invalid host protocol version `{host_version}`: {e}"))?;
    if !req.matches(&host) {
        return Err(format!(
            "plugin requires tronhawk protocol `{tronhawk}` but host protocol is {host_version}"
        ));
    }
    Ok(())
}

fn check_entry_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("entry path must not be empty".to_string());
    }
    let p = Path::new(rel);
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(format!("entry path must be a safe relative path: {rel}"));
        }
    }
    Ok(())
}

/// Validate a plugin ID: a safe identifier, not a filesystem path. Reverse-DNS-style ASCII
/// (lowercase letters, digits, `.`, `-`, `_`), no separators, no empty dot-segments.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("`id` must be 1-128 characters".to_string());
    }
    for c in id.chars() {
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_';
        if !ok {
            return Err(format!("`id` contains invalid character `{c}`"));
        }
    }
    for seg in id.split('.') {
        if seg.is_empty() {
            return Err("`id` must not contain empty dot-segments (e.g. `..`)".to_string());
        }
    }
    Ok(())
}

/// Validate a `manifest.json` value and resolve its entry files against `root`, using the default
/// host protocol version [`HOST_PROTOCOL_VERSION`].
pub fn validate_manifest(manifest: &serde_json::Value, root: &Path) -> Result<Plugin, String> {
    validate_manifest_for_host(manifest, root, HOST_PROTOCOL_VERSION)
}

fn validate_manifest_for_host(
    manifest: &serde_json::Value,
    root: &Path,
    host_version: &str,
) -> Result<Plugin, String> {
    validate_manifest_schema_for_host(manifest, host_version)?;

    let id = require_str(manifest, "id")?.to_string();
    let name = require_str(manifest, "name")?.to_string();
    let version = require_str(manifest, "version")?.to_string();
    let author = require_str(manifest, "author")?.to_string();
    let tronhawk = require_str(manifest, "tronhawk")?.to_string();

    let permissions = manifest
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let css = match manifest.get("css") {
        Some(v) => Some(v.as_str().ok_or("`css` must be a string")?.to_string()),
        None => match manifest.get("entry").and_then(|e| e.get("css")) {
            Some(v) => {
                let rel = v.as_str().ok_or("`entry.css` must be a string")?;
                let p = resolve_within(root, rel)?;
                Some(std::fs::read_to_string(&p).map_err(|e| format!("read css: {e}"))?)
            }
            None => None,
        },
    };

    let renderer = match manifest.get("entry").and_then(|e| e.get("renderer")) {
        Some(v) => {
            let rel = v.as_str().ok_or("`entry.renderer` must be a string")?;
            let p = resolve_within(root, rel)?;
            Some(std::fs::read_to_string(&p).map_err(|e| format!("read renderer: {e}"))?)
        }
        None => None,
    };

    let main = match manifest.get("entry").and_then(|e| e.get("main")) {
        Some(v) => {
            let rel = v.as_str().ok_or("`entry.main` must be a string")?;
            let p = resolve_within(root, rel)?;
            Some(std::fs::read_to_string(&p).map_err(|e| format!("read main: {e}"))?)
        }
        None => None,
    };

    Ok(Plugin {
        id,
        name,
        version,
        author,
        tronhawk,
        permissions,
        css,
        renderer,
        main,
    })
}

/// Load a plugin from an unpacked directory containing `manifest.json`, using the default host
/// protocol version [`HOST_PROTOCOL_VERSION`].
pub fn load_plugin_dir(dir: &Path) -> Result<Plugin, String> {
    load_plugin_dir_for_host(dir, HOST_PROTOCOL_VERSION)
}

fn load_plugin_dir_for_host(dir: &Path, host_version: &str) -> Result<Plugin, String> {
    let root = dir.canonicalize().map_err(|e| format!("plugin dir: {e}"))?;
    let manifest_path = root.join("manifest.json");
    let manifest: serde_json::Value = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}")))?;
    validate_manifest_for_host(&manifest, &root, host_version)
}

/// Pack a plugin directory into a `.thx` (ZIP) archive. Symlinks are refused, entries are
/// sorted, and ZIP names use `/` separators.
pub fn pack(dir: &Path, output: &Path) -> Result<(), String> {
    // Validate the plugin before packing (same schema as install).
    load_plugin_dir(dir).map_err(|e| format!("invalid plugin: {e}"))?;
    let dir_canon = dir.canonicalize().map_err(|e| format!("pack dir: {e}"))?;
    if let Some(parent) = output.parent() {
        if let Ok(parent_canon) = parent.canonicalize() {
            if parent_canon.starts_with(&dir_canon) {
                return Err("output must not be inside the source directory".to_string());
            }
        }
    }

    let mut entries = Vec::new();
    collect_files(&dir_canon, &mut entries)?;
    entries.sort();

    let file = File::create(output).map_err(|e| format!("create thx: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in entries {
        let rel = entry
            .strip_prefix(&dir_canon)
            .map_err(|e| format!("strip prefix: {e}"))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        zip.start_file(&rel_str, options)
            .map_err(|e| format!("zip start: {e}"))?;
        let mut f = File::open(&entry).map_err(|e| format!("open {}: {e}", entry.display()))?;
        std::io::copy(&mut f, &mut zip).map_err(|e| format!("zip copy: {e}"))?;
    }
    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(())
}

/// Extract a `.thx` archive into `dest`, validating the manifest schema (against the default host
/// protocol version [`HOST_PROTOCOL_VERSION`]) *before* any file is written, then performing full
/// validation after extraction. See [`extract_for_host`] to pass an explicit host version.
pub fn extract(thx: &Path, dest: &Path) -> Result<Plugin, String> {
    extract_for_host(thx, dest, HOST_PROTOCOL_VERSION)
}

/// Extract a `.thx` archive into `dest`, validating the manifest schema against an explicit host
/// runtime protocol version. Every rejection (bad schema, incompatible `tronhawk` protocol range,
/// too many/too large entries, unsafe names, zip-bomb ratios) happens in Phase 1 / Phase 1b —
/// before a single byte of the archive is written to `dest` (fail-at-start). Path containment is
/// enforced by [`safe_join`] for every entry in that same phase.
pub fn extract_for_host(thx: &Path, dest: &Path, host_version: &str) -> Result<Plugin, String> {
    // Byte-identical duplicate entry names are rejected before the archive is even parsed: the
    // `zip` reader silently collapses them (last-wins), which would let a hostile archive smuggle
    // ambiguous entries past the per-entry checks below.
    reject_duplicate_archive_entries(thx)?;

    let file = File::open(thx).map_err(|e| format!("open thx: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;

    // Phase 1: read + validate the manifest schema (including the `tronhawk` protocol gate)
    // before writing anything.
    let manifest = read_manifest(&mut archive)?;
    validate_manifest_schema_for_host(&manifest, host_version)?;

    // Phase 1b: enforce archive limits, entry-name hardening, compression-ratio limits, and path
    // containment for EVERY entry before any file is written (fail-at-start). The planned output
    // paths are precomputed here so Phase 2 can never discover a bad name mid-write.
    if archive.len() > MAX_ENTRIES {
        return Err(format!("archive has too many entries ({})", archive.len()));
    }
    let mut planned: Vec<PathBuf> = Vec::with_capacity(archive.len());
    let mut seen_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut total: u64 = 0;
    let mut total_compressed: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let name = entry.name();
        let size = entry.size();
        let compressed = entry.compressed_size();

        // Absolute byte caps (unchanged behavior).
        if size > MAX_SINGLE_FILE {
            return Err(format!("archive entry too large: {name}"));
        }
        total += size;
        if total > MAX_TOTAL_SIZE {
            return Err("archive uncompressed size too large".to_string());
        }

        // Compression-ratio guard: a tiny compressed payload must not expand beyond a sane ratio
        // even while staying under the absolute byte caps above.
        if size > MAX_COMPRESSION_RATIO.saturating_mul(compressed.max(1)) {
            return Err(format!(
                "archive entry `{name}` has a suspicious compression ratio \
                 ({size} bytes uncompressed from {compressed} bytes compressed)"
            ));
        }
        total_compressed += compressed;
        if total_compressed > 0 && total > MAX_COMPRESSION_RATIO.saturating_mul(total_compressed) {
            return Err(format!(
                "archive compression ratio too high \
                 ({total} bytes uncompressed from {total_compressed} bytes compressed)"
            ));
        }

        // Name hardening: duplicates, Windows reserved names, trailing dot/space, ADS syntax.
        let key = validate_archive_entry_name(name)?;
        track_entry_name(&mut seen_names, key, name)?;

        // Path containment (safe_join) — validated here so it fails before any write.
        planned.push(safe_join(dest, name)?);
    }

    // Phase 2: extract all pre-validated entries.
    for (i, out_path) in planned.iter().enumerate() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        if entry.is_dir() {
            std::fs::create_dir_all(out_path).map_err(|e| format!("mkdir: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
            }
            let mut out = File::create(out_path).map_err(|e| format!("create: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract: {e}"))?;
        }
    }

    // Phase 3: full validation (resolves + reads entry files) against the same host version.
    load_plugin_dir_for_host(dest, host_version)
}

// --- helpers ---

/// Scan a `.thx` archive's central directory for byte-identical duplicate entry names and reject
/// them before any parsing/extraction happens. Needed because the `zip` reader silently collapses
/// duplicate names (last-wins) instead of reporting them, so without this scan a duplicate-name
/// archive would pass the per-entry checks below and extract ambiguously.
fn reject_duplicate_archive_entries(thx: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let file = File::open(thx).map_err(|e| format!("open thx: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("thx metadata: {e}"))?
        .len();
    // A ZIP ends with an End-Of-Central-Directory record (22 bytes) plus an optional comment
    // (<= 65535 bytes). Locate it by scanning backwards from the end of the file.
    if len < 22 {
        return Ok(()); // too short to be a real ZIP; let ZipArchive produce the proper error
    }
    let tail_start = len.saturating_sub(22 + 65535);
    let mut file = file;
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|e| format!("thx seek: {e}"))?;
    let tail_len = (len - tail_start) as usize;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| format!("thx read: {e}"))?;

    let mut eocd = None;
    for i in (0..=tail.len() - 22).rev() {
        if &tail[i..i + 4] == b"PK\x05\x06" {
            eocd = Some(i);
            break;
        }
    }
    let eocd = match eocd {
        Some(i) => i,
        None => return Ok(()), // not a parseable ZIP; let ZipArchive report it
    };
    let cd_size = u32::from_le_bytes([tail[eocd + 12], tail[eocd + 13], tail[eocd + 14], tail[eocd + 15]])
        as u64;
    let cd_offset = u32::from_le_bytes([tail[eocd + 16], tail[eocd + 17], tail[eocd + 18], tail[eocd + 19]])
        as u64;
    if cd_offset + cd_size > len {
        return Ok(()); // malformed offsets; let ZipArchive report it
    }

    file.seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("thx seek: {e}"))?;
    let mut cd = vec![0u8; cd_size as usize];
    file.read_exact(&mut cd)
        .map_err(|e| format!("thx read: {e}"))?;

    let mut seen = std::collections::HashSet::new();
    let mut pos = 0usize;
    while pos + 46 <= cd.len() {
        if &cd[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let name_len = u16::from_le_bytes([cd[pos + 28], cd[pos + 29]]) as usize;
        let extra_len = u16::from_le_bytes([cd[pos + 30], cd[pos + 31]]) as usize;
        let comment_len = u16::from_le_bytes([cd[pos + 32], cd[pos + 33]]) as usize;
        let record = 46 + name_len + extra_len + comment_len;
        if pos + record > cd.len() {
            break;
        }
        let name = String::from_utf8_lossy(&cd[pos + 46..pos + 46 + name_len]).into_owned();
        if !seen.insert(name.clone()) {
            return Err(format!("duplicate archive entry: `{name}` appears more than once"));
        }
        pos += record;
    }
    Ok(())
}

fn read_manifest(archive: &mut zip::ZipArchive<File>) -> Result<serde_json::Value, String> {
    let mut idx = None;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| format!("zip entry: {e}"))?
            .name()
            .replace('\\', "/");
        if name == "manifest.json" {
            idx = Some(i);
            break;
        }
    }
    let i = idx.ok_or("archive missing manifest.json")?;
    let mut entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
    if entry.size() > MAX_MANIFEST_SIZE {
        return Err("manifest.json too large".to_string());
    }
    let mut s = String::new();
    entry
        .read_to_string(&mut s)
        .map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}"))
}

fn require_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("manifest missing `{key}`"))
}

fn resolve_within(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(format!("entry path must be relative: {rel}"));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("entry path must not escape the plugin dir: {rel}"));
    }
    let joined = root.join(p);
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("entry path does not resolve: {rel} ({e})"))?;
    if !canon.starts_with(root) {
        return Err(format!("entry path escapes the plugin dir: {rel}"));
    }
    Ok(canon)
}

/// Guard against zip-slip: allow only `Normal` path components. Reject absolute paths,
/// root-relative paths (`\foo`), drive-relative paths (`C:foo`), UNC, and `..`.
fn safe_join(dest: &Path, name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    let p = Path::new(&normalized);
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(format!("archive entry escapes dest: {name}"));
        }
    }
    Ok(dest.join(p))
}

/// Windows-filesystem hardening for a single archive entry name. Rejects, with a clear message:
/// empty names / empty path segments, NTFS alternate-data-stream (`:`) syntax, any path segment
/// ending in `.` or a space (Windows silently trims these, enabling collisions), and Windows
/// reserved device names (see [`is_windows_reserved_name`]).
///
/// On success returns a canonical key used for duplicate detection: separators normalized to `/`,
/// the trailing `/` directory marker removed, and everything lower-cased — mirroring how the name
/// resolves on a Windows case-insensitive filesystem. Collisions are detected by
/// [`track_entry_name`].
fn validate_archive_entry_name(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("archive entry has an empty name".to_string());
    }
    let normalized = name.replace('\\', "/");
    let mut segments: Vec<&str> = normalized.split('/').collect();
    // A trailing separator marks a directory entry; drop it for segment checks and the key.
    if segments.last() == Some(&"") {
        segments.pop();
    }
    if segments.is_empty() {
        return Err(format!("archive entry has an empty name: {name}"));
    }

    let mut key = String::new();
    for (i, seg) in segments.iter().enumerate() {
        if seg.is_empty() {
            return Err(format!("archive entry has an empty path segment: {name}"));
        }
        if seg.contains(':') {
            return Err(format!(
                "archive entry `{name}` uses `:` in a name segment \
                 (NTFS alternate data stream / path syntax is not supported)"
            ));
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err(format!(
                "archive entry `{name}`: path segment `{seg}` ends with '.' or a space \
                 (unsafe on Windows filesystems)"
            ));
        }
        if is_windows_reserved_name(seg) {
            return Err(format!(
                "archive entry `{name}` uses the Windows reserved device name `{seg}`"
            ));
        }
        if i > 0 {
            key.push('/');
        }
        key.push_str(&seg.to_ascii_lowercase());
    }
    Ok(key)
}

/// Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, and
/// `CONIN$`/`CONOUT$`), matched case-insensitively against the base name *before the first `.`* —
/// so `NUL`, `NUL.txt`, `con.log`, and directory segments like `COM1` are all rejected, while a
/// name such as `foo.con` (stem `foo`) is fine. NTFS also maps superscript-digit device names
/// (`COM¹`, `LPT²`, ...) to the plain device names, so those are rejected too.
fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper: Vec<char> = stem.to_ascii_uppercase().chars().collect();
    let mut name: String = upper.iter().collect();
    // Normalize a trailing superscript digit on a COM*/LPT* stem to its ASCII digit.
    if upper.len() == 4 && (upper[..3] == ['C', 'O', 'M'] || upper[..3] == ['L', 'P', 'T']) {
        if let Some(d) = superscript_digit(upper[3]) {
            name = format!("{}{}", upper[..3].iter().collect::<String>(), d);
        }
    }
    matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (name.len() == 4
            && (name.starts_with("COM") || name.starts_with("LPT"))
            && name.as_bytes()[3].is_ascii_digit()
            && name.as_bytes()[3] != b'0')
}

fn superscript_digit(c: char) -> Option<char> {
    match c {
        '¹' => Some('1'),
        '²' => Some('2'),
        '³' => Some('3'),
        '⁴' => Some('4'),
        '⁵' => Some('5'),
        '⁶' => Some('6'),
        '⁷' => Some('7'),
        '⁸' => Some('8'),
        '⁹' => Some('9'),
        _ => None,
    }
}

/// Record one archive entry name into the duplicate-detection set `seen`, whose keys are the
/// canonical case-folded names produced by [`validate_archive_entry_name`]. Rejects byte-identical
/// duplicates ("duplicate archive entry") and names that collide only after case-folding or path
/// normalization ("collides ... on a case-insensitive filesystem"), with a clear message.
fn track_entry_name(
    seen: &mut std::collections::HashMap<String, String>,
    key: String,
    name: &str,
) -> Result<(), String> {
    if let Some(prev) = seen.get(&key) {
        if prev.as_str() == name {
            return Err(format!("duplicate archive entry: `{name}` appears more than once"));
        }
        return Err(format!(
            "archive entry `{name}` collides with `{prev}` on a case-insensitive filesystem"
        ));
    }
    seen.insert(key, name.to_string());
    Ok(())
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("metadata: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("refusing to pack symlink: {}", path.display()));
        }
        if meta.is_dir() {
            collect_files(&path, out)?;
        } else if meta.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_ws() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("tronhawk-pkg-{}-{n}", std::process::id()))
    }

    fn manifest_json(tronhawk: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "com.example.test",
            "name": "Test",
            "version": "1.0.0",
            "author": "A",
            "tronhawk": tronhawk,
            "permissions": []
        })
    }

    fn manifest_bytes(tronhawk: &str) -> Vec<u8> {
        serde_json::to_vec(&manifest_json(tronhawk)).unwrap()
    }

    fn manifest_with_css_bytes() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "id": "com.example.test",
            "name": "Test",
            "version": "1.0.0",
            "author": "A",
            "tronhawk": "^0.1",
            "css": "body{}",
            "permissions": ["renderer.css"]
        }))
        .unwrap()
    }

    /// Build an in-memory ZIP (deflated) from name->content entries.
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, data) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Run `extract` on an archive and assert it fails (before writing anything) with a message
    /// containing `expected`. Returns the error text.
    fn assert_extract_rejects(entries: &[(&str, &[u8])], expected: &str) -> String {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        std::fs::write(&thx, zip_bytes(entries)).unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract(&thx, &dest).unwrap_err();
        assert!(
            err.contains(expected),
            "expected error containing `{expected}` but got: {err}"
        );
        // Fail-at-start: the offending archive must not have written anything into dest.
        let wrote_anything = std::fs::read_dir(&dest).unwrap().next().is_some();
        assert!(!wrote_anything, "dest must stay empty on rejection, got: {err}");
        std::fs::remove_dir_all(&ws).ok();
        err
    }

    /// Minimal STORED ZIP builder used for archives the `zip` writer refuses to create (e.g.
    /// byte-identical duplicate filenames). Computes CRC-32 so the reader can parse the payloads.
    fn raw_zip(names_data: &[(&str, &[u8])]) -> Vec<u8> {
        fn crc32(data: &[u8]) -> u32 {
            let mut table = [0u32; 256];
            for (i, item) in table.iter_mut().enumerate() {
                let mut c = i as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
                }
                *item = c;
            }
            let mut crc = 0xFFFF_FFFFu32;
            for &b in data {
                crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
            }
            !crc
        }
        let mut out = Vec::new();
        let mut entries = Vec::new(); // (local header offset, name, data)
        for &(name, data) in names_data {
            let offset = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04"); // local file header signature
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc32(data).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // compressed size
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // uncompressed size
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra field length
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            entries.push((offset, name, data));
        }
        let cd_start = out.len() as u32;
        for (offset, name, data) in entries {
            out.extend_from_slice(b"PK\x01\x02"); // central directory header signature
            out.extend_from_slice(&20u16.to_le_bytes()); // version made by
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc32(data).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // compressed size
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // uncompressed size
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra field length
            out.extend_from_slice(&0u16.to_le_bytes()); // comment length
            out.extend_from_slice(&0u16.to_le_bytes()); // disk number start
            out.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
            out.extend_from_slice(&0u32.to_le_bytes()); // external attributes
            out.extend_from_slice(&offset.to_le_bytes()); // local header offset
            out.extend_from_slice(name.as_bytes());
        }
        let cd_size = (out.len() as u32) - cd_start;
        out.extend_from_slice(b"PK\x05\x06"); // end of central directory signature
        out.extend_from_slice(&0u16.to_le_bytes()); // this disk
        out.extend_from_slice(&0u16.to_le_bytes()); // central directory disk
        out.extend_from_slice(&(names_data.len() as u16).to_le_bytes()); // entries this disk
        out.extend_from_slice(&(names_data.len() as u16).to_le_bytes()); // total entries
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_start.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment length
        out
    }

    #[test]
    fn pack_extract_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("tronhawk-pkg-{}", std::process::id()));
        let dir = tmp.join("plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"id":"com.example.test","name":"Test","version":"1.0.0","author":"A","tronhawk":"^0.1","css":"body{}","permissions":["renderer.css"]}"#,
        )
        .unwrap();

        let thx = tmp.join("plugin.thx");
        pack(&dir, &thx).unwrap();

        let dest = tmp.join("extracted");
        std::fs::create_dir_all(&dest).unwrap();
        let plugin = extract(&thx, &dest).unwrap();
        assert_eq!(plugin.id, "com.example.test");
        assert!(plugin.css.is_some());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rejects_zip_slip_variants() {
        let dest = Path::new("C:/dest");
        assert!(safe_join(dest, "../evil").is_err());
        assert!(safe_join(dest, "a/../../b").is_err());
        assert!(safe_join(dest, "C:/abs").is_err());
        assert!(safe_join(dest, "\\root-relative").is_err());
        assert!(safe_join(dest, "/root-relative").is_err());
        assert!(safe_join(dest, "C:drive-relative").is_err());
        assert!(safe_join(dest, "//unc/path").is_err());
        assert!(safe_join(dest, "ok/file.txt").is_ok());
    }

    #[test]
    fn rejects_path_traversal_manifest() {
        assert!(resolve_within(Path::new("C:/x"), "../etc/passwd").is_err());
        assert!(resolve_within(Path::new("C:/x"), "C:/etc/passwd").is_err());
    }

    #[test]
    fn rejects_malicious_plugin_id() {
        for bad in ["..", ".", "a/../b", "a\\b", "C:\\x", "a..b", "UPPER", "a b"] {
            let m = serde_json::json!({
                "id": bad,
                "name": "x",
                "version": "1.0.0",
                "author": "a",
                "tronhawk": "^0.1",
                "permissions": []
            });
            assert!(validate_manifest_schema(&m).is_err(), "id `{bad}` should be rejected");
        }
    }

    // --- `tronhawk` protocol gate -------------------------------------------------

    #[test]
    fn protocol_gate_accepts_compatible_range() {
        // Host 0.1.0 satisfies ranges that include 0.1.x.
        for range in ["^0.1", "0.1.0", ">=0.1.0, <0.2.0", "*"] {
            let m = manifest_json(range);
            validate_manifest_schema_for_host(&m, "0.1.0")
                .unwrap_or_else(|e| panic!("`{range}` must be compatible with host 0.1.0: {e}"));
        }
        // The default entry point delegates to HOST_PROTOCOL_VERSION.
        validate_manifest_schema(&manifest_json("^0.1")).unwrap();
        // Direct gate check.
        validate_tronhawk_protocol("0.1.0", "^0.1").unwrap();
    }

    #[test]
    fn protocol_gate_rejects_incompatible_range() {
        // A well-formed-but-incompatible range is rejected with a message naming both sides.
        let m = manifest_json("^2.0");
        let err = validate_manifest_schema_for_host(&m, "1.0.0").unwrap_err();
        assert!(err.contains("`^2.0`"), "message should name the range: {err}");
        assert!(err.contains("1.0.0"), "message should name the host version: {err}");

        // `~0.1.1` means >=0.1.1,<0.2.0 — host 0.1.0 does not satisfy it.
        let m2 = manifest_json("~0.1.1");
        let err2 = validate_manifest_schema_for_host(&m2, "0.1.0").unwrap_err();
        assert!(err2.contains("~0.1.1") && err2.contains("0.1.0"), "{err2}");

        // Direct gate check reports the same mismatch clearly.
        let err3 = validate_tronhawk_protocol("1.0.0", "^2.0").unwrap_err();
        assert!(err3.contains("^2.0") && err3.contains("1.0.0"), "{err3}");
    }

    #[test]
    fn protocol_gate_blocks_extract_before_write() {
        // Default host entry point: `^2.0` plugin vs HOST_PROTOCOL_VERSION (0.1.0) is rejected
        // before anything reaches disk.
        let m = manifest_bytes("^2.0");
        let err = assert_extract_rejects(&[("manifest.json", m.as_slice())], "host protocol is");
        assert!(err.contains("^2.0"), "{err}");

        // Explicit host version threading: a `^0.1` plugin is rejected against host 1.0.0.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        let m2 = manifest_bytes("^0.1");
        std::fs::write(&thx, zip_bytes(&[("manifest.json", m2.as_slice())])).unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err2 = extract_for_host(&thx, &dest, "1.0.0").unwrap_err();
        assert!(
            err2.contains("^0.1") && err2.contains("1.0.0"),
            "explicit host version must be honored: {err2}"
        );
        assert!(std::fs::read_dir(&dest).unwrap().next().is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    // --- Archive hardening --------------------------------------------------------

    #[test]
    fn extract_rejects_duplicate_entry_names() {
        // The `zip` writer refuses to build byte-identical duplicate filenames, so this archive is
        // assembled by hand. `extract`'s central-directory pre-scan must reject it before any
        // parsing or writes reach `dest`.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("dup.thx");
        let m = manifest_bytes("^0.1");
        std::fs::write(
            &thx,
            raw_zip(&[
                ("manifest.json", m.as_slice()),
                ("x.js", b"a"),
                ("x.js", b"b"),
            ]),
        )
        .unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract(&thx, &dest).unwrap_err();
        assert!(
            err.contains("duplicate archive entry") && err.contains("x.js"),
            "expected a clear duplicate-entry message, got: {err}"
        );
        assert!(std::fs::read_dir(&dest).unwrap().next().is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn duplicate_name_tracking_messages() {
        // Unit-level coverage of the duplicate detector's two message branches.
        let mut seen = std::collections::HashMap::new();
        track_entry_name(&mut seen, "x.js".to_string(), "x.js").unwrap();
        let err = track_entry_name(&mut seen, "x.js".to_string(), "x.js").unwrap_err();
        assert!(err.contains("duplicate archive entry"), "{err}");
        track_entry_name(&mut seen, "foo.js".to_string(), "foo.js").unwrap();
        let err2 = track_entry_name(&mut seen, "foo.js".to_string(), "Foo.js").unwrap_err();
        assert!(err2.contains("case-insensitive"), "{err2}");

        // A file `a` and a directory entry `a/` resolve to the same path on disk.
        let mut seen2 = std::collections::HashMap::new();
        track_entry_name(&mut seen2, "a".to_string(), "a").unwrap();
        let err3 = track_entry_name(&mut seen2, "a".to_string(), "a/").unwrap_err();
        assert!(err3.contains("collides"), "{err3}");
    }

    #[test]
    fn extract_rejects_case_folding_collision() {
        let m = manifest_bytes("^0.1");
        let err = assert_extract_rejects(
            &[
                ("manifest.json", m.as_slice()),
                ("Foo.js", b"a"),
                ("foo.js", b"b"),
            ],
            "case-insensitive",
        );
        assert!(err.contains("Foo.js"), "{err}");
        // Nested names that collide only after case-folding are caught too.
        let m2 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[
                ("manifest.json", m2.as_slice()),
                ("src/Util.ts", b"a"),
                ("SRC/util.ts", b"b"),
            ],
            "case-insensitive",
        );
    }

    #[test]
    fn extract_rejects_windows_reserved_names() {
        // With extension (`NUL.txt`), bare (`CON`), lower-case (`con`), and as a directory
        // segment (`COM1/...`) — all rejected.
        let m = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("NUL.txt", b"x")],
            "reserved device name",
        );
        let m2 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m2.as_slice()), ("CON", b"x")],
            "reserved device name",
        );
        let m3 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m3.as_slice()), ("lib/con", b"x")],
            "reserved device name",
        );
        let m4 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m4.as_slice()), ("COM1/data.txt", b"x")],
            "reserved device name",
        );
    }

    #[test]
    fn extract_rejects_trailing_dot_or_space() {
        let m = manifest_bytes("^0.1");
        let err = assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("foo.", b"x")],
            "ends with '.'",
        );
        assert!(err.contains("foo."), "{err}");
        let m2 = manifest_bytes("^0.1");
        let err2 = assert_extract_rejects(
            &[("manifest.json", m2.as_slice()), ("foo ", b"x")],
            "ends with '.' or a space",
        );
        assert!(err2.contains("foo "), "{err2}");
    }

    #[test]
    fn extract_rejects_ntfs_ads_syntax() {
        let m = manifest_bytes("^0.1");
        let err = assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("file:ads", b"x")],
            "alternate data stream",
        );
        assert!(err.contains("file:ads"), "{err}");
    }

    #[test]
    fn extract_rejects_zip_bomb_compression_ratio() {
        // 8 MiB of zeros deflates to a few KiB: well under the 16 MiB single-file and 64 MiB total
        // byte caps, but far beyond the MAX_COMPRESSION_RATIO=100 guard.
        let m = manifest_bytes("^0.1");
        let zeros = vec![0u8; 8 * 1024 * 1024];
        let err = assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("bomb.bin", zeros.as_slice())],
            "compression ratio",
        );
        assert!(err.contains("bomb.bin"), "{err}");
    }

    #[test]
    fn extract_accepts_wellformed_archive() {
        // Positive control: a normal manifest + content archive still extracts.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        let m = manifest_with_css_bytes();
        std::fs::write(
            &thx,
            zip_bytes(&[
                ("manifest.json", m.as_slice()),
                ("lib/main.js", b"console.log('hi')"),
            ]),
        )
        .unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let plugin = extract(&thx, &dest).unwrap();
        assert_eq!(plugin.id, "com.example.test");
        assert_eq!(plugin.css.as_deref(), Some("body{}"));
        assert!(dest.join("lib/main.js").exists());
        std::fs::remove_dir_all(&ws).ok();
    }
}

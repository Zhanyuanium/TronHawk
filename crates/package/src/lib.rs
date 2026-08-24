//! `.thx` (ZIP) package format mechanics: pack, safe extraction, and manifest schema
//! validation. A support crate for the Core layer — it does NOT make permission decisions,
//! perform install orchestration, or register plugins.

use serde::{Deserialize, Serialize};
use std::fs::File;
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
    /// Renderer JS source for `renderer.script`/`renderer.dom` (Phase 2+).
    pub renderer: Option<String>,
}

/// Validate a `manifest.json` value, resolving entry paths against `root`.
/// Strict: required fields fail closed, unknown permissions are rejected.
pub fn validate_manifest(manifest: &serde_json::Value, root: &Path) -> Result<Plugin, String> {
    let id = require_str(manifest, "id")?.to_string();
    let name = require_str(manifest, "name")?.to_string();
    let version = require_str(manifest, "version")?.to_string();
    let author = require_str(manifest, "author")?.to_string();
    let tronhawk = require_str(manifest, "tronhawk")?.to_string();

    let permissions = match manifest.get("permissions") {
        None => Vec::new(),
        Some(v) => {
            let arr = v.as_array().ok_or("`permissions` must be an array")?;
            arr.iter()
                .map(|p| {
                    let s = p.as_str().ok_or("permission entries must be strings")?;
                    if !KNOWN_PERMISSIONS.contains(&s) {
                        return Err(format!("unknown permission `{s}`"));
                    }
                    Ok(s.to_string())
                })
                .collect::<Result<Vec<_>, String>>()?
        }
    };

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

    Ok(Plugin {
        id,
        name,
        version,
        author,
        tronhawk,
        permissions,
        css,
        renderer,
    })
}

/// Load a plugin from an unpacked directory containing `manifest.json`.
pub fn load_plugin_dir(dir: &Path) -> Result<Plugin, String> {
    let root = dir.canonicalize().map_err(|e| format!("plugin dir: {e}"))?;
    let manifest_path = root.join("manifest.json");
    let manifest: serde_json::Value = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}")))?;
    validate_manifest(&manifest, &root)
}

/// Pack a plugin directory into a `.thx` (ZIP) archive.
pub fn pack(dir: &Path, output: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_files(dir, &mut entries)?;

    let file = File::create(output).map_err(|e| format!("create thx: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in entries {
        let rel = entry
            .strip_prefix(dir)
            .map_err(|e| format!("strip prefix: {e}"))?;
        let rel_str = rel.to_str().ok_or("non-UTF8 path")?;
        zip.start_file(rel_str, options)
            .map_err(|e| format!("zip start: {e}"))?;
        let mut f = File::open(&entry).map_err(|e| format!("open {e}"))?;
        std::io::copy(&mut f, &mut zip).map_err(|e| format!("zip copy: {e}"))?;
    }
    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(())
}

/// Extract a `.thx` archive into `dest`, then validate + return the plugin.
pub fn extract(thx: &Path, dest: &Path) -> Result<Plugin, String> {
    let file = File::open(thx).map_err(|e| format!("open thx: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let out_path = safe_join(dest, entry.name())?;
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("mkdir: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
            }
            let mut out = File::create(&out_path).map_err(|e| format!("create: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract: {e}"))?;
        }
    }

    load_plugin_dir(dest)
}

// --- helpers ---

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

/// Guard against zip-slip: reject entries that escape `dest`.
fn safe_join(dest: &Path, name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    let p = Path::new(&normalized);
    if p.is_absolute()
        || p.components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("archive entry escapes dest: {name}"));
    }
    Ok(dest.join(p))
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else if path.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rejects_zip_slip() {
        assert!(safe_join(Path::new("C:/dest"), "../evil").is_err());
        assert!(safe_join(Path::new("C:/dest"), "a/../../b").is_err());
        assert!(safe_join(Path::new("C:/dest"), "C:/abs").is_err());
        assert!(safe_join(Path::new("C:/dest"), "ok/file.txt").is_ok());
    }

    #[test]
    fn rejects_path_traversal_manifest() {
        assert!(resolve_within(Path::new("C:/x"), "../etc/passwd").is_err());
        assert!(resolve_within(Path::new("C:/x"), "C:/etc/passwd").is_err());
    }
}

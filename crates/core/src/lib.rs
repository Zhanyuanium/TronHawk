//! Core orchestration layer: lifecycle, plugin parse/registration, permission checks,
//! IPC, and storage. Must NOT contain UI or depend on Electron internals.
//!
//! Consumes `tronhawk-package` for `.thx` format mechanics and `tronhawk-ipc` for transport.
//! (Phase 1 MVP: loads an unpacked plugin directory — `.thx` packaging lands in Phase 2.)

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

const KNOWN_PERMISSIONS: &[&str] = &[
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

/// A parsed plugin and its execution plan (MVP: declared == granted).
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
    /// Renderer JS source for `renderer.script`/`renderer.dom` (Phase 2).
    pub renderer: Option<String>,
}

/// Load a plugin from a directory containing `manifest.json`.
///
/// Strict parsing: required fields fail closed, unknown permissions are rejected, and any
/// entry file path is validated to stay within the plugin directory.
pub fn load_plugin(dir: &Path) -> Result<Plugin, String> {
    let root = dir.canonicalize().map_err(|e| format!("plugin dir: {e}"))?;
    let manifest_path = root.join("manifest.json");
    let manifest: serde_json::Value = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}")))?;

    // Required fields — fail closed, no defaults.
    let id = require_str(&manifest, "id")?.to_string();
    let name = require_str(&manifest, "name")?.to_string();
    let version = require_str(&manifest, "version")?.to_string();
    let author = require_str(&manifest, "author")?.to_string();
    let tronhawk = require_str(&manifest, "tronhawk")?.to_string();

    // Permissions — must be an array of known strings.
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

    // CSS: inline `css` string, or an `entry.css` file (path-validated).
    let css = match manifest.get("css") {
        Some(v) => Some(v.as_str().ok_or("`css` must be a string")?.to_string()),
        None => match manifest.get("entry").and_then(|e| e.get("css")) {
            Some(v) => {
                let rel = v.as_str().ok_or("`entry.css` must be a string")?;
                let p = resolve_within(&root, rel)?;
                Some(std::fs::read_to_string(&p).map_err(|e| format!("read css: {e}"))?)
            }
            None => None,
        },
    };

    // Renderer JS (Phase 2) — path-validated.
    let renderer = match manifest.get("entry").and_then(|e| e.get("renderer")) {
        Some(v) => {
            let rel = v.as_str().ok_or("`entry.renderer` must be a string")?;
            let p = resolve_within(&root, rel)?;
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

/// Run the Core IPC server, serving `getPlugin` with the given plugin.
/// `secret` is a per-launch token that requests must present.
pub fn serve(port: u16, secret: &str, plugin: Plugin) -> std::io::Result<()> {
    let expected = secret.to_string();
    tronhawk_ipc::serve(port, move |req| {
        if req.version != tronhawk_ipc::PROTOCOL_VERSION {
            return tronhawk_ipc::Response::err(req.id, -32600, "unsupported protocol version");
        }
        if req.secret != expected {
            return tronhawk_ipc::Response::err(req.id, -32001, "unauthorized");
        }
        if req.method == "getPlugin" {
            match serde_json::to_value(&plugin) {
                Ok(result) => tronhawk_ipc::Response::ok(req.id, result),
                Err(e) => tronhawk_ipc::Response::err(req.id, -32603, format!("internal error: {e}")),
            }
        } else {
            tronhawk_ipc::Response::err(req.id, -32601, format!("method not found: {}", req.method))
        }
    })
}

fn require_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("manifest missing `{key}`"))
}

/// Resolve a manifest entry path and verify it stays within `root`.
fn resolve_within(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(format!("entry path must be relative: {rel}"));
    }
    if p.components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("entry path must not escape the plugin dir: {rel}"));
    }
    let joined = root.join(p);
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("entry path does not resolve: {rel} ({e})"))?;
    if !canon.starts_with(&root) {
        return Err(format!("entry path escapes the plugin dir: {rel}"));
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_hello_world_plugin() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/hello-world");
        let plugin = load_plugin(&dir).expect("load plugin");
        assert_eq!(plugin.id, "com.example.hello-world");
        assert!(plugin.permissions.iter().any(|p| p == "renderer.css"));
        assert!(plugin.css.is_some());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(resolve_within(Path::new("C:/x"), "../etc/passwd").is_err());
        assert!(resolve_within(Path::new("C:/x"), "C:/etc/passwd").is_err());
        assert!(resolve_within(Path::new("C:/x"), "a/../../b").is_err());
    }
}

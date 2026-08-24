//! Core orchestration layer: lifecycle, plugin parse/registration, permission checks,
//! IPC, and storage. Must NOT contain UI or depend on Electron internals.
//!
//! Consumes `tronhawk-package` for `.thx` format mechanics and `tronhawk-ipc` for transport.
//! (Phase 1 MVP: loads an unpacked plugin directory — `.thx` packaging lands in Phase 2.)

use serde::{Deserialize, Serialize};

/// A parsed plugin: manifest fields plus the renderer entry source (MVP).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub renderer: Option<String>,
}

/// Load a plugin from a directory containing `manifest.json` and (optionally) its
/// `entry.renderer` source file.
pub fn load_plugin(dir: &std::path::Path) -> Result<Plugin, String> {
    let manifest_path = dir.join("manifest.json");
    let manifest: serde_json::Value = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("failed to read {}: {e}", manifest_path.display()))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}")))?;

    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("manifest missing `id`")?
        .to_string();
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let permissions = manifest
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let renderer = manifest
        .get("entry")
        .and_then(|e| e.get("renderer"))
        .and_then(|v| v.as_str())
        .map(|rel| {
            let p = dir.join(rel);
            std::fs::read_to_string(&p).map_err(|e| format!("failed to read {}: {e}", p.display()))
        })
        .transpose()?;

    Ok(Plugin {
        id,
        name,
        version,
        permissions,
        renderer,
    })
}

/// Run the Core IPC server, serving the `getPlugin` method with the given plugin.
pub fn serve(port: u16, plugin: Plugin) -> std::io::Result<()> {
    tronhawk_ipc::serve(port, move |req| {
        if req.method == "getPlugin" {
            let result = serde_json::to_value(&plugin).unwrap_or(serde_json::Value::Null);
            tronhawk_ipc::Response::ok(req.id, result)
        } else {
            tronhawk_ipc::Response::err(req.id, -32601, format!("method not found: {}", req.method))
        }
    })
}

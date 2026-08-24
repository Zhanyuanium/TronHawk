//! Core orchestration layer: lifecycle, plugin parse/registration, permission checks,
//! IPC, and storage. Must NOT contain UI or depend on Electron internals.
//!
//! Consumes `tronhawk-package` for `.thx` format mechanics and `tronhawk-ipc` for transport.

use std::path::Path;

pub use tronhawk_package::Plugin;

/// Load a plugin from an unpacked directory.
pub fn load_plugin_dir(dir: &Path) -> Result<Plugin, String> {
    tronhawk_package::load_plugin_dir(dir)
}

/// Install a `.thx` package by extracting it under `root` and validating the manifest.
/// (Permission grants from the user are a Phase 4 Manager concern; MVP treats declared
/// permissions as granted.)
pub fn install(thx: &Path, root: &Path) -> Result<Plugin, String> {
    tronhawk_package::extract(thx, root)
}

/// Run the Core IPC server, serving `getPlugin`. `load` is invoked on every request so
/// that hot-reloaded plugin content (e.g. an edited CSS file) is picked up.
/// `secret` is a per-launch token that requests must present.
pub fn serve<F>(port: u16, secret: &str, load: F) -> std::io::Result<()>
where
    F: Fn() -> Result<Plugin, String> + Send + Sync + 'static,
{
    let expected = secret.to_string();
    tronhawk_ipc::serve(port, move |req| {
        if req.version != tronhawk_ipc::PROTOCOL_VERSION {
            return tronhawk_ipc::Response::err(req.id, -32600, "unsupported protocol version");
        }
        if req.secret != expected {
            return tronhawk_ipc::Response::err(req.id, -32001, "unauthorized");
        }
        if req.method == "getPlugin" {
            return match load() {
                Ok(plugin) => match serde_json::to_value(&plugin) {
                    Ok(result) => tronhawk_ipc::Response::ok(req.id, result),
                    Err(e) => {
                        tronhawk_ipc::Response::err(req.id, -32603, format!("internal error: {e}"))
                    }
                },
                Err(e) => {
                    tronhawk_ipc::Response::err(req.id, -32603, format!("internal error: {e}"))
                }
            };
        }
        tronhawk_ipc::Response::err(req.id, -32601, format!("method not found: {}", req.method))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_hello_world_plugin() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/hello-world");
        let plugin = load_plugin_dir(&dir).expect("load plugin");
        assert_eq!(plugin.id, "com.example.hello-world");
        assert!(plugin.permissions.iter().any(|p| p == "renderer.css"));
        assert!(plugin.css.is_some());
    }
}

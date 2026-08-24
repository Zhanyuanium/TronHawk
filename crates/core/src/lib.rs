//! Core orchestration layer: lifecycle, plugin parse/registration, permission checks,
//! IPC, and storage. Must NOT contain UI or depend on Electron internals.
//!
//! Consumes `tronhawk-package` for `.thx` format mechanics and `tronhawk-ipc` for transport.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub use tronhawk_package::Plugin;

/// Granted capabilities for one plugin in the execution plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginGrant {
    pub id: String,
    pub version: String,
    pub granted: Vec<String>,
    pub css: Option<String>,
    pub renderer: Option<String>,
    pub main: Option<String>,
}

/// The execution plan served to the Runtime: a revision + the set of granted plugins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    pub revision: String,
    pub plugins: Vec<PluginGrant>,
}

/// Load a plugin from an unpacked directory.
pub fn load_plugin_dir(dir: &Path) -> Result<Plugin, String> {
    tronhawk_package::load_plugin_dir(dir)
}

/// Install a `.thx` package: validate, extract to a private staging dir, then commit
/// atomically to `root/<id>`. Returns the plugin and its final installed directory.
pub fn install(thx: &Path, root: &Path) -> Result<(Plugin, PathBuf), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("install root: {e}"))?;

    let staging = staging_dir(root);
    let plugin = tronhawk_package::extract(thx, &staging).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        e
    })?;

    let final_dir = root.join(&plugin.id);
    let backup = root.join(format!(".backup-{}", &plugin.id));

    // Remove any stale backup, then move the existing install aside.
    if backup.exists() {
        std::fs::remove_dir_all(&backup).map_err(|e| format!("remove stale backup: {e}"))?;
    }
    if final_dir.exists() {
        std::fs::rename(&final_dir, &backup).map_err(|e| format!("backup old: {e}"))?;
    }

    // Commit staging -> final; rollback to the backup on failure.
    if let Err(e) = std::fs::rename(&staging, &final_dir) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &final_dir);
        }
        return Err(format!("commit install: {e}"));
    }
    if backup.exists() {
        let _ = std::fs::remove_dir_all(&backup);
    }

    Ok((plugin, final_dir))
}

fn staging_dir(root: &Path) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    root.join(format!(".staging-{}-{nanos}", std::process::id()))
}

/// Convert a validated plugin into its execution plan. MVP: declared == granted
/// (developer/test mode); user approval is a Phase 4 Manager concern.
pub fn to_plan(plugin: Plugin) -> ExecutionPlan {
    let grant = PluginGrant {
        id: plugin.id,
        version: plugin.version,
        granted: plugin.permissions,
        css: plugin.css,
        renderer: plugin.renderer,
        main: plugin.main,
    };
    let revision = hash_json(&grant);
    ExecutionPlan {
        revision,
        plugins: vec![grant],
    }
}

/// Load a plugin directory and convert it to an execution plan.
pub fn load_plan(dir: &Path) -> Result<ExecutionPlan, String> {
    load_plugin_dir(dir).map(to_plan)
}

/// A cached execution plan, rebuilt only when the plugin directory's content fingerprint
/// changes. Avoids re-reading and re-validating files on every `getExecutionPlan` request.
pub struct CachedLoader {
    dir: PathBuf,
    cache: Mutex<Option<(String, ExecutionPlan)>>,
}

impl CachedLoader {
    pub fn new(dir: PathBuf) -> Self {
        CachedLoader {
            dir,
            cache: Mutex::new(None),
        }
    }

    pub fn load(&self) -> Result<ExecutionPlan, String> {
        let fp = fingerprint(&self.dir)?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "cache lock poisoned".to_string())?;
        let rebuild = match cache.as_ref() {
            Some((f, _)) => *f != fp,
            None => true,
        };
        if rebuild {
            let plan = load_plan(&self.dir)?;
            *cache = Some((fp, plan));
        }
        Ok(cache.as_ref().unwrap().1.clone())
    }
}

/// A content fingerprint of a plugin directory: sorted `(relpath, size, mtime_ns)` entries.
/// Detects additions, deletions, and content/mtime changes (not just the latest mtime).
fn fingerprint(dir: &Path) -> Result<String, String> {
    let mut entries: Vec<String> = Vec::new();
    collect_fingerprint(dir, "", &mut entries)?;
    entries.sort();
    Ok(hash_bytes(entries.join("\n").as_bytes()))
}

fn collect_fingerprint(dir: &Path, rel: &str, out: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel_path = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if path.is_dir() {
            collect_fingerprint(&path, &rel_path, out)?;
        } else if path.is_file() {
            let meta = std::fs::metadata(&path).map_err(|e| format!("metadata: {e}"))?;
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            out.push(format!("{rel_path}\t{}\t{}", meta.len(), mtime_ns));
        }
    }
    Ok(())
}

/// Stable FNV-1a 64-bit hash (deterministic; unlike `DefaultHasher`, the algorithm is fixed).
fn hash_bytes(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn hash_json<T: Serialize>(v: &T) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    hash_bytes(s.as_bytes())
}

/// Run the Core IPC server, serving `getExecutionPlan`. `load` is invoked on every request so
/// that hot-reloaded plugin content (e.g. an edited CSS file) is picked up.
/// `secret` is a per-launch token that requests must present.
pub fn serve<F>(port: u16, secret: &str, load: F) -> std::io::Result<()>
where
    F: Fn() -> Result<ExecutionPlan, String> + Send + Sync + 'static,
{
    let expected = secret.to_string();
    tronhawk_ipc::serve(port, move |req| {
        if req.version != tronhawk_ipc::PROTOCOL_VERSION {
            return tronhawk_ipc::Response::err(req.id, -32600, "unsupported protocol version");
        }
        if req.secret != expected {
            return tronhawk_ipc::Response::err(req.id, -32001, "unauthorized");
        }
        if req.method == "getExecutionPlan" {
            return match load() {
                Ok(plan) => match serde_json::to_value(&plan) {
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
        let plan = load_plan(&dir).expect("load plan");
        assert_eq!(plan.plugins.len(), 1);
        assert_eq!(plan.plugins[0].id, "com.example.hello-world");
        assert!(plan.plugins[0].granted.iter().any(|p| p == "renderer.css"));
        assert!(plan.plugins[0].css.is_some());
    }

    #[test]
    fn revision_changes_with_css() {
        let p1 = Plugin {
            id: "a".into(),
            name: "a".into(),
            version: "1".into(),
            author: "a".into(),
            tronhawk: "^0.1".into(),
            permissions: vec!["renderer.css".into()],
            css: Some("body{}".into()),
            renderer: None,
            main: None,
        };
        let mut p2 = p1.clone();
        p2.css = Some("body{background:#111}".into());
        assert_ne!(to_plan(p1).revision, to_plan(p2).revision);
    }
}

//! Core orchestration layer: lifecycle, plugin parse/registration, permission checks,
//! IPC, and storage. Must NOT contain UI or depend on Electron internals.
//!
//! Consumes `tronhawk-package` for `.thx` format mechanics and `tronhawk-ipc` for transport.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

mod daemon;
mod log_store;

pub use daemon::{
    application_id_for_executable, default_storage_root, serve_service, ApplicationState,
    CoreService, PluginPolicy,
};

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

/// Manifest metadata for an installed plugin, together with its persisted enabled state.
/// Entry-point source is intentionally omitted from management listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub tronhawk: String,
    pub permissions: Vec<String>,
    pub enabled: bool,
}

const STORE_CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreConfig {
    schema_version: u32,
    #[serde(default)]
    enabled: BTreeMap<String, bool>,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            schema_version: STORE_CONFIG_SCHEMA_VERSION,
            enabled: BTreeMap::new(),
        }
    }
}

/// Management store backed by an explicit install root and JSON configuration path.
///
/// Each immediate, non-hidden directory under `root` is an installed plugin. Plugins without an
/// explicit enabled entry in the current configuration schema are disabled.
#[derive(Debug, Clone)]
pub struct PluginStore {
    root: PathBuf,
    config_path: PathBuf,
}

impl PluginStore {
    pub fn new(root: impl Into<PathBuf>, config_path: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            config_path: config_path.into(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// Scan and validate all installed plugin directories in deterministic ID order.
    pub fn list(&self) -> Result<Vec<InstalledPlugin>, String> {
        let config = self.read_config()?;
        let mut plugins = self.scan_plugins()?;
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(plugins
            .into_iter()
            .map(|plugin| InstalledPlugin {
                enabled: config.enabled.get(&plugin.id).copied().unwrap_or(false),
                id: plugin.id,
                name: plugin.name,
                version: plugin.version,
                author: plugin.author,
                tronhawk: plugin.tronhawk,
                permissions: plugin.permissions,
            })
            .collect())
    }

    /// Install or update a package, rolling the installed directory back if configuration
    /// persistence fails. New plugins are disabled; updates retain an explicit prior state.
    pub fn install(&self, thx: &Path) -> Result<InstalledPlugin, String> {
        let mut config = self.read_config()?;
        std::fs::create_dir_all(&self.root).map_err(|e| format!("install root: {e}"))?;
        let staging = staging_dir(&self.root);
        let plugin = tronhawk_package::extract(thx, &staging).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            e
        })?;
        let final_dir = self.root.join(&plugin.id);
        let backup = transaction_dir(&self.root, "backup", &plugin.id);

        if final_dir.exists() {
            std::fs::rename(&final_dir, &backup).map_err(|e| {
                let _ = std::fs::remove_dir_all(&staging);
                format!("backup old: {e}")
            })?;
        }
        if let Err(e) = std::fs::rename(&staging, &final_dir) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, &final_dir);
            }
            return Err(format!("commit install: {e}"));
        }

        let enabled = config.enabled.get(&plugin.id).copied().unwrap_or(false);
        config.enabled.insert(plugin.id.clone(), enabled);
        if let Err(e) = self.write_config(&config) {
            let _ = std::fs::remove_dir_all(&final_dir);
            if backup.exists() {
                let _ = std::fs::rename(&backup, &final_dir);
            }
            return Err(e);
        }
        if backup.exists() {
            let _ = std::fs::remove_dir_all(backup);
        }

        Ok(installed_metadata(plugin, enabled))
    }

    /// Remove an installed plugin. The visible directory and enabled-state update commit as one
    /// operation; post-commit cleanup of the hidden transaction directory is best-effort.
    pub fn remove(&self, id: &str) -> Result<InstalledPlugin, String> {
        let plugin = self
            .scan_plugins()?
            .into_iter()
            .find(|plugin| plugin.id == id)
            .ok_or_else(|| format!("plugin not installed: {id}"))?;
        let mut config = self.read_config()?;
        let enabled = config.enabled.get(id).copied().unwrap_or(false);
        let removed = installed_metadata(plugin, enabled);
        let final_dir = self.root.join(id);
        let trash = transaction_dir(&self.root, "remove", id);

        std::fs::rename(&final_dir, &trash).map_err(|e| format!("stage remove: {e}"))?;
        config.enabled.remove(id);
        if let Err(e) = self.write_config(&config) {
            let _ = std::fs::rename(&trash, &final_dir);
            return Err(e);
        }
        let _ = std::fs::remove_dir_all(trash);
        Ok(removed)
    }

    /// Persist an installed plugin's enabled state using an atomic JSON replacement.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        if !self.scan_plugins()?.iter().any(|plugin| plugin.id == id) {
            return Err(format!("plugin not installed: {id}"));
        }
        let mut config = self.read_config()?;
        config.enabled.insert(id.to_string(), enabled);
        self.write_config(&config)
    }

    /// Build one deterministic execution plan containing every enabled installed plugin.
    pub fn execution_plan(&self) -> Result<ExecutionPlan, String> {
        let config = self.read_config()?;
        let mut plugins = self.scan_plugins()?;
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        let grants: Vec<_> = plugins
            .into_iter()
            .filter(|plugin| config.enabled.get(&plugin.id).copied().unwrap_or(false))
            .map(plugin_grant)
            .collect();
        Ok(ExecutionPlan {
            revision: hash_json(&grants),
            plugins: grants,
        })
    }

    fn scan_plugins(&self) -> Result<Vec<Plugin>, String> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut plugins = Vec::new();
        for entry in std::fs::read_dir(&self.root).map_err(|e| format!("scan install root: {e}"))? {
            let entry = entry.map_err(|e| format!("scan install entry: {e}"))?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|e| format!("install entry type: {e}"))?;
            if !file_type.is_dir() {
                continue;
            }
            let plugin = load_plugin_dir(&entry.path())
                .map_err(|e| format!("invalid installed plugin {}: {e}", entry.path().display()))?;
            if name.to_string_lossy() != plugin.id {
                return Err(format!(
                    "installed directory `{}` does not match plugin id `{}`",
                    name.to_string_lossy(),
                    plugin.id
                ));
            }
            plugins.push(plugin);
        }
        Ok(plugins)
    }

    fn read_config(&self) -> Result<StoreConfig, String> {
        if !self.config_path.exists() {
            return Ok(StoreConfig::default());
        }
        let json = std::fs::read_to_string(&self.config_path)
            .map_err(|e| format!("read store config: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| format!("invalid store config: {e}"))?;
        match value.get("schemaVersion") {
            // Unversioned state is legacy and may contain unsafe global enables. Discard it.
            None => Ok(StoreConfig::default()),
            Some(version) if version.as_u64() == Some(STORE_CONFIG_SCHEMA_VERSION as u64) => {
                serde_json::from_value(value).map_err(|e| format!("invalid store config: {e}"))
            }
            Some(version) => Err(format!(
                "unsupported store config schema version: {version}"
            )),
        }
    }

    fn write_config(&self, config: &StoreConfig) -> Result<(), String> {
        let parent = self
            .config_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
        let temp = transaction_file(parent, "config");
        let bytes =
            serde_json::to_vec_pretty(config).map_err(|e| format!("serialize config: {e}"))?;
        let mut file = std::fs::File::create(&temp).map_err(|e| format!("create config: {e}"))?;
        use std::io::Write;
        file.write_all(&bytes)
            .map_err(|e| format!("write config: {e}"))?;
        file.sync_all().map_err(|e| format!("sync config: {e}"))?;
        drop(file);

        let backup = transaction_file(parent, "config-backup");
        if self.config_path.exists() {
            std::fs::rename(&self.config_path, &backup)
                .map_err(|e| format!("backup config: {e}"))?;
        }
        if let Err(e) = std::fs::rename(&temp, &self.config_path) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, &self.config_path);
            }
            let _ = std::fs::remove_file(&temp);
            return Err(format!("commit config: {e}"));
        }
        if backup.exists() {
            let _ = std::fs::remove_file(backup);
        }
        Ok(())
    }
}

fn installed_metadata(plugin: Plugin, enabled: bool) -> InstalledPlugin {
    InstalledPlugin {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        author: plugin.author,
        tronhawk: plugin.tronhawk,
        permissions: plugin.permissions,
        enabled,
    }
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

fn transaction_dir(root: &Path, operation: &str, id: &str) -> PathBuf {
    root.join(format!(".{}-{}-{}", operation, id, unique_suffix()))
}

fn transaction_file(parent: &Path, operation: &str) -> PathBuf {
    parent.join(format!(".tronhawk-{operation}-{}", unique_suffix()))
}

fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn plugin_grant(plugin: Plugin) -> PluginGrant {
    PluginGrant {
        id: plugin.id,
        version: plugin.version,
        granted: plugin.permissions,
        css: plugin.css,
        renderer: plugin.renderer,
        main: plugin.main,
    }
}

/// Convert a validated plugin into its execution plan. MVP: declared == granted
/// (developer/test mode); user approval is a Phase 4 Manager concern.
pub fn to_plan(plugin: Plugin) -> ExecutionPlan {
    let grant = plugin_grant(plugin);
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

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("tronhawk-core-{name}-{}", unique_suffix()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_plugin(root: &Path, id: &str, css: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "id": id,
            "name": format!("Plugin {id}"),
            "version": "1.0.0",
            "author": "Test",
            "tronhawk": "^0.1",
            "permissions": ["renderer.css"],
            "css": css
        });
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn pack_plugin(temp: &Path, id: &str) -> PathBuf {
        let source = temp.join("package-source");
        write_plugin(&source, id, "body{}");
        let thx = temp.join("plugin.thx");
        tronhawk_package::pack(&source.join(id), &thx).unwrap();
        thx
    }

    #[test]
    fn loads_hello_world_plugin() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/hello-world");
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

    #[test]
    fn missing_config_denies_all_until_explicitly_enabled() {
        let temp = TempDir::new("multi-plan");
        let root = temp.0.join("plugins");
        write_plugin(&root, "com.example.second", "body{color:blue}");
        write_plugin(&root, "com.example.first", "body{color:red}");
        let store = PluginStore::new(&root, temp.0.join("config/state.json"));

        assert!(store.execution_plan().unwrap().plugins.is_empty());
        store.set_enabled("com.example.first", true).unwrap();
        store.set_enabled("com.example.second", true).unwrap();

        let plan = store.execution_plan().expect("compose plan");

        assert_eq!(plan.plugins.len(), 2);
        assert_eq!(plan.plugins[0].id, "com.example.first");
        assert_eq!(plan.plugins[1].id, "com.example.second");
        assert_eq!(plan.plugins[0].css.as_deref(), Some("body{color:red}"));
        assert_eq!(plan.revision, hash_json(&plan.plugins));
    }

    #[test]
    fn enabled_state_persists_across_store_instances() {
        let temp = TempDir::new("enabled-state");
        let root = temp.0.join("plugins");
        let config = temp.0.join("config/state.json");
        write_plugin(&root, "com.example.one", "body{}");
        write_plugin(&root, "com.example.two", "html{}");

        PluginStore::new(&root, &config)
            .set_enabled("com.example.one", true)
            .expect("enable plugin");

        let reopened = PluginStore::new(&root, &config);
        let listed = reopened.list().expect("list plugins");
        assert!(
            listed
                .iter()
                .find(|p| p.id == "com.example.one")
                .unwrap()
                .enabled
        );
        assert!(
            !listed
                .iter()
                .find(|p| p.id == "com.example.two")
                .unwrap()
                .enabled
        );
        let plan = reopened.execution_plan().expect("load enabled plan");
        assert_eq!(plan.plugins.len(), 1);
        assert_eq!(plan.plugins[0].id, "com.example.one");

        reopened
            .set_enabled("com.example.one", false)
            .expect("disable plugin");
        let reopened_again = PluginStore::new(&root, &config);
        assert!(reopened_again
            .list()
            .unwrap()
            .iter()
            .all(|plugin| !plugin.enabled));
        assert!(reopened_again.execution_plan().unwrap().plugins.is_empty());
    }

    #[test]
    fn new_install_is_disabled_until_explicitly_enabled() {
        let temp = TempDir::new("new-install-deny");
        let root = temp.0.join("plugins");
        let config = temp.0.join("config/state.json");
        let thx = pack_plugin(&temp.0, "com.example.new");
        let store = PluginStore::new(&root, &config);

        let installed = store.install(&thx).expect("install plugin");
        assert!(!installed.enabled);
        assert!(store.execution_plan().unwrap().plugins.is_empty());
        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], 1);
        assert_eq!(persisted["enabled"]["com.example.new"], false);

        store
            .set_enabled("com.example.new", true)
            .expect("enable plugin");
        assert_eq!(store.execution_plan().unwrap().plugins.len(), 1);
    }

    #[test]
    fn legacy_config_discards_enabled_plugins() {
        let temp = TempDir::new("legacy-config");
        let root = temp.0.join("plugins");
        let config = temp.0.join("state.json");
        write_plugin(&root, "com.example.legacy", "body{}");
        write_plugin(&root, "com.example.selected", "html{}");
        std::fs::write(
            &config,
            r#"{"enabled":{"com.example.legacy":true,"com.example.selected":true}}"#,
        )
        .unwrap();
        let store = PluginStore::new(&root, &config);

        assert!(store.execution_plan().unwrap().plugins.is_empty());
        assert!(store.list().unwrap().iter().all(|plugin| !plugin.enabled));
        // A successful write migrates to v1 without carrying legacy enables forward.
        store
            .set_enabled("com.example.selected", true)
            .expect("write current policy");
        let plan = store.execution_plan().unwrap();
        assert_eq!(plan.plugins.len(), 1);
        assert_eq!(plan.plugins[0].id, "com.example.selected");
        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], 1);
        assert!(persisted["enabled"].get("com.example.legacy").is_none());
    }
}

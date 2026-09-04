//! Core orchestration layer: lifecycle, plugin parse/registration, permission checks,
//! IPC, and storage. Must NOT contain UI or depend on Electron internals.
//!
//! Consumes `tronhawk-package` for `.thx` format mechanics and `tronhawk-ipc` for transport.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

mod autostart;
mod daemon;
mod iefo;
mod log_store;
mod storage;

pub use autostart::{autostart_command, is_autostart_arg, AutostartStore, RunKeyAutostart};
pub use daemon::{
    application_id_for_executable, serve_service, ApplicationState, CoreService, PluginPolicy,
};
pub use storage::{
    default_storage_root, is_default_storage_root, legacy_storage_root, migrate_legacy_storage,
    MigrationOutcome,
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
    /// Merged per-plugin config values for this execution-plan snapshot: schema defaults overlaid
    /// with the stored per-application policy config, restricted to schema-declared keys. An
    /// enabled plugin with no config schema carries an empty map.
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
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

/// Path of a hidden transaction directory used while installing/removing a plugin under
/// `root` (for example `.backup-<id>-<pid>-<nanos>`).
fn transaction_dir(root: &Path, operation: &str, id: &str) -> PathBuf {
    root.join(format!(".{}-{}-{}", operation, id, unique_suffix()))
}

/// Path of a hidden transaction file used for atomic replacement in `parent`
/// (for example `.tronhawk-daemon-state-<pid>-<nanos>`).
fn transaction_file(parent: &Path, operation: &str) -> PathBuf {
    parent.join(format!(".tronhawk-{operation}-{}", unique_suffix()))
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
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
        config: BTreeMap::new(),
    }
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

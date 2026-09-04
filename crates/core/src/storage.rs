//! Storage-root resolution and the one-shot legacy migration.
//!
//! The Core storage root default moved from `%LOCALAPPDATA%\TronHawk` (and the matching
//! HOME/temp fallbacks) to `%LOCALAPPDATA%\com.tronhawk.manager\core` so Core's state lives
//! under the Manager's application-data namespace. `TRONHAWK_STORAGE_ROOT` still overrides the
//! default everywhere (the callers resolve it before consulting this module).
//!
//! A first-run Core daemon migrates a pre-existing legacy root into the new default root by a
//! recursive merge copy (files overwrite), then removes the legacy root best-effort. The
//! migration is intentionally NOT gated on "does the new root exist": the injector launcher can
//! pre-create `<new root>\logs\launcher.log` before Core ever runs, and that stub must not block
//! the data move. Only the presence of `<new root>\config\state.json` (i.e. Core already owns
//! the new root) or a missing legacy root skips the migration. Only the default root migrates;
//! a custom `TRONHAWK_STORAGE_ROOT` is never touched.

use std::path::{Path, PathBuf};

/// Directory component under the platform base (LOCALAPPDATA, `~/.local/share`, or temp) that
/// hosts the current default storage root.
pub const DEFAULT_STORAGE_DIR: &str = "com.tronhawk.manager/core";
/// The pre-namespaced default storage directory used before the move.
const LEGACY_STORAGE_DIR: &str = "TronHawk";

/// Platform storage base shared by the current default and the legacy roots: `LOCALAPPDATA`
/// when present, `~/.local/share` when `HOME` is present, and the system temp dir otherwise.
fn storage_base() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local").join("share");
    }
    std::env::temp_dir()
}

/// The current default storage root:
/// `%LOCALAPPDATA%\com.tronhawk.manager\core` (or `~/.local/share/...` / `<temp>/...` on
/// systems without `LOCALAPPDATA`).
pub fn default_storage_root() -> PathBuf {
    storage_base().join(DEFAULT_STORAGE_DIR)
}

/// The legacy, pre-migration storage root under the same platform base as
/// [`default_storage_root`] (e.g. `%LOCALAPPDATA%\TronHawk`).
pub fn legacy_storage_root() -> PathBuf {
    storage_base().join(LEGACY_STORAGE_DIR)
}

/// Whether `root` is the current default storage root. The daemon entrypoint uses this to gate
/// first-run migration and boot-autostart registration: both only make sense for the root the
/// autostart Run entry (which launches Core with no environment overrides) will actually use.
pub fn is_default_storage_root(root: &Path) -> bool {
    root == default_storage_root()
}

/// What a [`migrate_legacy_storage`] call did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// No migration was needed or performed: the legacy root is absent/not a directory, or the
    /// current root already owns `config/state.json` (an earlier run already migrated).
    Skipped,
    /// The legacy root contents were merged into the current root and the legacy root was
    /// removed best-effort.
    Migrated,
}

/// One-shot legacy migration. When `legacy` exists (as a directory) and
/// `current/config/state.json` does not, the legacy tree is merged into the current tree with a
/// recursive copy (existing files are overwritten, directories are created as needed) and then
/// `legacy` is deleted best-effort. A failure to delete the legacy root after a successful copy
/// is reported as a warning, not an error — the data is already safe in the new root.
///
/// Symlinks and other special files are skipped rather than followed (the legacy root never
/// legitimately contains them). Returns an error only when the merge copy itself fails; callers
/// record that as `core.storage.migrate_failed` and continue running.
pub fn migrate_legacy_storage(legacy: &Path, current: &Path) -> Result<MigrationOutcome, String> {
    let legacy_meta = match std::fs::symlink_metadata(legacy) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MigrationOutcome::Skipped);
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect legacy storage root {}: {error}",
                legacy.display()
            ));
        }
    };
    if !legacy_meta.is_dir() {
        return Ok(MigrationOutcome::Skipped);
    }

    // The new root is owned by Core only once its state exists. The launcher may pre-create
    // `logs/launcher.log` (or any other stub) before the first Core run, so `current.exists()`
    // must never be the skip condition.
    if std::fs::symlink_metadata(current.join("config").join("state.json")).is_ok() {
        return Ok(MigrationOutcome::Skipped);
    }

    copy_tree(legacy, current)?;
    // Best-effort removal: the data is already in the new root, so a locked file must not fail
    // the migration — just leave the old root in place and let the next run retry.
    if let Err(error) = std::fs::remove_dir_all(legacy) {
        eprintln!(
            "[core] legacy storage migrated but could not remove {}: {error}",
            legacy.display()
        );
    }
    Ok(MigrationOutcome::Migrated)
}

/// Recursive merge copy: every regular file under `source` is copied under `destination` (files
/// overwrite, directories are created as needed). Symlinks and other non-regular entries are
/// skipped; directory symlinks are never followed, so a reparse loop cannot recurse forever.
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|e| {
        format!(
            "create migration destination {}: {e}",
            destination.display()
        )
    })?;
    for entry in std::fs::read_dir(source)
        .map_err(|e| format!("read legacy storage {}: {e}", source.display()))?
    {
        let entry = entry.map_err(|e| format!("read legacy entry: {e}"))?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("inspect legacy entry {}: {e}", path.display()))?;
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree(&path, &target)?;
        } else if metadata.is_file() {
            std::fs::copy(&path, &target).map_err(|e| {
                format!(
                    "copy legacy file {} -> {}: {e}",
                    path.display(),
                    target.display()
                )
            })?;
        }
        // Symlinks and other special entries are intentionally skipped (see module docs).
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes tests that mutate process-wide environment variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tronhawk-storage-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A fixture legacy storage tree with the content a real pre-migration Core root would hold.
    fn legacy_tree(root: &Path) {
        std::fs::create_dir_all(root.join("config")).unwrap();
        std::fs::write(
            root.join("config").join("state.json"),
            br#"{"schemaVersion":1,"global":{"developerMode":true},"applications":{}}"#,
        )
        .unwrap();
        std::fs::write(root.join("config").join("control.token"), b"a".repeat(64)).unwrap();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs").join("events.jsonl"), b"{}").unwrap();
        std::fs::create_dir_all(
            root.join("plugins")
                .join("installed")
                .join("com.example.one"),
        )
        .unwrap();
        std::fs::write(
            root.join("plugins")
                .join("installed")
                .join("com.example.one")
                .join("renderer.js"),
            b"renderer source",
        )
        .unwrap();
    }

    fn read_state_file(root: &Path) -> serde_json::Value {
        let bytes = std::fs::read(root.join("config").join("state.json")).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn default_storage_root_is_namespaced_under_local_app_data() {
        let _lock = ENV_LOCK.lock().unwrap();
        let base = temp_dir("default-root");
        std::env::set_var("LOCALAPPDATA", &base);
        std::env::remove_var("HOME");
        let default = default_storage_root();
        assert_eq!(default, base.join(DEFAULT_STORAGE_DIR));
        assert_eq!(legacy_storage_root(), base.join(LEGACY_STORAGE_DIR));
        assert!(is_default_storage_root(&default));
        std::env::remove_var("LOCALAPPDATA");
    }

    #[test]
    fn default_storage_root_falls_back_to_home_share_dir() {
        let _lock = ENV_LOCK.lock().unwrap();
        let home = temp_dir("default-home");
        std::env::remove_var("LOCALAPPDATA");
        std::env::set_var("HOME", &home);
        assert_eq!(
            default_storage_root(),
            home.join(".local").join("share").join(DEFAULT_STORAGE_DIR)
        );
        std::env::remove_var("HOME");
    }

    #[test]
    fn migration_copies_legacy_content_into_a_fresh_root() {
        let legacy = temp_dir("migrate-legacy");
        let current = temp_dir("migrate-current");
        legacy_tree(&legacy);

        let outcome = migrate_legacy_storage(&legacy, &current).unwrap();
        assert_eq!(outcome, MigrationOutcome::Migrated);

        assert_eq!(
            read_state_file(&current),
            serde_json::json!({
                "schemaVersion": 1,
                "global": { "developerMode": true },
                "applications": {}
            })
        );
        assert_eq!(
            std::fs::read_to_string(current.join("config").join("control.token")).unwrap(),
            "a".repeat(64)
        );
        assert!(current.join("logs").join("events.jsonl").is_file());
        assert!(current
            .join("plugins")
            .join("installed")
            .join("com.example.one")
            .join("renderer.js")
            .is_file());
        // The legacy root is removed best-effort after a successful copy.
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_preserves_a_launcher_log_stub_in_the_new_root() {
        // The injector launcher writes storage_root()/logs/launcher.log before Core ever runs,
        // so the new root may already exist with a logs stub. Migration must still proceed (it
        // is gated on config/state.json, not on root existence) and must not clobber the stub.
        let legacy = temp_dir("migrate-stub-legacy");
        let current = temp_dir("migrate-stub-current");
        legacy_tree(&legacy);
        std::fs::create_dir_all(current.join("logs")).unwrap();
        std::fs::write(current.join("logs").join("launcher.log"), b"stub line").unwrap();

        let outcome = migrate_legacy_storage(&legacy, &current).unwrap();
        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert_eq!(
            std::fs::read_to_string(current.join("logs").join("launcher.log")).unwrap(),
            "stub line"
        );
        assert!(current.join("logs").join("events.jsonl").is_file());
        assert_eq!(read_state_file(&current)["global"]["developerMode"], true);
        assert!(!legacy.exists());
    }

    #[test]
    fn migration_skips_when_the_new_root_already_has_state() {
        let legacy = temp_dir("migrate-skip-legacy");
        let current = temp_dir("migrate-skip-current");
        legacy_tree(&legacy);
        // The current root already owns state.json — an earlier run already migrated.
        std::fs::create_dir_all(current.join("config")).unwrap();
        std::fs::write(
            current.join("config").join("state.json"),
            br#"{"schemaVersion":1,"global":{"developerMode":false},"applications":{}}"#,
        )
        .unwrap();

        let outcome = migrate_legacy_storage(&legacy, &current).unwrap();
        assert_eq!(outcome, MigrationOutcome::Skipped);
        // The legacy root must be left untouched.
        assert_eq!(read_state_file(&legacy)["global"]["developerMode"], true);
        assert!(legacy.join("plugins").join("installed").is_dir());
        assert_eq!(read_state_file(&current)["global"]["developerMode"], false);
    }

    #[test]
    fn migration_skips_when_no_legacy_root_exists() {
        let legacy = temp_dir("migrate-none-legacy");
        let current = temp_dir("migrate-none-current");
        // Only the new root exists (fresh install): nothing to migrate.
        std::fs::remove_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(current.join("config")).unwrap();
        let outcome = migrate_legacy_storage(&legacy, &current).unwrap();
        assert_eq!(outcome, MigrationOutcome::Skipped);
        assert!(!current.join("config").join("state.json").exists());
    }
}

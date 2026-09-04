//! Long-running TronHawk Core daemon.
//!
//! Command-line arguments are tolerated: the Windows Run entry launches this binary as
//! `<core.exe> /autostart` at logon, so `/autostart` (and `--autostart`) are accepted and
//! ignored. Unknown arguments are warned about but never abort startup.
//!
//! Release builds run as a background service (no console window at logon); debug builds keep
//! the console for development output.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::sync::Arc;

fn main() {
    for argument in std::env::args().skip(1) {
        if tronhawk_core::is_autostart_arg(&argument) {
            continue;
        }
        eprintln!("[core] ignoring unexpected argument: {argument}");
    }

    let port: u16 = std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(17777);
    let root = std::env::var_os("TRONHAWK_STORAGE_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(tronhawk_core::default_storage_root);

    // One-shot legacy-storage migration. Only the default root migrates (a custom
    // TRONHAWK_STORAGE_ROOT is a deliberately separate namespace). The migration must run
    // before CoreService::new reads config/state.json so developer mode / config state are read
    // from the migrated location; a failure only records an event and never crashes startup.
    let mut migration_error: Option<String> = None;
    if tronhawk_core::is_default_storage_root(&root) {
        match tronhawk_core::migrate_legacy_storage(&tronhawk_core::legacy_storage_root(), &root) {
            Ok(tronhawk_core::MigrationOutcome::Migrated) => {
                println!("[core] migrated legacy storage into {}", root.display());
            }
            Ok(tronhawk_core::MigrationOutcome::Skipped) => {}
            Err(error) => migration_error = Some(error),
        }
    }

    let service = match tronhawk_core::CoreService::new(root.clone()) {
        Ok(service) => Arc::new(service),
        Err(error) => {
            eprintln!("[core] failed to initialize storage: {error}");
            std::process::exit(1);
        }
    };

    if let Some(error) = migration_error {
        let message = format!(
            "failed to migrate legacy storage into {}: {error}",
            root.display()
        );
        service.record_startup_event("core.storage.migrate_failed", &message);
        eprintln!("[core] {message}");
    }

    // Boot autostart registration (preference default on; idempotent; failures are logged as
    // core events). Only meaningful on the default root — the root the Run entry launches.
    if tronhawk_core::is_default_storage_root(&root) {
        service.ensure_core_autostart_registered();
    }

    println!("[core] listening on 127.0.0.1:{port}");
    if let Err(error) = tronhawk_core::serve_service(port, service) {
        eprintln!("[core] server error: {error}");
        std::process::exit(1);
    }
}

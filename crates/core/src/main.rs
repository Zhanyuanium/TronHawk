//! Long-running TronHawk Core daemon.

use std::sync::Arc;

fn main() {
    let port: u16 = std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(17777);
    let root = std::env::var_os("TRONHAWK_STORAGE_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(tronhawk_core::default_storage_root);
    let service = match tronhawk_core::CoreService::new(root) {
        Ok(service) => Arc::new(service),
        Err(error) => {
            eprintln!("[core] failed to initialize storage: {error}");
            std::process::exit(1);
        }
    };

    println!("[core] listening on 127.0.0.1:{port}");
    if let Err(error) = tronhawk_core::serve_service(port, service) {
        eprintln!("[core] server error: {error}");
        std::process::exit(1);
    }
}

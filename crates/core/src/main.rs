//! TronHawk Core daemon (MVP): loads a plugin (from a `.thx` package or an unpacked
//! directory) and serves its execution plan over IPC, using a cached snapshot for hot reload.
//!
//! Usage: tronhawk-core [<plugin.thx | plugin-dir>]
//! `TRONHAWK_IPC_PORT` (default 17777) and `TRONHAWK_IPC_SECRET` (required) configure the
//! listener. The secret is a per-launch token shared with the launcher/target.

use std::path::{Path, PathBuf};
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = args.get(1).map(String::as_str).unwrap_or("plugins/hello-world");
    let port: u16 = std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(17777);
    let secret = match std::env::var("TRONHAWK_IPC_SECRET") {
        Ok(s) => s,
        Err(_) => {
            eprintln!("TRONHAWK_IPC_SECRET is required");
            std::process::exit(1);
        }
    };

    let input_path = Path::new(input);
    let is_thx = input_path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("thx"))
        .unwrap_or(false);

    // Resolve the plugin dir once (install .thx, or use the dir directly).
    let plugin_dir: PathBuf = if is_thx {
        let root = std::env::temp_dir().join("tronhawk-installed");
        match tronhawk_core::install(input_path, &root) {
            Ok((_, dir)) => dir,
            Err(e) => {
                eprintln!("[core] failed to install plugin: {e}");
                std::process::exit(1);
            }
        }
    } else {
        input_path.to_path_buf()
    };

    let loader = Arc::new(tronhawk_core::CachedLoader::new(plugin_dir));
    let load = {
        let loader = Arc::clone(&loader);
        move || loader.load()
    };

    match load() {
        Ok(plan) => {
            for p in &plan.plugins {
                println!(
                    "[core] loaded plugin {} v{} (granted: {:?})",
                    p.id, p.version, p.granted
                );
            }
        }
        Err(e) => {
            eprintln!("[core] failed to load plugin: {e}");
            std::process::exit(1);
        }
    }
    println!("[core] listening on 127.0.0.1:{port}");

    if let Err(e) = tronhawk_core::serve(port, &secret, load) {
        eprintln!("[core] server error: {e}");
        std::process::exit(1);
    }
}

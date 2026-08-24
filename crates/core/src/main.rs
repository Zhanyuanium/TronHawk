//! TronHawk Core daemon (MVP): loads a plugin (from a `.thx` package or an unpacked
//! directory) and serves it over IPC, re-reading the plugin on each request for hot reload.
//!
//! Usage: tronhawk-core [<plugin.thx | plugin-dir>]
//! `TRONHAWK_IPC_PORT` (default 17777) and `TRONHAWK_IPC_SECRET` (required) configure the
//! listener. The secret is a per-launch token shared with the launcher/target.

use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = args.get(1).map(String::as_str).unwrap_or("plugins/hello-world");
    let port: u16 = std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(17777);
    let secret = std::env::var("TRONHAWK_IPC_SECRET").expect("TRONHAWK_IPC_SECRET is required");

    let input_path = Path::new(input);
    let is_thx = input_path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("thx"))
        .unwrap_or(false);

    // Resolve the plugin dir once (install .thx, or use the dir directly).
    let plugin_dir: PathBuf = if is_thx {
        let root = std::env::temp_dir().join("tronhawk-installed");
        let (_, dir) = tronhawk_core::install(input_path, &root).expect("failed to install plugin");
        dir
    } else {
        input_path.to_path_buf()
    };

    // Re-read the plugin on every request (hot reload).
    let load = move || tronhawk_core::load_plugin_dir(&plugin_dir);

    match load() {
        Ok(p) => println!(
            "[core] loaded plugin {} v{} (permissions: {:?})",
            p.id, p.version, p.permissions
        ),
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

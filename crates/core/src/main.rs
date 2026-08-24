//! TronHawk Core daemon (MVP): loads the hello-world plugin and serves it over IPC.
//!
//! Usage: tronhawk-core [plugin-dir]
//! Port is read from `TRONHAWK_IPC_PORT` (default 17777).

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let plugin_dir = args.get(1).map(String::as_str).unwrap_or("plugins/hello-world");
    let port: u16 = std::env::var("TRONHAWK_IPC_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(17777);

    let plugin = tronhawk_core::load_plugin(std::path::Path::new(plugin_dir))
        .expect("failed to load plugin");
    println!(
        "[core] loaded plugin {} v{} (permissions: {:?})",
        plugin.id, plugin.version, plugin.permissions
    );
    println!("[core] listening on 127.0.0.1:{port}");

    if let Err(e) = tronhawk_core::serve(port, plugin) {
        eprintln!("[core] server error: {e}");
        std::process::exit(1);
    }
}

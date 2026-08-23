//! PoC launcher: builds a modded ASAR and launches a packaged Electron app through
//! electron-hook's Detours injection.
//!
//! Usage: tronhawk-injector-launcher <electron_exe> <dll_path> <bootstrap.js>

use electron_hook::asar::Asar;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!(
            "usage: {} <electron_exe> <dll_path> <bootstrap.js>",
            args[0]
        );
        std::process::exit(2);
    }

    let electron_exe = &args[1];
    let dll_path = &args[2];
    let bootstrap = &args[3];

    // Build a minimal ASAR whose `index.js` runs in the target's main process and loads
    // our bootstrap via `require(process.env.MODLOADER_MOD_ENTRYPOINT)`.
    let asar = Asar::new()
        .with_id("tronhawk-poc")
        .with_template("require(process.env.MODLOADER_MOD_ENTRYPOINT);")
        .with_mod_entrypoint(bootstrap)
        .create()
        .expect("failed to create modded asar");

    println!("[launcher] modded asar: {}", asar.display());
    println!("[launcher] electron exe: {electron_exe}");
    println!("[launcher] dll: {dll_path}");
    println!("[launcher] bootstrap: {bootstrap}");

    electron_hook::launch(electron_exe, dll_path, asar.to_str().unwrap(), vec![], true)
        .expect("electron_hook::launch failed");

    println!("[launcher] launched {electron_exe}");
}

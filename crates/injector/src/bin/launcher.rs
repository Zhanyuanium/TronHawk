//! TronHawk injector launcher.
//!
//! Usage:
//!   tronhawk-injector-launcher <target-exe> [target-args...]   # inject + launch
//!   tronhawk-injector-launcher register <target-exe>           # register IFEO (elevated)
//!   tronhawk-injector-launcher unregister <target-exe>         # unregister IFEO (elevated)
//!
//! The injector DLL and bootstrap are resolved relative to the launcher's own location,
//! so the three artifacts (`launcher.exe`, `tronhawk_injector.dll`, `bootstrap.js`) are
//! deployed side by side.

use std::path::PathBuf;

use electron_hook::asar::Asar;

const DLL_NAME: &str = "tronhawk_injector.dll";
const BOOTSTRAP_NAME: &str = "bootstrap.js";

fn launcher_dir() -> PathBuf {
    std::env::current_exe()
        .expect("failed to resolve launcher path")
        .parent()
        .expect("launcher has no parent dir")
        .to_path_buf()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: tronhawk-injector-launcher <target-exe> [target-args...]");
        eprintln!("       tronhawk-injector-launcher register <target-exe>");
        eprintln!("       tronhawk-injector-launcher unregister <target-exe>");
        std::process::exit(2);
    }

    match args[0].as_str() {
        "register" => {
            let target = require_arg(&args, 1, "register <target-exe>");
            #[cfg(windows)]
            {
                if let Err(e) = tronhawk_injector::registry::register(target) {
                    eprintln!("[launcher] register failed: {e}");
                    std::process::exit(1);
                }
            }
            println!("[launcher] registered IFEO for {target}");
        }
        "unregister" => {
            let target = require_arg(&args, 1, "unregister <target-exe>");
            #[cfg(windows)]
            {
                if let Err(e) = tronhawk_injector::registry::unregister(target) {
                    eprintln!("[launcher] unregister failed: {e}");
                    std::process::exit(1);
                }
            }
            println!("[launcher] unregistered IFEO for {target}");
        }
        target => {
            if let Err(error) = launch(target, &args[1..]) {
                eprintln!("[launcher] launch failed: {error}");
                std::process::exit(1);
            }
        }
    }
}

fn require_arg<'a>(args: &'a [String], idx: usize, usage: &str) -> &'a str {
    match args.get(idx) {
        Some(v) => v.as_str(),
        None => {
            eprintln!("usage: {usage}");
            std::process::exit(2);
        }
    }
}

fn launch(target_exe: &str, target_args: &[String]) -> Result<(), String> {
    let dir = launcher_dir();
    let dll = dir.join(DLL_NAME);
    let bootstrap = dir.join(BOOTSTRAP_NAME);

    if !dll.exists() {
        return Err(format!("injector dll not found: {}", dll.display()));
    }
    if !bootstrap.exists() {
        return Err(format!("bootstrap not found: {}", bootstrap.display()));
    }

    let asar = Asar::new()
        .with_id("tronhawk")
        .with_template(
            r#"require(process.env.MODLOADER_MOD_ENTRYPOINT)(require("path").resolve(__dirname, "../_app.asar"));"#,
        )
        .with_mod_entrypoint(bootstrap.to_str().unwrap())
        .create()
        .map_err(|error| format!("failed to create modded asar: {error:?}"))?;

    println!("[launcher] asar: {}", asar.display());
    println!("[launcher] dll: {}", dll.display());
    println!("[launcher] bootstrap: {}", bootstrap.display());

    let port = tronhawk_injector::launch_session::ipc_port();
    let control_token = tronhawk_injector::launch_session::read_control_token()?;
    tronhawk_injector::launch_session::with_launch_session(
        port,
        target_exe,
        &control_token,
        || {
            electron_hook::launch(
                target_exe,
                dll.to_str().unwrap(),
                asar.to_str().unwrap(),
                target_args.to_vec(),
                true,
            )
        },
    )?
    .map_err(|error| format!("electron_hook::launch failed: {error:?}"))?;

    println!("[launcher] launched {target_exe}");
    Ok(())
}

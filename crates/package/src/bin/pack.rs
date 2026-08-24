//! Pack a plugin directory into a `.thx` archive (developer tool).
//! Usage: pack <plugin-dir> <output.thx>

use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: {} <plugin-dir> <output.thx>", args[0]);
        std::process::exit(2);
    }
    let dir = Path::new(&args[1]);
    let out = Path::new(&args[2]);
    tronhawk_package::pack(dir, out).expect("pack failed");
    println!("packed {} -> {}", dir.display(), out.display());
}

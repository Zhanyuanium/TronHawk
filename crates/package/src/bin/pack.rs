//! Authoritative TronHawk `.thx` engine: `validate` / `pack` / `inspect`.
//!
//! Exit codes (stable contract for the `@tronhawk/cli` caller):
//! - `0` success (validation passed, pack wrote + round-tripped, inspect reported).
//! - `1` authoritative rejection or operation failure (invalid plugin, incompatible
//!   `tronhawk` protocol range, corrupt/unsafe archive, round-trip failure, IO failure
//!   inside the operation). The message on stderr names the cause.
//! - `2` CLI usage error (unknown subcommand/flag, missing argument, malformed
//!   `--host-version`). The message on stderr names the correct usage.
//!
//! Subcommands:
//! - `validate <plugin-dir> [--host-version <ver>] [--json]`
//! - `pack <plugin-dir> <output.thx> [--host-version <ver>] [--json]`
//! - `inspect <file.thx> [--host-version <ver>] [--json]`
//! - `--version` / `-V` (with `--json` for machine-readable output)
//! - `--help` / `-h`, `help`, `help <subcommand>`
//!
//! Legacy (deprecated, still accepted): `pack <plugin-dir> <output.thx>` with no subcommand,
//! equivalent to `pack pack <plugin-dir> <output.thx>`.
//!
//! `--host-version` selects the host runtime protocol version the operation validates
//! against (semver, e.g. `0.1.1`). When omitted, [`tronhawk_package::HOST_PROTOCOL_VERSION`]
//! is used. The crate never guesses the host version.

use std::path::{Path, PathBuf};

const EXIT_OK: i32 = 0;
const EXIT_REJECT: i32 = 1;
const EXIT_USAGE: i32 = 2;

fn bin_name() -> String {
    std::env::args()
        .next()
        .as_deref()
        .map(|a| {
            Path::new(a)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(a)
                .to_string()
        })
        .unwrap_or_else(|| "tronhawk-pack".to_string())
}

fn usage(b: &str) -> String {
    format!(
        "usage:\n  {b} validate <plugin-dir> [--host-version <ver>] [--json]\n  {b} pack <plugin-dir> <output.thx> [--host-version <ver>] [--json]\n  {b} inspect <file.thx> [--host-version <ver>] [--json]\n  {b} --version [--json]\n  {b} --help | -h | help [<subcommand>]"
    )
}

fn help_text(b: &str) -> String {
    format!(
        "tronhawk-pack — authoritative TronHawk `.thx` engine (Rust)\n\n{}\n\n\
        exit codes:\n  0  success\n  1  authoritative rejection / operation failure (invalid plugin, protocol mismatch, unsafe archive, round-trip failure)\n  2  usage error (unknown subcommand/flag, missing argument)\n\n\
        validate: check a plugin directory (manifest schema + `tronhawk` protocol gate + entry files resolve).\n  JS is never executed; nothing is written.\npack: validate, ZIP every file (sorted, `/` names), enforce the extract-side archive rules on inputs,\n  write to a temp file, round-trip through the same crate (`extract_for_host`), then atomically rename.\ninspect: list archive entries + `manifest.json` and validate them (schema + protocol + hardening) without extracting.\n\n\
        --host-version <ver>  explicit host runtime protocol version (default: {}).\n--json                machine-readable JSON on stdout (errors still go to stderr).\n\n\
        legacy: `{b} <plugin-dir> <output.thx>` is accepted as `pack <plugin-dir> <output.thx>` (deprecated).",
        usage(b),
        tronhawk_package::HOST_PROTOCOL_VERSION
    )
}

fn sub_help(sub: &str, b: &str) -> String {
    match sub {
        "validate" => format!(
            "usage: {b} validate <plugin-dir> [--host-version <ver>] [--json]\n\nValidate a plugin directory against the host protocol (default {}). Exits 0 when valid, 1 with the cause on stderr when invalid.",
            tronhawk_package::HOST_PROTOCOL_VERSION
        ),
        "pack" => format!(
            "usage: {b} pack <plugin-dir> <output.thx> [--host-version <ver>] [--json]\n\nPack a plugin directory into `.thx` (temp file + same-crate round-trip + atomic rename). Exits 0 on success, 1 with the cause on stderr on failure."
        ),
        "inspect" => format!(
            "usage: {b} inspect <file.thx> [--host-version <ver>] [--json]\n\nInspect a `.thx` archive without extracting it. Exits 0 when the archive validates, 1 with the cause on stderr when it does not."
        ),
        _ => format!("unknown help topic `{sub}`.\n\n{}", usage(b)),
    }
}

fn print_version_json() {
    let report = serde_json::json!({
        "name": "tronhawk-pack",
        "version": tronhawk_package::engine_version(),
        "host_protocol": tronhawk_package::HOST_PROTOCOL_VERSION,
    });
    println!("{}", serde_json::to_string(&report).unwrap_or_default());
}

fn print_version_human() {
    println!("tronhawk-pack {}", tronhawk_package::engine_version());
    println!("host-protocol {}", tronhawk_package::HOST_PROTOCOL_VERSION);
}

struct GlobalOpts {
    host_version: Option<String>,
    json: bool,
}

/// Split `args` (without argv[0] and without the subcommand) into positional operands and
/// global flags (`--host-version <ver>`, `--json`, `--help/-h`). Unknown `--` flags are an
/// error; single-dash flags other than `-h` are an error.
fn parse_flags(b: &str, args: &[String]) -> Result<(GlobalOpts, Vec<String>), String> {
    let mut host_version: Option<String> = None;
    let mut json = false;
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--json" {
            json = true;
        } else if a == "--host-version" {
            let v = args.get(i + 1).ok_or_else(|| {
                format!("`--host-version` requires a value.\n\n{}", usage(b))
            })?;
            if v.starts_with('-') {
                return Err(format!("`--host-version` requires a value.\n\n{}", usage(b)));
            }
            host_version = Some(v.clone());
            i += 1;
        } else if let Some(v) = a.strip_prefix("--host-version=") {
            if v.is_empty() {
                return Err(format!("`--host-version` requires a value.\n\n{}", usage(b)));
            }
            host_version = Some(v.to_string());
        } else if a == "--help" || a == "-h" {
            // Handled by the caller via help detection; keep it positional-neutral by
            // treating it as a help request marker.
            positional.push(a.clone());
        } else if a.starts_with("--") || (a.starts_with('-') && a.len() > 1) {
            return Err(format!("unknown option: `{a}`.\n\n{}", usage(b)));
        } else {
            positional.push(a.clone());
        }
        i += 1;
    }
    Ok((GlobalOpts { host_version, json }, positional))
}

fn wants_help(positional: &[String]) -> bool {
    positional.iter().any(|a| a == "--help" || a == "-h")
}

fn resolve_host_version(opt: Option<String>) -> Result<String, String> {
    match opt {
        Some(v) => {
            // Fail fast on a malformed host version as a *usage* error (exit 2) rather than
            // an authoritative rejection, so callers can distinguish "bad flag" from "bad plugin".
            semver::Version::parse(&v)
                .map(|_| v.clone())
                .map_err(|e| format!("invalid `--host-version` `{v}`: {e}"))
        }
        None => Ok(tronhawk_package::HOST_PROTOCOL_VERSION.to_string()),
    }
}

fn cmd_validate(dir: &Path, host_version: &str, json: bool) -> i32 {
    match tronhawk_package::load_plugin_dir_for_host(dir, host_version) {
        Ok(plugin) => {
            if json {
                let report = serde_json::json!({
                    "ok": true,
                    "command": "validate",
                    "id": plugin.id,
                    "version": plugin.version,
                    "host_protocol": host_version,
                    "engine_version": tronhawk_package::engine_version(),
                });
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            } else {
                println!("ok {} {} (host-protocol {})", plugin.id, plugin.version, host_version);
            }
            EXIT_OK
        }
        Err(e) => {
            if json {
                let report = serde_json::json!({
                    "ok": false,
                    "command": "validate",
                    "error": e,
                    "host_protocol": host_version,
                    "engine_version": tronhawk_package::engine_version(),
                });
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            }
            eprintln!("validate failed: {e}");
            EXIT_REJECT
        }
    }
}

fn cmd_pack(dir: &Path, out: &Path, host_version: &str, json: bool) -> i32 {
    match tronhawk_package::pack_for_host(dir, out, host_version) {
        Ok(()) => {
            if json {
                let report = serde_json::json!({
                    "ok": true,
                    "command": "pack",
                    "input": dir.to_string_lossy(),
                    "output": out.to_string_lossy(),
                    "host_protocol": host_version,
                    "engine_version": tronhawk_package::engine_version(),
                });
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            } else {
                println!("packed {} -> {} (host-protocol {})", dir.display(), out.display(), host_version);
            }
            EXIT_OK
        }
        Err(e) => {
            if json {
                let report = serde_json::json!({
                    "ok": false,
                    "command": "pack",
                    "error": e,
                    "host_protocol": host_version,
                    "engine_version": tronhawk_package::engine_version(),
                });
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            }
            eprintln!("pack failed: {e}");
            EXIT_REJECT
        }
    }
}

fn cmd_inspect(thx: &Path, host_version: &str, json: bool) -> i32 {
    match tronhawk_package::inspect_archive_for_host(thx, host_version) {
        Ok(info) => {
            if json {
                match serde_json::to_string_pretty(&info) {
                    Ok(s) => println!("{s}"),
                    Err(e) => {
                        eprintln!("inspect failed: {e}");
                        return EXIT_REJECT;
                    }
                }
            } else {
                let id = info
                    .manifest
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let version = info
                    .manifest
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                println!("ok {id} {version} (host-protocol {host_version})");
                println!("entries ({}) ({} bytes uncompressed):", info.entry_count, info.total_uncompressed);
                for e in &info.entries {
                    println!("  {e}");
                }
            }
            EXIT_OK
        }
        Err(e) => {
            if json {
                let report = serde_json::json!({
                    "ok": false,
                    "command": "inspect",
                    "error": e,
                    "host_protocol": host_version,
                    "engine_version": tronhawk_package::engine_version(),
                });
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            }
            eprintln!("inspect failed: {e}");
            EXIT_REJECT
        }
    }
}

fn main() {
    let b = bin_name();
    let raw: Vec<String> = std::env::args().skip(1).collect();

    // `--version` / `-V` anywhere without a subcommand.
    if raw.iter().any(|a| a == "--version" || a == "-V") && raw.first().map(|s| s.as_str()) != Some("help") {
        let json = raw.iter().any(|a| a == "--json");
        // Reject unknown flags alongside --version to keep the contract strict.
        for a in &raw {
            if a == "--version" || a == "-V" || a == "--json" {
                continue;
            }
            eprintln!("unknown option for --version: `{a}`.\n\n{}", usage(&b));
            std::process::exit(EXIT_USAGE);
        }
        if json {
            print_version_json();
        } else {
            print_version_human();
        }
        std::process::exit(EXIT_OK);
    }

    if raw.is_empty() || raw.iter().any(|a| a == "--help" || a == "-h") && raw.len() == 1 {
        println!("{}", help_text(&b));
        std::process::exit(EXIT_OK);
    }

    // `help` / `help <subcommand>`.
    if raw.first().map(|s| s.as_str()) == Some("help") {
        if raw.len() == 1 {
            println!("{}", help_text(&b));
            std::process::exit(EXIT_OK);
        }
        if raw.len() == 2 {
            let topic = raw[1].as_str();
            if matches!(topic, "validate" | "pack" | "inspect") {
                println!("{}", sub_help(topic, &b));
                std::process::exit(EXIT_OK);
            }
            eprintln!("unknown help topic `{topic}`.\n\n{}", usage(&b));
            std::process::exit(EXIT_USAGE);
        }
        eprintln!("too many arguments for help.\n\n{}", usage(&b));
        std::process::exit(EXIT_USAGE);
    }

    // Dispatch on the first positional token.
    let (sub, rest) = match raw.split_first() {
        Some((first, rest)) => (first.as_str(), rest.to_vec()),
        None => {
            eprintln!("{}", usage(&b));
            std::process::exit(EXIT_USAGE);
        }
    };

    let code = match sub {
        "validate" => {
            let (opts, positional) = match parse_flags(&b, &rest) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(EXIT_USAGE);
                }
            };
            if wants_help(&positional) {
                println!("{}", sub_help("validate", &b));
                EXIT_OK
            } else if positional.len() != 1 {
                eprintln!("validate requires exactly <plugin-dir>.\n\n{}", sub_help("validate", &b));
                EXIT_USAGE
            } else {
                let host = match resolve_host_version(opts.host_version) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(EXIT_USAGE);
                    }
                };
                cmd_validate(Path::new(&positional[0]), &host, opts.json)
            }
        }
        "pack" => {
            let (opts, positional) = match parse_flags(&b, &rest) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(EXIT_USAGE);
                }
            };
            if wants_help(&positional) {
                println!("{}", sub_help("pack", &b));
                EXIT_OK
            } else if positional.len() != 2 {
                eprintln!("pack requires <plugin-dir> <output.thx>.\n\n{}", sub_help("pack", &b));
                EXIT_USAGE
            } else {
                let host = match resolve_host_version(opts.host_version) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(EXIT_USAGE);
                    }
                };
                cmd_pack(
                    Path::new(&positional[0]),
                    Path::new(&positional[1]),
                    &host,
                    opts.json,
                )
            }
        }
        "inspect" => {
            let (opts, positional) = match parse_flags(&b, &rest) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(EXIT_USAGE);
                }
            };
            if wants_help(&positional) {
                println!("{}", sub_help("inspect", &b));
                EXIT_OK
            } else if positional.len() != 1 {
                eprintln!("inspect requires exactly <file.thx>.\n\n{}", sub_help("inspect", &b));
                EXIT_USAGE
            } else {
                let host = match resolve_host_version(opts.host_version) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(EXIT_USAGE);
                    }
                };
                cmd_inspect(Path::new(&positional[0]), &host, opts.json)
            }
        }
        // Legacy: `pack <plugin-dir> <output.thx>` (no subcommand). Keep accepting the two
        // existing documented invocations while guiding callers to the stable form.
        other if !other.starts_with('-') => {
            // Re-parse the whole `raw` (including `other`) as flags + positionals: legacy
            // accepts at most `--host-version` / `--json` alongside the two paths.
            let (opts, positional) = match parse_flags(&b, &[other.to_string()].into_iter().chain(rest.into_iter()).collect::<Vec<_>>()) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(EXIT_USAGE);
                }
            };
            // If the first token looked like a flag value or help, fall through to usage.
            if wants_help(&positional) {
                println!("{}", help_text(&b));
                EXIT_OK
            } else if positional.len() == 2 {
                eprintln!(
                    "warning: `{b} <plugin-dir> <output.thx>` is deprecated; use `{b} pack <plugin-dir> <output.thx>`."
                );
                let host = match resolve_host_version(opts.host_version) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(EXIT_USAGE);
                    }
                };
                // Legacy paths may be relative; resolve them as given.
                let dir = PathBuf::from(&positional[0]);
                let out = PathBuf::from(&positional[1]);
                cmd_pack(&dir, &out, &host, opts.json)
            } else {
                eprintln!("unknown subcommand `{other}`.\n\n{}", usage(&b));
                EXIT_USAGE
            }
        }
        other => {
            eprintln!("unknown subcommand `{other}`.\n\n{}", usage(&b));
            EXIT_USAGE
        }
    };
    std::process::exit(code);
}

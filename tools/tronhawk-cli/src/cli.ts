#!/usr/bin/env bun
// @tronhawk/cli — standalone plugin CLI.
//
// Gate 2 (binding):
// - JS never owns the final legitimacy decision. `validate`, `pack`, and `inspect`
//   always exec the same-version Rust engine (`tronhawk-pack`); a passing
//   `build`/`test` is never sufficient. Pack succeeds only when the Rust `pack`
//   returns success — isolated `build`/`smoke` results only decide whether to
//   continue, never to publish.
// - Plugin entry code never runs in this process (see `./isolate`): `build` and
//   `test` load entries in a one-shot bun subprocess (stdio captured, timeout
//   kill, exit code untrusted). A top-level `process.exit(0)` fails closed.
// - Missing binary / digest mismatch / unsupported platform => hard fail with install
//   guidance. There is deliberately NO TypeScript fallback packer.
// - `pack` calls the Rust engine once (`pack <staging> <output.thx>`); the engine
//   itself writes to a temp file, round-trips through the same crate, and
//   atomically renames. The CLI keeps no outer temp/inspect/rename duplicate.
// - CSS-only plugins are first-class: `pack` skips the `build` step with an
//   explicit notice but still runs minimal staging + the same-version Rust/SHA
//   path. All types use the unified `tronhawk pack` command.
// - `inspect` is implemented by Rust; the CLI only passes through (behavior is
//   defined by the engine).
// - CLI (`version`), engine (`tronhawk.engineVersion`), and protocol
//   (`tronhawk.protocolVersion`) versions are managed independently (see versions.ts).

import * as fs from "node:fs";
import * as path from "node:path";

import { buildPlugin } from "./build";
import { createStaging, removeStaging } from "./staging";
import { smokePlugin } from "./smoke";
import { cmdSandbox } from "./sandbox";
import { execFileSync, resolveNative } from "./native";
import { versionReportHuman, versionReportJson } from "./versions";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = `tronhawk - standalone TronHawk plugin CLI (authoritative checks run in Rust)

Usage
  tronhawk build <plugin-dir> [--outdir <dir>]
  tronhawk validate <plugin-dir> [--host-version <ver>] [--json]
  tronhawk pack <plugin-dir> <output.thx> [--host-version <ver>] [--json]
  tronhawk inspect <file.thx> [--host-version <ver>] [--json]
  tronhawk test <plugin-dir> [--sandbox]
  tronhawk --version [--json]
  tronhawk --help | -h | help [<command>]

Options
  --outdir <dir>       build output dir (default: <plugin-dir>/dist)
  --host-version <ver> explicit host runtime protocol version forwarded to Rust
                       (default: the engine's HOST_PROTOCOL_VERSION)
  --json               machine-readable JSON for validate/pack/inspect/--version
                       (pack --json prints exactly one JSON document from Rust)
  -h, --help           show help
  -V, --version        print versions (CLI / expected engine / expected protocol)

Exit codes
  0  success
  1  operation failure (build/smoke failure, Rust rejection, native engine problem)
  2  usage error`;

function binLabel(): string {
  return "tronhawk";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(EXIT_FAIL);
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  console.error("");
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

export interface Parsed {
  command?: string;
  positionals: string[];
  outdir?: string;
  hostVersion?: string;
  json: boolean;
  sandbox: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], json: false, sandbox: false, help: false, version: false };
  let i = 0;
  // First non-flag token is the command.
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
      continue;
    }
    if (a === "-V" || a === "--version") {
      out.version = true;
      i++;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      i++;
      continue;
    }
    if (a === "--sandbox") {
      out.sandbox = true;
      i++;
      continue;
    }
    if (a.startsWith("-")) break;
    out.command = a;
    i++;
    break;
  }
  const takeValue = (flag: string): string => {
    const cur = argv[i];
    const eq = cur.indexOf("=");
    if (eq !== -1) return cur.slice(eq + 1);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      usageError(`${flag} requires a value`);
    }
    i++;
    return next;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "-V" || a === "--version") {
      out.version = true;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--sandbox") {
      out.sandbox = true;
      continue;
    }
    if (a === "--outdir" || a.startsWith("--outdir=")) {
      out.outdir = takeValue("--outdir");
      continue;
    }
    if (a === "--host-version" || a.startsWith("--host-version=")) {
      const v = a.startsWith("--host-version=") ? a.slice("--host-version=".length) : takeValue("--host-version");
      if (!v) usageError("--host-version requires a value");
      out.hostVersion = v;
      continue;
    }
    if (a.startsWith("-")) usageError(`unknown option: ${a}`);
    out.positionals.push(a);
  }
  return out;
}

function commandHelp(command: string): string {
  switch (command) {
    case "build":
      return `usage: ${binLabel()} build <plugin-dir> [--outdir <dir>]\n\nBundle TS entries to single-file CommonJS dist/*.js (no unresolved externals, no residual require, no exports.default). Entry code loads in an isolated subprocess; CSS-only plugins have nothing to bundle (use \`tronhawk pack\`, which skips build explicitly).`;
    case "validate":
      return `usage: ${binLabel()} validate <plugin-dir> [--host-version <ver>] [--json]\n\nAuthoritative check via the same-version Rust engine (tronhawk-pack validate). JS never decides validity.`;
    case "pack":
      return `usage: ${binLabel()} pack <plugin-dir> <output.thx> [--host-version <ver>] [--json]\n\nCSS-aware: JS entries go build (isolated) -> smoke (isolated) -> staging; CSS-only skips build with an explicit notice but still runs staging. Then a single Rust \`pack <staging> <output.thx>\` decides publish (temp + round-trip + atomic rename inside Rust). --json prints exactly one JSON document from Rust.`;
    case "inspect":
      return `usage: ${binLabel()} inspect <file.thx> [--host-version <ver>] [--json]\n\nPassthrough to the Rust engine (\`tronhawk-pack inspect\`); behavior is defined by Rust. JS never decides validity.`;
    case "test":
      return `usage: ${binLabel()} test <plugin-dir> [--sandbox]\n\nBasic smoke only (isolated load): entry module.exports.activate/deactivate existence + lifecycle shape (later stages harden it). Never a substitute for validate. With --sandbox, entries additionally execute in the canonical QuickJS contract harness (same loading convention as the host).`;
    default:
      return USAGE;
  }
}

async function cmdBuild(pluginDir: string, outdir: string | undefined): Promise<number> {
  try {
    const result = await buildPlugin(pluginDir, outdir ? { outDirAbs: outdir } : {});
    for (const e of result.entries) {
      console.log(`built ${e.outputRel} (from ${path.relative(result.pluginDir, e.sourceAbs)})`);
    }
    return EXIT_OK;
  } catch (e) {
    console.error(`build failed: ${(e as Error).message}`);
    return EXIT_FAIL;
  }
}

function cmdVersion(json: boolean): number {
  try {
    if (json) {
      console.log(JSON.stringify(versionReportJson()));
    } else {
      console.log(versionReportHuman());
    }
    return EXIT_OK;
  } catch (e) {
    console.error(`version failed: ${(e as Error).message}`);
    return EXIT_FAIL;
  }
}

async function cmdTest(pluginDir: string): Promise<number> {
  const abs = path.resolve(pluginDir);
  // Prefer built outputs when present (dist/*.js), else the declared files.
  let builtOutputs: Record<string, string> | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(abs, "manifest.json"), "utf8")) as {
      entry?: Record<string, string>;
    };
    builtOutputs = {};
    for (const key of ["renderer", "main"]) {
      const declared = manifest.entry?.[key];
      if (typeof declared === "string") {
        const base = path.basename(declared).replace(/\.(ts|js)$/, ".js");
        builtOutputs[key] = path.posix.join("dist", base);
      }
    }
  } catch {
    builtOutputs = undefined;
  }
  const result = await smokePlugin(abs, builtOutputs);
  for (const c of result.checked) console.log(`checked ${c}`);
  if (result.ok) {
    console.log("smoke ok (basic only; authoritative check is `tronhawk validate`)");
    return EXIT_OK;
  }
  for (const issue of result.issues) {
    console.error(`smoke failed [${issue.entry}]: ${issue.message}`);
  }
  console.error("note: smoke is basic only; `tronhawk validate` (Rust) decides validity.");
  return EXIT_FAIL;
}

function runNativeOrFail(args: string[]): { code: number; stdout: string; stderr: string } {
  let native: { path: string };
  try {
    native = resolveNative();
  } catch (e) {
    console.error((e as Error).message);
    return { code: EXIT_FAIL, stdout: "", stderr: (e as Error).message };
  }
  const r = execFileSync(native.path, args);
  if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
  if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : r.stderr + "\n");
  // Propagate the engine's canonical codes (0 ok / 1 rejection / 2 usage) unchanged so
  // callers can distinguish "invalid plugin" from "bad flags".
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function cmdValidate(pluginDir: string, hostVersion: string | undefined, json: boolean): number {
  const args = ["validate", pluginDir];
  if (hostVersion) args.push("--host-version", hostVersion);
  if (json) args.push("--json");
  return runNativeOrFail(args).code;
}

function cmdInspect(thx: string, hostVersion: string | undefined, json: boolean): number {
  // Passthrough: behavior (including JSON shape) is defined by Rust.
  const args = ["inspect", thx];
  if (hostVersion) args.push("--host-version", hostVersion);
  if (json) args.push("--json");
  return runNativeOrFail(args).code;
}

function readManifestEntry(pluginAbs: string): { renderer?: string; main?: string; css?: string } {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginAbs, "manifest.json"), "utf8"),
    ) as { entry?: Record<string, unknown> };
    const entry = (manifest.entry ?? {}) as Record<string, unknown>;
    const out: { renderer?: string; main?: string; css?: string } = {};
    if (typeof entry.renderer === "string") out.renderer = entry.renderer;
    if (typeof entry.main === "string") out.main = entry.main;
    if (typeof entry.css === "string") out.css = entry.css;
    return out;
  } catch {
    return {};
  }
}

async function cmdPack(
  pluginDir: string,
  output: string,
  hostVersion: string | undefined,
  json: boolean,
): Promise<number> {
  const pluginAbs = path.resolve(pluginDir);
  const outputAbs = path.resolve(output);
  const logInfo = (msg: string) => {
    // --json must keep stdout to exactly one JSON document from Rust; all
    // human notices go to stderr in that mode.
    if (json) console.error(msg);
    else console.log(msg);
  };

  const manifestEntry = readManifestEntry(pluginAbs);
  const hasJs = Boolean(manifestEntry.renderer || manifestEntry.main);

  // 1. Build + smoke for JS plugins (isolated; necessary but never sufficient).
  //    CSS-only skips build explicitly but still runs staging + Rust.
  let built: { pluginDir: string; outDir: string; entries: Array<{ key: "renderer" | "main"; outputRel: string }> };
  if (!hasJs) {
    logInfo(
      "skipping build (CSS-only: style.css ships as data; staging still runs; authoritative pack is Rust).",
    );
    built = { pluginDir: pluginAbs, outDir: path.join(pluginAbs, "dist"), entries: [] };
  } else {
    try {
      built = await buildPlugin(pluginAbs);
    } catch (e) {
      console.error(`pack failed at build: ${(e as Error).message}`);
      return EXIT_FAIL;
    }
    const builtOutputs: Record<string, string> = {};
    for (const b of built.entries) builtOutputs[b.key] = b.outputRel;
    const smoke = await smokePlugin(pluginAbs, builtOutputs);
    if (!smoke.ok) {
      for (const issue of smoke.issues) {
        console.error(`pack failed at smoke [${issue.entry}]: ${issue.message}`);
      }
      return EXIT_FAIL;
    }
  }

  // 2. Minimal staging (manifest.json + dist/*.js + declared CSS/assets only).
  let stage: string;
  try {
    stage = createStaging(pluginAbs, built as Parameters<typeof createStaging>[1]);
  } catch (e) {
    console.error(`pack failed at staging: ${(e as Error).message}`);
    return EXIT_FAIL;
  }
  try {
    // 3. Resolve the same-version native engine snapshot (hard fail; never fall back).
    let nativePath: string;
    try {
      nativePath = resolveNative().path;
    } catch (e) {
      console.error((e as Error).message);
      return EXIT_FAIL;
    }
    // 4. Single authoritative Rust pack: staging -> final output. Rust owns the
    //    temp file, the same-crate round-trip, and the atomic rename; the CLI
    //    keeps no outer duplicate. Publish happens iff Rust exits 0.
    const packArgs = ["pack", stage, outputAbs];
    if (hostVersion) packArgs.push("--host-version", hostVersion);
    if (json) packArgs.push("--json");
    const packRun = execFileSync(nativePath, packArgs);
    // Forward verbatim, except: --json must stay exactly one JSON document.
    // Rust's JSON names the staging dir as `input`; rewrite it to the real
    // plugin dir so callers see a stable path (still a single document).
    let stdoutToEmit = packRun.stdout;
    if (json && packRun.exitCode === 0 && stdoutToEmit.trim()) {
      try {
        const doc = JSON.parse(stdoutToEmit) as Record<string, unknown>;
        doc.input = pluginAbs;
        doc.output = outputAbs;
        stdoutToEmit = `${JSON.stringify(doc)}\n`;
      } catch {
        // Keep Rust's bytes verbatim (still a single document when Rust is healthy).
      }
    }
    if (stdoutToEmit) {
      process.stdout.write(stdoutToEmit.endsWith("\n") ? stdoutToEmit : stdoutToEmit + "\n");
    }
    if (packRun.stderr) {
      process.stderr.write(packRun.stderr.endsWith("\n") ? packRun.stderr : packRun.stderr + "\n");
    }
    // Propagate the engine's canonical code (1 rejection / 2 usage). On failure
    // Rust leaves no half-written output (temp + rename inside Rust).
    return packRun.exitCode;
  } finally {
    removeStaging(stage);
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.version && !parsed.command && !parsed.help) {
    return cmdVersion(parsed.json);
  }
  if (parsed.help && !parsed.command) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (!parsed.command) {
    if (parsed.version) return cmdVersion(parsed.json);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.help) {
    console.log(commandHelp(parsed.command));
    return EXIT_OK;
  }
  if (parsed.version && parsed.command) {
    // `tronhawk <command> --version` is a usage error (versions are global).
    console.error(`error: --version takes no command (got \`${parsed.command}\`).`);
    console.error("");
    console.error(USAGE);
    return EXIT_USAGE;
  }

  switch (parsed.command) {
    case "build": {
      if (parsed.positionals.length !== 1) {
        console.error(`error: build requires exactly <plugin-dir>.`);
        console.error("");
        console.error(commandHelp("build"));
        return EXIT_USAGE;
      }
      if (parsed.hostVersion || parsed.json) {
        console.error("error: build takes only [--outdir <dir>].");
        console.error("");
        console.error(commandHelp("build"));
        return EXIT_USAGE;
      }
      if (parsed.sandbox) {
        console.error("error: build takes no --sandbox (usage: tronhawk test <plugin-dir> [--sandbox]).");
        console.error("");
        console.error(commandHelp("build"));
        return EXIT_USAGE;
      }
      return cmdBuild(parsed.positionals[0], parsed.outdir);
    }
    case "validate": {
      if (parsed.positionals.length !== 1) {
        console.error("error: validate requires exactly <plugin-dir>.");
        console.error("");
        console.error(commandHelp("validate"));
        return EXIT_USAGE;
      }
      if (parsed.outdir) {
        console.error("error: validate takes no --outdir.");
        console.error("");
        console.error(commandHelp("validate"));
        return EXIT_USAGE;
      }
      if (parsed.sandbox) {
        console.error("error: validate takes no --sandbox (usage: tronhawk test <plugin-dir> [--sandbox]).");
        console.error("");
        console.error(commandHelp("validate"));
        return EXIT_USAGE;
      }
      return cmdValidate(parsed.positionals[0], parsed.hostVersion, parsed.json);
    }
    case "pack": {
      if (parsed.positionals.length !== 2) {
        console.error("error: pack requires <plugin-dir> <output.thx>.");
        console.error("");
        console.error(commandHelp("pack"));
        return EXIT_USAGE;
      }
      if (parsed.outdir) {
        console.error("error: pack takes no --outdir (build always emits dist/; staging is minimal).");
        console.error("");
        console.error(commandHelp("pack"));
        return EXIT_USAGE;
      }
      if (parsed.sandbox) {
        console.error("error: pack takes no --sandbox (usage: tronhawk test <plugin-dir> [--sandbox]).");
        console.error("");
        console.error(commandHelp("pack"));
        return EXIT_USAGE;
      }
      return cmdPack(parsed.positionals[0], parsed.positionals[1], parsed.hostVersion, parsed.json);
    }
    case "inspect": {
      if (parsed.positionals.length !== 1) {
        console.error("error: inspect requires exactly <file.thx>.");
        console.error("");
        console.error(commandHelp("inspect"));
        return EXIT_USAGE;
      }
      if (parsed.outdir) {
        console.error("error: inspect takes no --outdir.");
        console.error("");
        console.error(commandHelp("inspect"));
        return EXIT_USAGE;
      }
      if (parsed.sandbox) {
        console.error("error: inspect takes no --sandbox (usage: tronhawk test <plugin-dir> [--sandbox]).");
        console.error("");
        console.error(commandHelp("inspect"));
        return EXIT_USAGE;
      }
      return cmdInspect(parsed.positionals[0], parsed.hostVersion, parsed.json);
    }
    case "test": {
      if (parsed.positionals.length !== 1) {
        console.error("error: test requires exactly <plugin-dir>.");
        console.error("");
        console.error(commandHelp("test"));
        return EXIT_USAGE;
      }
      if (parsed.hostVersion || parsed.json || parsed.outdir) {
        console.error("error: test takes no options (usage: tronhawk test <plugin-dir> [--sandbox]).");
        console.error("");
        console.error(commandHelp("test"));
        return EXIT_USAGE;
      }
      if (parsed.sandbox) return cmdSandbox(parsed.positionals[0]);
      return cmdTest(parsed.positionals[0]);
    }
    case "help": {
      if (parsed.positionals.length === 0) {
        console.log(USAGE);
        return EXIT_OK;
      }
      if (parsed.positionals.length === 1) {
        const topic = parsed.positionals[0];
        if (["build", "validate", "pack", "inspect", "test"].includes(topic)) {
          console.log(commandHelp(topic));
          return EXIT_OK;
        }
        console.error(`error: unknown help topic \`${topic}\`.`);
        console.error("");
        console.error(USAGE);
        return EXIT_USAGE;
      }
      console.error("error: too many arguments for help.");
      console.error("");
      console.error(USAGE);
      return EXIT_USAGE;
    }
    default:
      console.error(`error: unknown command \`${parsed.command}\`.`);
      console.error("");
      console.error(USAGE);
      return EXIT_USAGE;
  }
}

// Execute when run as the entry script (bun ./src/cli.ts, or the package bin).
const meta = import.meta as unknown as { main?: boolean };
if (meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

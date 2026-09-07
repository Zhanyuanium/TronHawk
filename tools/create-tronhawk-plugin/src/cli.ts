#!/usr/bin/env bun
// create-tronhawk-plugin: scaffold a new TronHawk plugin project.
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_CLI_SPEC,
  DEFAULT_SDK_SPEC,
  type PluginType,
  type ScaffoldFile,
  type ScaffoldOptions,
  buildFiles,
  humanize,
  isValidPluginId,
  manifestObject,
  packageJsonObject,
  sanitizeDisplayName,
  slugify,
  typeLabel,
} from "./scaffold";

const DEFAULT_VERSION = "0.1.0";

const USAGE = `create-tronhawk-plugin - scaffold a new TronHawk plugin project

Usage
  create-tronhawk-plugin [options] <name-or-dir>

Arguments
  <name-or-dir>          Plugin name (creates ./<name>) or a target directory
                         path. The target directory must not exist yet, or must
                         be empty unless --force is given.

Options
  --type <css|renderer|main>
                         Starter template to scaffold. Default: renderer.
                           css      - theme-only: style.css via entry.css
                           renderer - page CSS + a renderer script (default)
                           main     - Electron main-process script
  --name <display>       Human-readable plugin name (manifest "name").
                         Default: derived from the directory name.
  --author <author>      Manifest "author". Default: git user.name, else "Example".
  --id <id>              Manifest plugin id (reverse-DNS, lowercase).
                         Default: com.example.<name>.
  --sdk <spec>           Dependency spec for "@tronhawk/sdk". Default:
                         "${DEFAULT_SDK_SPEC}" (npm registry). Use
                         "file:<path>" for a local tarball or checkout.
  --cli <spec>           Dependency spec for "@tronhawk/cli" (devDependency,
                         provides the "tronhawk" build/validate/pack binary).
                         Default: "${DEFAULT_CLI_SPEC}" (npm registry).
  --force                Replace a non-empty target directory.
  -h, --help             Show this help.
  -v, --version          Print the version.

Examples
  create-tronhawk-plugin dark-scrollbar
  create-tronhawk-plugin plugins/my-plugin --type main --author "Ada"
  create-tronhawk-plugin ./tmp/theme --type css --force`;

interface ParsedArgs {
  target?: string;
  type: string;
  name?: string;
  author?: string;
  id?: string;
  sdk?: string;
  cli?: string;
  force: boolean;
  help: boolean;
  version: boolean;
  errors: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    type: "renderer",
    force: false,
    help: false,
    version: false,
    errors: [],
  };

  const takeValue = (i: number, flag: string): [string, number] | undefined => {
    const inline = argv[i].includes("=");
    if (inline) return [argv[i].slice(argv[i].indexOf("=") + 1), i];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      out.errors.push(`${flag} requires a value`);
      return undefined;
    }
    return [next, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (flag) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--type": {
        const v = takeValue(i, "--type");
        if (!v) return out;
        out.type = v[0];
        i = v[1];
        break;
      }
      case "--name": {
        const v = takeValue(i, "--name");
        if (!v) return out;
        out.name = v[0];
        i = v[1];
        break;
      }
      case "--author": {
        const v = takeValue(i, "--author");
        if (!v) return out;
        out.author = v[0];
        i = v[1];
        break;
      }
      case "--id": {
        const v = takeValue(i, "--id");
        if (!v) return out;
        out.id = v[0];
        i = v[1];
        break;
      }
      case "--sdk": {
        const v = takeValue(i, "--sdk");
        if (!v) return out;
        out.sdk = v[0];
        i = v[1];
        break;
      }
      case "--cli": {
        const v = takeValue(i, "--cli");
        if (!v) return out;
        out.cli = v[0];
        i = v[1];
        break;
      }
      default:
        if (arg.startsWith("-")) {
          out.errors.push(`unknown option: ${arg}`);
        } else if (out.target === undefined) {
          out.target = arg;
        } else {
          out.errors.push(`unexpected extra argument: ${arg}`);
        }
    }
  }
  return out;
}

function isPluginType(v: string): v is PluginType {
  return v === "css" || v === "renderer" || v === "main";
}

function readGitUser(): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "config", "user.name"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return undefined;
    const v = r.stdout.toString().trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

function readOwnVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isDirEmpty(dir: string): boolean {
  return fs.readdirSync(dir).length === 0;
}

/** Remove a target directory we are about to regenerate (used with --force). */
function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function formatRelOrAbs(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
  return rel;
}

function printSummary(
  opts: ScaffoldOptions,
  files: ScaffoldFile[],
  targetAbs: string,
  sdkNote: string | undefined,
  cliNote: string | undefined,
): void {
  const kind = typeLabel(opts.type);
  const where = formatRelOrAbs(process.cwd(), targetAbs);
  console.log("");
  console.log(`Scaffolded ${opts.displayName} (${opts.pluginId}) - ${kind}`);
  console.log(`  target: ${where}`);
  console.log("");
  for (const f of files) console.log(`  ${f.path}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${where}`);
  console.log("  bun install");
  if (opts.type === "css") {
    console.log('  echo "no build step (CSS-only: style.css ships as data)"');
  } else {
    console.log("  bun run build        # tronhawk build: bundle entries to dist/");
  }
  console.log("  bun run typecheck");
  console.log("  bun test");
  console.log("");
  console.log("Pack to .thx (needs the same-version tronhawk-pack engine, see README):");
  console.log("  tronhawk validate .   # authoritative dir check (writes nothing)");
  // All types pack through the unified `tronhawk pack` command. CSS-only
  // skips `build` explicitly (style.css ships as data) but still runs
  // staging + the same-version Rust/SHA path; never call the engine directly.
  console.log(`  tronhawk pack . ${opts.slug}.thx   # all types (CSS: no build, same Rust/SHA path)`);
  console.log("");
  console.log("Engine setup: set TRONHAWK_PACK_BIN to the same-version tronhawk-pack binary");
  console.log("(CLI tronhawk.engineVersion must exactly match tronhawk-pack --version).");
  if (sdkNote) {
    console.log("");
    console.log(`Note: @tronhawk/sdk = ${opts.sdkSpec} - ${sdkNote}`);
  }
  if (cliNote) {
    if (!sdkNote) console.log("");
    console.log(`Note: @tronhawk/cli = ${opts.cliSpec} - ${cliNote}`);
  }
  console.log("");
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);

  if (a.errors.length > 0) {
    for (const e of a.errors) console.error(`error: ${e}`);
    console.error("");
    console.error(USAGE);
    return 2;
  }
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (a.version) {
    console.log(readOwnVersion());
    return 0;
  }
  if (!a.target) {
    console.error("error: missing <name-or-dir> argument");
    console.error("");
    console.error(USAGE);
    return 2;
  }
  if (!isPluginType(a.type)) {
    console.error(`error: unknown --type "${a.type}" (expected css, renderer, or main)`);
    return 2;
  }

  const cwd = process.cwd();
  const targetAbs = path.resolve(cwd, a.target);

  // Safety: never scaffold over the fs root, the cwd itself, or an ancestor of cwd.
  const relFromTargetToCwd = path.relative(targetAbs, cwd);
  const targetIsCwdOrAncestor =
    relFromTargetToCwd === "" ||
    (!relFromTargetToCwd.startsWith("..") && !path.isAbsolute(relFromTargetToCwd));
  if (targetAbs === path.parse(targetAbs).root || targetIsCwdOrAncestor) {
    console.error("error: refusing to scaffold into the filesystem root, the current directory, or an ancestor of it");
    return 2;
  }

  const baseName = path.basename(targetAbs);
  const slug = slugify(baseName);
  if (slug.length === 0) {
    console.error(`error: could not derive a usable plugin name from "${baseName}"`);
    return 2;
  }

  const displayName = sanitizeDisplayName(
    a.name?.trim() || humanize(baseName),
  );
  if (displayName.length === 0) {
    console.error("error: --name must not be empty");
    return 2;
  }

  const author = a.author?.trim() || readGitUser() || "Example";

  let pluginId = a.id?.trim();
  if (pluginId !== undefined && pluginId.length === 0) {
    console.error("error: --id must not be empty");
    return 2;
  }
  if (pluginId === undefined) {
    pluginId = `com.example.${slug}`;
  }
  if (!isValidPluginId(pluginId)) {
    console.error(
      `error: invalid plugin id "${pluginId}" (use lowercase letters, digits, ".", "-", "_"; no empty dot-segments; max 128 chars)`,
    );
    return 2;
  }

  // Standalone-first: both specs default to the npm registry release
  // lines. No workspace / local-checkout probing: `--sdk` / `--cli` are the
  // only overrides (e.g. file: tarballs while the packages are unpublished).
  const sdkSpec = a.sdk?.trim() ? a.sdk.trim() : DEFAULT_SDK_SPEC;
  const sdkNote = a.sdk?.trim()
    ? "overridden via --sdk"
    : "npm registry default (override with --sdk, e.g. --sdk file:/path/to/sdk.tgz)";
  const cliSpec = a.cli?.trim() ? a.cli.trim() : DEFAULT_CLI_SPEC;
  const cliNote = a.cli?.trim()
    ? "overridden via --cli"
    : "npm registry default (override with --cli, e.g. --cli file:/path/to/tronhawk-cli.tgz)";

  const opts: ScaffoldOptions = {
    slug,
    displayName,
    author,
    type: a.type,
    version: DEFAULT_VERSION,
    pluginId,
    sdkSpec,
    cliSpec,
  };

  const files = buildFiles(opts);

  // Prepare target directory.
  const exists = fs.existsSync(targetAbs);
  if (exists && !fs.statSync(targetAbs).isDirectory()) {
    console.error(`error: target exists and is not a directory: ${targetAbs}`);
    return 1;
  }
  if (exists && !isDirEmpty(targetAbs) && !a.force) {
    console.error(`error: target directory is not empty: ${targetAbs}`);
    console.error("  pass --force to replace its contents");
    return 1;
  }
  if (exists && !isDirEmpty(targetAbs) && a.force) {
    removeTree(targetAbs);
  }
  fs.mkdirSync(targetAbs, { recursive: true });

  try {
    for (const f of files) {
      const dest = path.join(targetAbs, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content, "utf8");
    }
  } catch (err) {
    console.error(`error: failed to write scaffold files: ${(err as Error).message}`);
    return 1;
  }

  printSummary(opts, files, targetAbs, sdkNote, cliNote);
  return 0;
}

// Execute when run as the entry script (bun ./src/cli.ts, or the package bin).
const meta = import.meta as unknown as { main?: boolean };
if (meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

// Re-exported for tests / programmatic use.
export { manifestObject, packageJsonObject, slugify };

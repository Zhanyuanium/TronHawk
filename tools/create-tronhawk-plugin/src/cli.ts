#!/usr/bin/env bun
// create-tronhawk-plugin: scaffold a new TronHawk plugin project.
import * as fs from "node:fs";
import * as path from "node:path";

import {
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
                         "workspace:*" inside the monorepo's plugins/, otherwise
                         a relative "file:" spec pointing at the local SDK.
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

interface SdkRepo {
  /** Monorepo root: the directory whose sdk/package.json is @tronhawk/sdk. */
  root: string;
  sdkDir: string;
}

/** Walk up from `start` looking for the TronHawk monorepo (sdk/package.json). */
function findSdkRepo(start: string): SdkRepo | null {
  let cur = path.resolve(start);
  for (;;) {
    try {
      const manifestPath = path.join(cur, "sdk", "package.json");
      const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@tronhawk/sdk") {
        return { root: cur, sdkDir: path.join(cur, "sdk") };
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** True when the scaffold target will itself be a bun workspace member dir. */
function isWorkspaceMemberTarget(repo: SdkRepo, targetAbs: string): boolean {
  const parent = path.dirname(targetAbs);
  for (const dir of ["plugins", "tools"]) {
    if (path.relative(parent, path.join(repo.root, dir)) === "") return true;
  }
  return false;
}

interface SdkSpec {
  spec: string;
  note?: string;
}

function resolveSdkSpec(repo: SdkRepo | null, targetAbs: string): SdkSpec {
  if (repo) {
    if (isWorkspaceMemberTarget(repo, targetAbs)) {
      return {
        spec: "workspace:*",
        note: "run `bun install` from the monorepo root to register the workspace link",
      };
    }
    let rel = path.relative(targetAbs, repo.sdkDir);
    const crossDrive = path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel);
    if (!crossDrive && rel !== "") {
      return {
        spec: `file:${toPosix(rel)}`,
        note: `bun resolves the local SDK at ${toPosix(rel)} relative to the plugin`,
      };
    }
  }
  return {
    spec: "workspace:*",
    note: "no local SDK was detected; pass --sdk (e.g. file:../sdk or a registry spec) if this target is not inside the monorepo",
  };
}

/** True when `abs` is strictly inside directory `dir`. */
function isInsideDir(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
  insideMonorepo: boolean,
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
  console.log("  bun run typecheck");
  console.log("");
  console.log("Pack to .thx (optional):");
  if (insideMonorepo) {
    console.log(`  cd ${where} && rm -rf node_modules   # packer refuses symlinks`);
    console.log(`  cargo run -p tronhawk-package --bin pack -- . ${opts.slug}.thx`);
    console.log("  bun install                          # restore deps");
  } else {
    console.log(`  # from the TronHawk repo root, after removing node_modules from the plugin:`);
    console.log(`  cargo run -p tronhawk-package --bin pack -- ${where} ${opts.slug}.thx`);
  }
  if (sdkNote) {
    console.log("");
    console.log(`Note: @tronhawk/sdk = ${opts.sdkSpec} - ${sdkNote}`);
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

  const repo = findSdkRepo(import.meta.dir);
  const sdk = a.sdk?.trim() ? { spec: a.sdk.trim() } : resolveSdkSpec(repo, targetAbs);

  const insideMonorepo = repo !== null && isInsideDir(repo.root, targetAbs);
  const opts: ScaffoldOptions = {
    slug,
    displayName,
    author,
    type: a.type,
    version: DEFAULT_VERSION,
    pluginId,
    sdkSpec: sdk.spec,
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

  printSummary(opts, files, targetAbs, sdk.note, insideMonorepo);
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

// `build`: bundle plugin TS/JS entries to single-file CommonJS `dist/*.js` (Gate 2).
//
// Contract:
// - TS is the source of truth when a sibling `.ts` exists next to a manifest-declared `.js`
//   (e.g. `src/renderer.js` + `src/renderer.ts` => bundle `src/renderer.ts`).
// - Output is single-file CommonJS for the QuickJS host (`module.exports.activate` /
//   `deactivate`). A TS `export default` source is bridged via a temp wrapper so the bundle
//   exposes `module.exports = { activate, deactivate }` with no `exports.default`.
// - Hard failures (exit 1 via the caller): unresolved externals (`Could not resolve`),
//   residual bare `require("pkg")`, `exports.default` residue, missing activate/deactivate,
//   banned host-only imports (`node:*`, `electron`).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { inspectEntryIsolated, IsolatedEntryError } from "./isolate";

export interface BuiltEntry {
  /** Manifest key: `renderer` or `main`. */
  key: "renderer" | "main";
  /** Absolute source file that was bundled. */
  sourceAbs: string;
  /** Plugin-relative output (always `dist/<name>.js`). */
  outputRel: string;
  /** Absolute output file. */
  outputAbs: string;
}

export interface BuildResult {
  pluginDir: string;
  outDir: string;
  entries: BuiltEntry[];
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

interface ManifestEntry {
  css?: string;
  renderer?: string;
  main?: string;
}

function readManifest(pluginDir: string): { raw: Record<string, unknown>; entry: ManifestEntry } {
  const manifestPath = path.join(pluginDir, "manifest.json");
  // The manifest must be a real file inside the plugin root — never a symlink
  // (which could point outside the root and smuggle foreign content into the build).
  try {
    if (fs.lstatSync(manifestPath).isSymbolicLink()) {
      throw new BuildError(`refusing to build with symlinked manifest.json: ${manifestPath}.`);
    }
  } catch (e) {
    if (e instanceof BuildError) throw e;
    throw new BuildError(`cannot read manifest.json: ${(e as Error).message}`);
  }
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    throw new BuildError(`cannot read manifest.json: ${(e as Error).message}`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new BuildError(`manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  const entry = (raw.entry ?? {}) as ManifestEntry;
  return { raw, entry };
}

const BANNED_IMPORT_HINT =
  "plugin entries run in the QuickJS sandbox and must not import host-only modules";

function checkBannedImports(sourceAbs: string, text: string): void {
  // Static scan for host-only imports. Bundled output with `target: browser` stubs
  // `node:*` to `{}`, which would pass a pure output scan but break at runtime — so fail
  // fast here with an actionable message.
  const patterns: Array<[RegExp, string]> = [
    [/from\s+["']node:/, "`node:*`"],
    [/require\s*\(\s*["']node:/, "`node:*`"],
    [/from\s+["']electron["']/, "`electron`"],
    [/require\s*\(\s*["']electron["']/, "`electron`"],
    [/\bchild_process\b/, "`child_process`"],
  ];
  for (const [re, what] of patterns) {
    if (re.test(text)) {
      throw new BuildError(
        `${path.relative(process.cwd(), sourceAbs)} imports ${what} (${BANNED_IMPORT_HINT}).`,
      );
    }
  }
  // Bare `fs`/`path` imports without the `node:` prefix are the same violation.
  if (/from\s+["'](?:fs|path|os|child_process)["']/.test(text)) {
    throw new BuildError(
      `${path.relative(process.cwd(), sourceAbs)} imports a Node builtin (${BANNED_IMPORT_HINT}).`,
    );
  }
}

/** Prefer the sibling `.ts` source when it exists next to a declared `.js` file. */
function resolveSource(pluginDir: string, declaredRel: string): string {
  const declaredAbs = path.resolve(pluginDir, declaredRel);
  if (declaredAbs.endsWith(".js")) {
    const sibling = declaredAbs.slice(0, -".js".length) + ".ts";
    try {
      if (fs.statSync(sibling).isFile()) return sibling;
    } catch {
      // no sibling — fall through to the declared file
    }
  }
  return declaredAbs;
}

/**
 * Resolve a manifest-declared entry to its canonical source path and require
 * it to live inside the plugin root. Rejects absolute declarations, `..`
 * escapes, missing files, and symlink escapes (a `src/link.js` inside the
 * root pointing outside is still outside). Returns the realpath to build.
 */
function resolveContainedSource(
  rootReal: string,
  pluginDir: string,
  key: "renderer" | "main",
  declaredRel: string,
): string {
  if (path.isAbsolute(declaredRel)) {
    throw new BuildError(
      `entry.${key} must be a root-relative path, got absolute ${JSON.stringify(declaredRel)}.`,
    );
  }
  const sourceAbs = resolveSource(pluginDir, declaredRel);
  let real: string;
  try {
    real = fs.realpathSync(sourceAbs);
  } catch {
    throw new BuildError(
      `entry.${key} source not found: ${sourceAbs} (declared as ${JSON.stringify(declaredRel)}).`,
    );
  }
  const rel = path.relative(rootReal, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BuildError(
      `entry.${key} source escapes the plugin root: ${sourceAbs} ` +
        `(declared as ${JSON.stringify(declaredRel)}) resolves to ${real}; root is ${rootReal}.`,
    );
  }
  return real;
}

function outputRelFor(key: "renderer" | "main", sourceAbs: string): string {
  const base = path.basename(sourceAbs).replace(/\.(ts|js)$/, ".js");
  // Keep the conventional names (`renderer.js` / `main.js`) even when the source lives
  // elsewhere; collisions across keys are rejected below.
  void key;
  return path.posix.join("dist", base);
}

function assertSingleFileOutput(outputAbs: string): string {
  let text: string;
  try {
    text = fs.readFileSync(outputAbs, "utf8");
  } catch (e) {
    throw new BuildError(`built output missing at ${outputAbs}: ${(e as Error).message}`);
  }
  if (!text.trim()) throw new BuildError(`built output is empty: ${outputAbs}`);
  return text;
}

function checkNoResidualRequire(outputAbs: string, text: string): void {
  // Residual bare-specifier requires mean an external was left unbundled (forbidden: the
  // bundle must be single-file with no unresolved externals).
  const m = text.match(/require\s*\(\s*["']([^"']+)["']\s*\)/);
  if (m) {
    const spec = m[1];
    if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:")) {
      throw new BuildError(
        `${outputAbs} has a residual require(${JSON.stringify(spec)}): ` +
          `unresolved external — the bundle must be single-file (no externals).`,
      );
    }
    // Any residual require at all is suspicious in a single-file QuickJS bundle; keep the
    // gate strict but actionable.
    throw new BuildError(
      `${outputAbs} has a residual require(${JSON.stringify(spec)}): ` +
        `the bundle must be single-file with no require leftovers.`,
    );
  }
  if (/from\s+["']([^"']+)["']/.test(text) && /import\s/.test(text)) {
    // Bundled CJS should not retain ESM import statements.
    throw new BuildError(`${outputAbs} retains an ESM import (bundle must be single-file CJS).`);
  }
}

function checkNoExportsDefault(outputAbs: string, text: string): void {
  if (/exports\s*\.\s*default\b/.test(text) || /exports\s*\[\s*["']default["']\s*\]/.test(text)) {
    throw new BuildError(
      `${outputAbs} exposes \`exports.default\` (the host reads \`module.exports.activate\` / \`deactivate\`; ` +
        `do not ship an ESM default export).`,
    );
  }
  if (/\bexport\s+default\b/.test(text)) {
    throw new BuildError(`${outputAbs} retains \`export default\` (must be bundled to CJS).`);
  }
}

/** Load the built CJS and assert the runtime entry shape (never in this process). */
async function checkRuntimeShape(outputAbs: string): Promise<void> {
  // Gate 2: plugin top-level code runs ONLY in the isolated child (stdio
  // captured, timeout kill, exit code untrusted). A bare `process.exit(0)` in
  // the entry yields no trusted marker and fails closed here — it can never
  // skip the authoritative Rust pack.
  let shape;
  try {
    shape = await inspectEntryIsolated(outputAbs);
  } catch (e) {
    throw new BuildError(
      `built ${outputAbs} failed the isolated entry check: ${(e as Error).message}`,
    );
  }
  if (!shape.isObject) {
    throw new BuildError(`built ${outputAbs} must export an object via \`module.exports\`.`);
  }
  if (shape.hasDefault) {
    throw new BuildError(
      `built ${outputAbs} exports \`default\` (forbidden: use \`module.exports = { activate, deactivate }\`).`,
    );
  }
  for (const [key, type] of [
    ["activate", shape.activateType],
    ["deactivate", shape.deactivateType],
  ] as const) {
    if (type !== "function") {
      throw new BuildError(
        `built ${outputAbs} must export \`${key}\` as a function via \`module.exports\` (got ${type}).`,
      );
    }
  }
  void IsolatedEntryError;
}

async function bundleOne(entryAbs: string, outputAbs: string): Promise<void> {
  let sourceText = "";
  try {
    sourceText = fs.readFileSync(entryAbs, "utf8");
  } catch (e) {
    throw new BuildError(`cannot read entry ${entryAbs}: ${(e as Error).message}`);
  }
  checkBannedImports(entryAbs, sourceText);

  // Bridge TS `export default` to CJS `module.exports` via a temp wrapper entry. Bundling
  // the `.ts` directly would emit `exports.default` (via `__export`), which the QuickJS host
  // never reads — so the wrapper is required for correctness, not cosmetic.
  const needsWrapper = /\bexport\s+default\b/.test(sourceText);
  let bundlingEntry = entryAbs;
  let wrapperDir: string | null = null;
  if (needsWrapper) {
    wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-"));
    bundlingEntry = path.join(wrapperDir, "entry.wrapper.js");
    fs.writeFileSync(
      bundlingEntry,
      `import plugin from ${JSON.stringify(entryAbs)};\nmodule.exports = plugin;\n`,
      "utf8",
    );
  }

  try {
    fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
    const result = await Bun.build({
      entrypoints: [bundlingEntry],
      outdir: path.dirname(outputAbs),
      naming: path.basename(outputAbs),
      format: "cjs",
      target: "browser",
      minify: false,
      sourcemap: "none",
    });
    const errors = result.logs.filter((l) => l.level === "error");
    if (!result.success || errors.length > 0) {
      const detail = errors.map((l) => l.message).join("\n") || "bun build failed";
      throw new BuildError(`cannot bundle ${entryAbs}:\n${detail}`);
    }
    for (const log of result.logs) {
      if (/could not resolve/i.test(log.message)) {
        throw new BuildError(`unresolved external while bundling ${entryAbs}:\n${log.message}`);
      }
    }
    // `Bun.build` with `naming` writes exactly `outputAbs` for a single entry; tolerate a
    // same-basename fallback in case of naming normalization.
    if (!fs.existsSync(outputAbs)) {
      const alt = path.join(path.dirname(outputAbs), path.basename(bundlingEntry).replace(/\.[^.]+$/, ".js"));
      if (fs.existsSync(alt) && alt !== outputAbs) {
        fs.copyFileSync(alt, outputAbs);
      }
    }
  } finally {
    if (wrapperDir) fs.rmSync(wrapperDir, { recursive: true, force: true });
  }

  const text = assertSingleFileOutput(outputAbs);
  checkNoResidualRequire(outputAbs, text);
  checkNoExportsDefault(outputAbs, text);
  await checkRuntimeShape(outputAbs);
}

export async function buildPlugin(
  pluginDirAbs: string,
  opts: { outDirAbs?: string } = {},
): Promise<BuildResult> {
  const pluginDir = path.resolve(pluginDirAbs);
  const stat = (() => {
    try {
      return fs.statSync(pluginDir);
    } catch {
      throw new BuildError(`plugin directory not found: ${pluginDir}`);
    }
  })();
  if (!stat.isDirectory()) throw new BuildError(`not a directory: ${pluginDir}`);
  // Canonical root for containment: symlinked path components must not widen
  // what counts as "inside" the plugin.
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(pluginDir);
  } catch {
    throw new BuildError(`plugin directory not found: ${pluginDir}`);
  }

  const { entry } = readManifest(rootReal);
  const jobs: Array<{ key: "renderer" | "main"; declaredRel: string }> = [];
  if (entry.renderer) jobs.push({ key: "renderer", declaredRel: entry.renderer });
  if (entry.main) jobs.push({ key: "main", declaredRel: entry.main });
  if (jobs.length === 0) {
    throw new BuildError(
      `manifest.json declares no \`entry.renderer\` or \`entry.main\` (nothing to bundle; CSS-only plugins need no build).`,
    );
  }

  const outDir = path.resolve(opts.outDirAbs ?? path.join(pluginDir, "dist"));
  const built: BuiltEntry[] = [];
  const seenOutputs = new Set<string>();
  for (const job of jobs) {
    // Containment first: an out-of-root or symlink-escaping source fails here,
    // before anything is bundled or rewritten to an internal `dist/` path.
    const sourceAbs = resolveContainedSource(rootReal, pluginDir, job.key, job.declaredRel);
    const outputRel = outputRelFor(job.key, sourceAbs);
    if (seenOutputs.has(outputRel)) {
      throw new BuildError(`two entries would overwrite ${outputRel} (rename one source).`);
    }
    seenOutputs.add(outputRel);
    const outputAbs = path.resolve(outDir, path.relative("dist", outputRel));
    await bundleOne(sourceAbs, outputAbs);
    built.push({ key: job.key, sourceAbs, outputRel, outputAbs });
  }
  built.sort((a, b) => a.outputRel.localeCompare(b.outputRel));
  return { pluginDir, outDir, entries: built };
}

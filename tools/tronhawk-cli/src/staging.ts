// Minimal staging for `pack` (Gate 2): the `.thx` must contain ONLY
// `manifest.json` + `dist/*.js` + declared CSS / `assets/` — never `src/*.ts`,
// `package.json`, `node_modules`, or editor droppings.
//
// Hardening (Gate 2):
// - every source path is canonicalized (`realpath`) and must stay inside the
//   plugin root; `..`, absolute paths, and symlink escapes fail closed.
// - every staged target (`manifest.json`, `dist/*.js`, CSS, `assets/*`) is
//   tracked for uniqueness (exact + case-folded); any collision fails.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BuildResult } from "./build";

export class StagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingError";
  }
}

function readJsonFile(p: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new StagingError(`cannot read ${p}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new StagingError(`${p} is not valid JSON: ${(e as Error).message}`);
  }
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function canonicalRoot(pluginDirAbs: string): string {
  try {
    return fs.realpathSync(path.resolve(pluginDirAbs));
  } catch (e) {
    throw new StagingError(`plugin directory not found: ${path.resolve(pluginDirAbs)} (${(e as Error).message}).`);
  }
}

/** Canonicalize `src` and require it to stay inside `root` (fails closed). */
function canonicalWithinRoot(rootReal: string, srcAbs: string, what: string): string {
  let real: string;
  try {
    real = fs.realpathSync(srcAbs);
  } catch {
    throw new StagingError(`${what} not found: ${srcAbs}.`);
  }
  const rel = path.relative(rootReal, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new StagingError(
      `${what} escapes the plugin root: ${srcAbs} (resolves to ${real}; root is ${rootReal}).`,
    );
  }
  return real;
}

/** Reject unsafe staged target names (absolute, `..`, drive/UNC, empty). */
function assertSafeTargetRel(relPosix: string, what: string): void {
  if (!relPosix || relPosix.includes("\\") || path.isAbsolute(relPosix)) {
    throw new StagingError(`${what} target is not a safe relative path: ${JSON.stringify(relPosix)}.`);
  }
  const parts = relPosix.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === "..") {
      throw new StagingError(`${what} target escapes staging: ${JSON.stringify(relPosix)}.`);
    }
    if (/^[a-zA-Z]:$/.test(seg) || seg.startsWith("\\\\")) {
      throw new StagingError(`${what} target is not portable: ${JSON.stringify(relPosix)}.`);
    }
  }
}

class TargetTracker {
  private seen = new Map<string, string>();
  add(relPosix: string, what: string): void {
    assertSafeTargetRel(relPosix, what);
    const key = relPosix;
    const folded = relPosix.toLowerCase();
    for (const [existing] of this.seen) {
      if (existing === key) {
        throw new StagingError(
          `staging target collision: ${what} wants ${JSON.stringify(relPosix)} but it is already staged (${this.seen.get(existing)}).`,
        );
      }
      if (existing.toLowerCase() === folded) {
        throw new StagingError(
          `staging target collision (case-folding): ${what} wants ${JSON.stringify(relPosix)} but ${JSON.stringify(existing)} is already staged (${this.seen.get(existing)}); refusing for case-insensitive filesystems.`,
        );
      }
    }
    this.seen.set(key, what);
  }
}

function copyDirRecursive(
  srcDirReal: string,
  destDir: string,
  tracker: TargetTracker,
  destPrefixPosix: string,
): void {
  for (const ent of fs.readdirSync(srcDirReal, { withFileTypes: true })) {
    const src = path.join(srcDirReal, ent.name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      throw new StagingError(`refusing to stage symlink: ${src} (remove it before packing).`);
    }
    const relPosix = `${destPrefixPosix}/${ent.name}`;
    if (ent.isDirectory()) {
      fs.mkdirSync(path.join(destDir, ent.name), { recursive: true });
      copyDirRecursive(src, path.join(destDir, ent.name), tracker, relPosix);
    } else if (ent.isFile()) {
      tracker.add(relPosix, `assets file ${ent.name}`);
      copyFile(src, path.join(destDir, ent.name));
    }
  }
}

/**
 * Create a minimal staging directory from a built plugin.
 *
 * - Rewrites `entry.renderer` / `entry.main` to the built `dist/*.js` paths.
 * - Copies `dist/*.js` (built), the declared `entry.css` file (when present), and `assets/`
 *   (when present). Inline `css` needs no file.
 * - `build.entries` may be empty for CSS-only plugins (pack skips the build
 *   step but staging still runs).
 * - Returns the staging dir (a fresh `mkdtemp`; the caller removes it).
 */
export function createStaging(pluginDirAbs: string, build: BuildResult): string {
  const rootReal = canonicalRoot(pluginDirAbs);
  // The manifest must be a real file inside the plugin root — never a symlink
  // (which could point outside the root and smuggle foreign content into the
  // staged artifact that Rust then packs).
  const manifestPath = path.join(rootReal, "manifest.json");
  try {
    if (fs.lstatSync(manifestPath).isSymbolicLink()) {
      throw new StagingError(`refusing to stage symlinked manifest.json: ${manifestPath}.`);
    }
  } catch (e) {
    if (e instanceof StagingError) throw e;
    throw new StagingError(`cannot read ${manifestPath}: ${(e as Error).message}`);
  }
  const manifest = readJsonFile(manifestPath);
  const entry = ((manifest.entry ?? {}) as Record<string, unknown>);

  const rewritten: Record<string, unknown> = { ...manifest };
  const newEntry: Record<string, string> = {};
  if (typeof entry.css === "string") newEntry.css = entry.css;
  for (const b of build.entries) {
    newEntry[b.key] = b.outputRel.split(path.sep).join("/");
  }
  if (typeof (manifest as Record<string, unknown>).main === "string") {
    // Top-level legacy aliases are not part of the schema; never carry them over.
  }
  if (Object.keys(newEntry).length > 0) {
    rewritten.entry = newEntry;
  } else if ("entry" in rewritten && typeof entry.css !== "string") {
    // CSS-only manifest without file entries keeps its (possibly empty) entry as-is.
    rewritten.entry = entry;
  }

  const tracker = new TargetTracker();
  tracker.add("manifest.json", "manifest.json");
  for (const b of build.entries) {
    const rel = b.outputRel.split(path.sep).join("/");
    tracker.add(rel, `built entry ${b.key}`);
  }
  if (typeof entry.css === "string") {
    tracker.add(entry.css, "entry.css");
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-stage-"));
  try {
    fs.writeFileSync(
      path.join(stage, "manifest.json"),
      JSON.stringify(rewritten, null, 2) + "\n",
      "utf8",
    );
    for (const b of build.entries) {
      const rel = b.outputRel.split(path.sep).join("/");
      // Built outputs live wherever `build` wrote them (often `<plugin>/dist`);
      // canonicalize and require containment in the plugin root.
      const srcReal = canonicalWithinRoot(rootReal, b.outputAbs, `built entry ${b.key}`);
      copyFile(srcReal, path.join(stage, ...rel.split("/")));
    }
    if (typeof entry.css === "string") {
      const cssDeclared = entry.css;
      const cssSrcAbs = path.resolve(rootReal, cssDeclared);
      let cssReal: string;
      try {
        const lst = fs.lstatSync(cssSrcAbs);
        if (lst.isSymbolicLink()) {
          throw new StagingError(`refusing to stage symlink: ${cssSrcAbs}.`);
        }
        cssReal = canonicalWithinRoot(rootReal, cssSrcAbs, "entry.css");
      } catch (e) {
        if (e instanceof StagingError) throw e;
        throw new StagingError(
          `entry.css file not found: ${cssSrcAbs} (declared as ${JSON.stringify(cssDeclared)}).`,
        );
      }
      const cssStat = fs.statSync(cssReal);
      if (!cssStat.isFile()) throw new StagingError(`entry.css is not a file: ${cssReal}.`);
      copyFile(cssReal, path.join(stage, ...cssDeclared.split("/")));
    }
    const assetsSrcAbs = path.join(rootReal, "assets");
    try {
      const st = fs.lstatSync(assetsSrcAbs);
      if (st.isSymbolicLink()) {
        throw new StagingError(`refusing to stage symlink: ${assetsSrcAbs}.`);
      }
      if (st.isDirectory()) {
        const assetsReal = canonicalWithinRoot(rootReal, assetsSrcAbs, "assets/");
        // Pre-scan asset targets for collisions before copying.
        const pending: Array<{ srcReal: string; relPosix: string }> = [];
        const walk = (dirReal: string, relPrefix: string) => {
          for (const ent of fs.readdirSync(dirReal, { withFileTypes: true })) {
            const src = path.join(dirReal, ent.name);
            const lst = fs.lstatSync(src);
            if (lst.isSymbolicLink()) {
              throw new StagingError(`refusing to stage symlink: ${src}.`);
            }
            const rel = `${relPrefix}/${ent.name}`;
            if (ent.isDirectory()) walk(src, rel);
            else if (ent.isFile()) {
              const real = canonicalWithinRoot(rootReal, src, "assets file");
              pending.push({ srcReal: real, relPosix: rel });
            }
          }
        };
        walk(assetsReal, "assets");
        for (const p of pending) tracker.add(p.relPosix, "assets file");
        for (const p of pending) {
          copyFile(p.srcReal, path.join(stage, ...p.relPosix.split("/")));
        }
      }
    } catch (e) {
      if (e instanceof StagingError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // no assets/ — fine
    }
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return stage;
}

/** Remove a staging directory (best-effort). */
export function removeStaging(stage: string): void {
  fs.rmSync(stage, { recursive: true, force: true });
}

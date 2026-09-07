// `test`: basic smoke only (Gate 2 — never authoritative).
//
// Checks, per declared JS entry (`dist/*.js` preferred, else the manifest-declared file):
// - the file exists and loads cleanly as CommonJS in an ISOLATED subprocess,
// - `module.exports.activate` / `deactivate` are functions,
// - no `exports.default` residue,
// - the pack-time renderer gate holds (`entry.renderer` requires `renderer.script`).
//
// Plugin code never runs in the CLI process (see `./isolate`): stdio is captured,
// a timeout kills hangs, and a bare `process.exit(0)` with no trusted marker fails
// closed. Passing smoke never means "valid": only `tronhawk-pack validate/pack/inspect` decides that.
// Later stages will harden this (mock-context invocation, permission matrix).

import * as fs from "node:fs";
import * as path from "node:path";

import { inspectEntryIsolated } from "./isolate";

export interface SmokeIssue {
  entry: string;
  message: string;
}

export interface SmokeResult {
  ok: boolean;
  checked: string[];
  issues: SmokeIssue[];
}

function readManifest(pluginDir: string): Record<string, unknown> {
  const p = path.join(pluginDir, "manifest.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

/** Prefer the built `dist/*.js` when it exists, else the manifest-declared file. */
function resolveCheckTarget(
  pluginDir: string,
  declaredRel: string,
  builtRel: string | undefined,
): string {
  if (builtRel) {
    const builtAbs = path.resolve(pluginDir, ...builtRel.split("/"));
    if (fs.existsSync(builtAbs)) return builtAbs;
  }
  return path.resolve(pluginDir, ...declaredRel.split("/"));
}

async function smokeOneFile(abs: string): Promise<string | null> {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return `cannot read entry: ${(e as Error).message}`;
  }
  if (/exports\s*\.\s*default\b/.test(text) || /exports\s*\[\s*["']default["']\s*\]/.test(text)) {
    return "entry exposes `exports.default` (use `module.exports = { activate, deactivate }`)";
  }
  if (/\bexport\s+default\b/.test(text)) {
    return "entry retains ESM `export default` (build to single-file CommonJS first)";
  }
  // Isolated load: never `require()` plugin code in this process.
  let shape;
  try {
    shape = await inspectEntryIsolated(abs);
  } catch (e) {
    return `entry failed the isolated load check: ${(e as Error).message}`;
  }
  if (!shape.isObject) {
    return "entry must assign an object to `module.exports`";
  }
  if (shape.hasDefault) return "entry must not export `default`";
  for (const [key, type] of [
    ["activate", shape.activateType],
    ["deactivate", shape.deactivateType],
  ] as const) {
    if (type !== "function") {
      return `entry must export \`${key}\` as a function via \`module.exports\` (got ${type})`;
    }
  }
  // Lifecycle shape (binding, see docs/PLUGIN-SDK.md): hooks take at most one arg (ctx).
  // A hook with 2+ declared params is almost certainly a signature error.
  for (const [key, arity] of [
    ["activate", shape.activateArity],
    ["deactivate", shape.deactivateArity],
  ] as const) {
    if (arity > 1) {
      return `\`${key}\` declares ${arity} params (expected 0-1: \`ctx\`)`;
    }
  }
  return null;
}

export async function smokePlugin(
  pluginDirAbs: string,
  builtOutputs?: Record<string, string>,
): Promise<SmokeResult> {
  const pluginDir = path.resolve(pluginDirAbs);
  const issues: SmokeIssue[] = [];
  const checked: string[] = [];
  let manifest: Record<string, unknown>;
  try {
    manifest = readManifest(pluginDir);
  } catch (e) {
    return { ok: false, checked, issues: [{ entry: "manifest.json", message: (e as Error).message }] };
  }
  const entry = ((manifest.entry ?? {}) as Record<string, string | undefined>);
  const permissions = (manifest.permissions ?? []) as string[];
  const jobs: Array<{ key: string; declared: string }> = [];
  if (typeof entry.renderer === "string") jobs.push({ key: "renderer", declared: entry.renderer });
  if (typeof entry.main === "string") jobs.push({ key: "main", declared: entry.main });
  if (jobs.length === 0) {
    issues.push({ entry: "manifest.json", message: "no `entry.renderer` or `entry.main` to smoke-test" });
    return { ok: false, checked, issues };
  }
  // Pack-time renderer gate (early feedback only — Rust re-checks authoritatively).
  if (typeof entry.renderer === "string" && !permissions.includes("renderer.script")) {
    issues.push({
      entry: "manifest.json",
      message:
        "an `entry.renderer` entry requires the `renderer.script` permission " +
        "(pack-time contract; runtime gate: Core `core.renderer.script_required`)",
    });
  }
  for (const job of jobs) {
    const abs = resolveCheckTarget(pluginDir, job.declared, builtOutputs?.[job.key]);
    checked.push(path.relative(pluginDir, abs) || abs);
    const problem = await smokeOneFile(abs);
    if (problem) issues.push({ entry: job.key, message: problem });
  }
  return { ok: issues.length === 0, checked, issues };
}

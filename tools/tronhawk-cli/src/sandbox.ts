// `test --sandbox`: execute built entries in the canonical QuickJS contract
// harness (Phase 2 — never authoritative).
//
// This module contains NO module/lifecycle loading semantics of its own: every
// judgment about CommonJS shape (`module.exports.activate`/`deactivate`),
// Promise draining, sync-void callbacks, and the permission-gated ctx comes
// from the canonical contract harness, which mirrors the host loader in
// `crates/runtime/js/src/index.js`. The CLI carries a byte-identical copy at
// `src/vendor/contract-harness.js` (so `--sandbox` works in tarball installs
// outside any checkout) and falls back to the checkout source for dev. The CLI
// only selects target files (built `dist/*.js` preferred, else the
// manifest-declared file — the same mapping as the smoke check), feeds sources
// + declared permissions to the harness, and formats its report.
//
// Checks, per declared JS entry:
// - the artifact exposes `activate`/`deactivate` as functions via `module.exports`,
// - no residual ESM `import`/`export` and no dynamic `require(`,
// - no Node/Electron/page globals inside the sandbox,
// - lifecycle runs (async hooks drain; throws/rejections/non-void/timeout fail),
// - permission-denied behavior (e.g. `network.request` without the grant
//   rejects catchably instead of crashing the lifecycle).
//
// CSS-only plugins (no JS entries) pass trivially with a note. Passing sandbox
// never means "valid": only `tronhawk-pack validate/pack/inspect` decides that.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { findWorkspaceRoot } from "./native";
import { cliRoot } from "./versions";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface SandboxIssue {
  entry: string;
  message: string;
}

export interface SandboxResult {
  ok: boolean;
  checked: string[];
  issues: SandboxIssue[];
  /** Captured guest log lines as `<entry> <level>: <message>`. */
  logs: string[];
  /** Human notes (e.g. CSS-only: nothing to execute). */
  notes: string[];
}

interface HarnessReport {
  ok: boolean;
  issues: string[];
  logs: Array<[string, string]>;
}

interface ContractHarness {
  CONTRACT_VERSION: number;
  runContractCheck: (opts: {
    source: string;
    permissions: string[];
    kind: "renderer" | "main";
    filename?: string;
    timeoutMs?: number;
  }) => Promise<HarnessReport>;
}

/** Absolute path of the canonical harness, or throws SandboxError. */
export function findHarness(): string {
  // 1. Copy carried with the CLI package (the `test --sandbox` standalone
  //    path: works in tarball installs outside any checkout). It is
  //    byte-identical to the canonical source (see src/vendor/README.md and
  //    the vendor-sync test), so this is the same contract either way.
  const vendored = path.join(cliRoot(), "src", "vendor", "contract-harness.js");
  if (fs.existsSync(vendored)) return vendored;
  // 2. Canonical source in a TronHawk checkout (dev fallback).
  const root = findWorkspaceRoot(cliRoot()) ?? findWorkspaceRoot(process.cwd());
  if (root) {
    const checkout = path.join(root, "crates", "runtime", "js", "src", "contract-harness.js");
    if (fs.existsSync(checkout)) return checkout;
  }
  throw new SandboxError(
    `contract harness not found (looked in the CLI package at ${vendored} and ` +
      `in a TronHawk checkout under crates/runtime/js/src). Reinstall @tronhawk/cli ` +
      `(\`test --sandbox\` ships its harness inside the package).`,
  );
}

function loadHarness(): ContractHarness {
  const harnessPath = findHarness();
  let mod: Record<string, unknown>;
  try {
    mod = createRequire(import.meta.url)(harnessPath) as Record<string, unknown>;
  } catch (e) {
    throw new SandboxError(
      `cannot load the contract harness at ${harnessPath}: ${(e as Error).message} ` +
        `(the harness needs its QuickJS runtime: run \`bun install\` in the installed ` +
        `@tronhawk/cli package dir, or \`bun install\` in crates/runtime/js for checkout dev).`,
    );
  }
  if (
    !mod ||
    mod.CONTRACT_VERSION !== 1 ||
    typeof mod.runContractCheck !== "function"
  ) {
    throw new SandboxError(
      `contract harness at ${harnessPath} has an unrecognized contract (expected CONTRACT_VERSION 1 with runContractCheck).`,
    );
  }
  return mod as unknown as ContractHarness;
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

export async function sandboxCheck(pluginDirAbs: string): Promise<SandboxResult> {
  const pluginDir = path.resolve(pluginDirAbs);
  const issues: SandboxIssue[] = [];
  const checked: string[] = [];
  const logs: string[] = [];
  const notes: string[] = [];

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (e) {
    return {
      ok: false,
      checked,
      issues: [{ entry: "manifest.json", message: (e as Error).message }],
      logs,
      notes,
    };
  }
  const entry = ((manifest.entry ?? {}) as Record<string, string | undefined>);
  const permissions = ((manifest.permissions ?? []) as string[]).filter(
    (p): p is string => typeof p === "string",
  );
  const jobs: Array<{ key: "renderer" | "main"; declared: string }> = [];
  if (typeof entry.renderer === "string") jobs.push({ key: "renderer", declared: entry.renderer });
  if (typeof entry.main === "string") jobs.push({ key: "main", declared: entry.main });
  if (jobs.length === 0) {
    notes.push("CSS-only: no JS entries, nothing to execute in the sandbox.");
    return { ok: true, checked, issues, logs, notes };
  }

  let harness: ContractHarness;
  try {
    harness = loadHarness();
  } catch (e) {
    return { ok: false, checked, issues: [{ entry: "harness", message: (e as Error).message }], logs, notes };
  }

  for (const job of jobs) {
    const base = path.basename(job.declared).replace(/\.(ts|js)$/, ".js");
    const abs = resolveCheckTarget(pluginDir, job.declared, path.posix.join("dist", base));
    const rel = path.relative(pluginDir, abs) || abs;
    checked.push(rel);
    let source: string;
    try {
      source = fs.readFileSync(abs, "utf8");
    } catch (e) {
      issues.push({ entry: job.key, message: `cannot read entry: ${(e as Error).message}` });
      continue;
    }
    let report: HarnessReport;
    try {
      report = await harness.runContractCheck({
        source,
        permissions,
        kind: job.key,
        filename: rel,
      });
    } catch (e) {
      issues.push({ entry: job.key, message: `sandbox harness failed: ${(e as Error).message}` });
      continue;
    }
    for (const [level, message] of report.logs) {
      logs.push(`${job.key} ${level}: ${message}`);
    }
    for (const problem of report.issues) {
      issues.push({ entry: job.key, message: problem });
    }
  }
  return { ok: issues.length === 0, checked, issues, logs, notes };
}

export async function cmdSandbox(pluginDir: string): Promise<number> {
  let result: SandboxResult;
  try {
    result = await sandboxCheck(pluginDir);
  } catch (e) {
    console.error(`sandbox failed: ${(e as Error).message}`);
    return 1;
  }
  for (const c of result.checked) console.log(`sandbox-checked ${c}`);
  for (const n of result.notes) console.log(`note: ${n}`);
  for (const l of result.logs) console.log(`sandbox-log ${l}`);
  if (result.ok) {
    console.log("sandbox ok (QuickJS contract; authoritative check is `tronhawk validate`)");
    return 0;
  }
  for (const issue of result.issues) {
    console.error(`sandbox failed [${issue.entry}]: ${issue.message}`);
  }
  console.error("note: sandbox is a contract check; `tronhawk validate` (Rust) decides validity.");
  return 1;
}

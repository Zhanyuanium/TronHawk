// Isolated entry-shape inspection (Gate 2 — no plugin code in the CLI process).
//
// `build.ts` / `smoke.ts` must never `require()` a plugin entry in the CLI main
// process: top-level plugin code could call `process.exit(0)` (or otherwise
// mutate the host) and bypass the authoritative Rust pack. Instead the entry is
// loaded in a one-shot `bun` subprocess with captured stdio and a timeout kill.
//
// Trust rule (exit code is NOT trusted):
// - success requires the child to exit 0 AND emit a single marker line
//   `__TRONHAWK_ENTRY_CHECK__<json>` carrying a per-call nonce and `ok: true`;
//   a bare `process.exit(0)` with no marker fails closed.
// - only the last marker line with a matching nonce is honored, so pre-existing
//   marker-looking output from the plugin cannot fake success.
// - stdout/stderr are captured (never inherited), so plugin logs never pollute
//   CLI output; stderr is only surfaced inside failure messages.

import * as crypto from "node:crypto";

export const ENTRY_CHECK_TIMEOUT_MS = 10_000;
const MARKER = "__TRONHAWK_ENTRY_CHECK__";

export class IsolatedEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolatedEntryError";
  }
}

export interface IsolatedShape {
  /** True when `module.exports` is a non-null object. */
  isObject: boolean;
  /** True when `module.exports.default !== undefined` (forbidden). */
  hasDefault: boolean;
  activateType: string;
  deactivateType: string;
  activateArity: number;
  deactivateArity: number;
}

// NOTE: this script must never contain a top-level `return` — `bun -e "return;"`
// fails with `SyntaxError: Return statements are only valid inside functions`.
// All control flow lives inside `main()` (function-internal returns only;
// the load-failure branch uses if/else so even that is explicit).
const CHECK_SCRIPT = `
async function main() {
  const target = Bun.argv[1];
  const nonce = Bun.argv[2];
  const rawWrite = process.stdout.write.bind(process.stdout);
  function emit(obj) {
    try { rawWrite(${JSON.stringify(MARKER)} + JSON.stringify({ nonce, ...obj }) + "\\n"); } catch {}
  }
  let mod;
  let loadError = null;
  try {
    const { createRequire } = require("node:module");
    const req = createRequire("file://" + process.cwd() + "/isolate-check.cjs");
    mod = req(target);
  } catch (e) {
    loadError = e;
  }
  if (loadError) {
    const e = loadError;
    emit({ ok: false, error: "entry cannot be required as CommonJS: " + (e && e.message ? e.message : String(e)) });
    process.exitCode = 1;
  } else {
    try {
      const isObject = mod !== null && typeof mod === "object";
      const hasDefault = isObject && mod.default !== undefined;
      const activateType = isObject ? typeof mod.activate : typeof undefined;
      const deactivateType = isObject ? typeof mod.deactivate : typeof undefined;
      let activateArity = -1;
      let deactivateArity = -1;
      try { if (typeof mod?.activate === "function") activateArity = mod.activate.length; } catch {}
      try { if (typeof mod?.deactivate === "function") deactivateArity = mod.deactivate.length; } catch {}
      emit({ ok: true, isObject, hasDefault, activateType, deactivateType, activateArity, deactivateArity });
    } catch (e) {
      emit({ ok: false, error: "entry inspection failed: " + (e && e.message ? e.message : String(e)) });
      process.exitCode = 1;
    }
  }
}
main();
`.trim();

function bunBin(): string {
  // The CLI always runs under bun (shebang `#!/usr/bin/env bun`); the child
  // uses the same runtime binary without a PATH lookup.
  return process.execPath;
}

function parseMarker(stdout: string, nonce: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/);
  let last: Record<string, unknown> | null = null;
  for (const line of lines) {
    const idx = line.indexOf(MARKER);
    if (idx === -1) continue;
    const payload = line.slice(idx + MARKER.length).trim();
    if (!payload) continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj.nonce !== nonce) continue;
      last = obj;
    } catch {
      // not our JSON — ignore
    }
  }
  if (!last) {
    throw new IsolatedEntryError(
      "isolated entry check produced no trusted marker (refusing to trust exit code alone; " +
        "top-level `process.exit(0)` without a marker fails closed).",
    );
  }
  return last;
}

/**
 * Load `abs` as CommonJS in an isolated subprocess and report its
 * `module.exports` shape without executing `activate`/`deactivate`.
 * Never resolves in the calling process; throws IsolatedEntryError on any
 * failure (load error, timeout, missing marker, non-zero exit).
 */
export async function inspectEntryIsolated(
  abs: string,
  opts: { timeoutMs?: number } = {},
): Promise<IsolatedShape> {
  const timeoutMs = opts.timeoutMs ?? ENTRY_CHECK_TIMEOUT_MS;
  const nonce = crypto.randomBytes(16).toString("hex");
  const proc = Bun.spawn([bunBin(), "-e", CHECK_SCRIPT, "--", abs, nonce], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(9);
    } catch {
      // already exited
    }
  }, timeoutMs);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null | undefined;
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = out;
    stderr = err;
    exitCode = code;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    throw new IsolatedEntryError(
      `isolated entry check timed out after ${timeoutMs}ms (killed; entry must load promptly).`,
    );
  }
  let marker: Record<string, unknown>;
  try {
    marker = parseMarker(stdout, nonce);
  } catch (e) {
    const tail = stderr.trim().slice(-500);
    const hint = tail ? ` stderr: ${tail}` : "";
    throw new IsolatedEntryError(`${(e as Error).message}${hint}`);
  }
  if (marker.ok !== true) {
    const detail = typeof marker.error === "string" && marker.error ? `: ${marker.error}` : "";
    const tail = stderr.trim().slice(-500);
    const hint = tail ? ` stderr: ${tail}` : "";
    throw new IsolatedEntryError(`isolated entry check failed${detail}${hint}`);
  }
  // Exit code is never sufficient alone: a marker with ok:true but a non-zero
  // exit still fails closed (the top-level had an abnormal termination).
  if (exitCode !== 0) {
    const tail = stderr.trim().slice(-500);
    const hint = tail ? ` stderr: ${tail}` : "";
    throw new IsolatedEntryError(
      `isolated entry check exited with code ${String(exitCode)} despite an ok marker (refusing to trust exit code).${hint}`,
    );
  }
  return {
    isObject: marker.isObject === true,
    hasDefault: marker.hasDefault === true,
    activateType: typeof marker.activateType === "string" ? marker.activateType : "undefined",
    deactivateType: typeof marker.deactivateType === "string" ? marker.deactivateType : "undefined",
    activateArity: typeof marker.activateArity === "number" ? marker.activateArity : -1,
    deactivateArity: typeof marker.deactivateArity === "number" ? marker.deactivateArity : -1,
  };
}

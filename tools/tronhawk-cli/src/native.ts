// Native engine resolution + verification (Gate 2 hard constraints).
//
// - JS never owns the final legitimacy decision: `validate`/`pack`/`inspect` always exec
//   the same-version Rust engine; a passing TS smoke test is never sufficient.
// - Missing binary / digest mismatch / unsupported platform => hard fail with install
//   guidance. There is NO TypeScript fallback packer (no `zip` dependency on purpose).
// - The expected engine version comes from this package's `tronhawk.engineVersion`
//   (independent from the CLI `version`); it must exactly equal `tronhawk-pack --version`
//   via an explicit assertion (never derived, never compared across kinds).
// - Resolution is limited to three trusted sources (no PATH search, in particular no
//   generic `pack` name from PATH which is trivially hijackable):
//     1. `TRONHAWK_PACK_BIN` env (explicit, highest priority),
//     2. explicit config `tronhawk.packBin` in this package's `package.json`
//        (or a `packBin` passed programmatically to `resolveNative`),
//     3. workspace `target/{release,debug}/tronhawk-pack(.exe)` (local cargo build).
// - After verification the binary bytes are materialized into a process-private
//   immutable snapshot; `version` / `pack` / `inspect` all exec the snapshot
//   (never the original path). The snapshot is re-hashed against the verified
//   digest after copying, so a swap of the original between verify and copy
//   cannot promote unverified bytes (TOCTOU closed over verify→copy→use).
// - Snapshot lifecycle: one process-private temp root per CLI process, removed
//   on process exit; a snapshot that fails verification after creation is
//   deleted immediately (RAII/finally), so failure paths leave no residue.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { cliRoot, readCliPackage } from "./versions";

/** Canonical engine binary name. The legacy `pack` alias is only runnable via an
 * explicit `TRONHAWK_PACK_BIN` / explicit config path — never auto-discovered. */
export const NATIVE_BIN_NAME = "tronhawk-pack" as const;
/** @deprecated Use NATIVE_BIN_NAME. Kept for error-message compatibility only. */
export const NATIVE_BIN_NAMES = ["tronhawk-pack"] as const;

// Platforms the standalone CLI knows how to locate a prebuilt engine for. The Rust engine
// itself builds anywhere cargo runs; this list only gates the prebuilt-lookup guidance so an
// obviously-unknown platform fails fast with a clear message instead of a confusing ENOENT.
const SUPPORTED_PLATFORM_ARCH = new Set([
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function assertPlatformSupported(): void {
  const key = currentPlatformKey();
  if (!SUPPORTED_PLATFORM_ARCH.has(key)) {
    throw new NativeError(
      `unsupported platform \`${key}\` for the prebuilt native engine ` +
        `(supported: ${[...SUPPORTED_PLATFORM_ARCH].sort().join(", ")}). ` +
        `Build the engine from source with \`cargo build -p tronhawk-package --release\` ` +
        `and point TRONHAWK_PACK_BIN at the resulting binary.`,
    );
  }
}

export class NativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeError";
  }
}

export interface NativeInfo {
  /** Absolute path to the verified engine snapshot (private temp copy). */
  path: string;
  /** Engine version reported by `<bin> --version --json` (must equal expected). */
  version: string;
  /** Host protocol default reported by the engine (`HOST_PROTOCOL_VERSION`). */
  hostProtocol: string;
  /** Where the engine was found (for diagnostics; never used for exec). */
  source: string;
}

function exeSuffix(): string {
  return process.platform === "win32" ? ".exe" : "";
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Walk up from `start` looking for the Cargo workspace root (`[workspace]` in Cargo.toml). */
export function findWorkspaceRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (;;) {
    try {
      const text = fs.readFileSync(path.join(cur, "Cargo.toml"), "utf8");
      if (/^\s*\[workspace\]/m.test(text)) return cur;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function workspaceCandidates(root: string): string[] {
  const suffix = exeSuffix();
  // Canonical name only: the legacy `pack` alias is never auto-discovered
  // (runnable only via an explicit TRONHAWK_PACK_BIN / explicit config path).
  const out: string[] = [];
  for (const profile of ["release", "debug"]) {
    out.push(path.join(root, "target", profile, `${NATIVE_BIN_NAME}${suffix}`));
  }
  return out;
}

/** Explicit config `tronhawk.packBin` in this CLI package (third trusted source). */
function explicitConfigCandidate(): string | null {
  try {
    const pkgPath = path.join(cliRoot(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      tronhawk?: { packBin?: string };
    };
    const raw = (pkg.tronhawk?.packBin ?? "").trim();
    if (!raw) return null;
    return path.resolve(cliRoot(), raw);
  } catch {
    return null;
  }
}

export function installGuidance(expected: string): string {
  return (
    `Expected the same-version native engine \`tronhawk-pack ${expected}\` ` +
    `for ${currentPlatformKey()}. ` +
    `Build it with \`cargo build -p tronhawk-package --release\` from the TronHawk repo root, ` +
    `or set TRONHAWK_PACK_BIN to the engine binary ` +
    `(e.g. <repo>/target/release/tronhawk-pack${exeSuffix()}). ` +
    `See docs/THX-FORMAT.md. ` +
    `There is no TypeScript fallback packer by design.`
  );
}

export interface LocateResult {
  path: string;
  /** Which trusted source produced the candidate (for diagnostics). */
  source: "TRONHAWK_PACK_BIN" | "explicit-config" | "explicit-arg" | "workspace";
}

/** Locate a candidate engine binary without verifying it (verification is mandatory). */
export function locateCandidate(explicitArg?: string): LocateResult | null {
  const fromArg = (explicitArg ?? "").trim();
  if (fromArg) return { path: path.resolve(fromArg), source: "explicit-arg" };

  const explicit = (process.env.TRONHAWK_PACK_BIN ?? "").trim();
  if (explicit) return { path: path.resolve(explicit), source: "TRONHAWK_PACK_BIN" };

  const configured = explicitConfigCandidate();
  if (configured) return { path: configured, source: "explicit-config" };

  const cliDir = cliRoot();
  const workspace = findWorkspaceRoot(cliDir) ?? findWorkspaceRoot(process.cwd());
  if (workspace) {
    for (const candidate of workspaceCandidates(workspace)) {
      if (isExecutableFile(candidate)) return { path: candidate, source: "workspace" };
    }
  }
  // Deliberately no PATH lookup: `Bun.which("pack")` / `which tronhawk-pack`
  // would trust whatever the ambient PATH resolves to (hijackable). All three
  // trusted sources above are explicit or repo-local.
  return null;
}

/** Back-compat helper for tests: the candidate path or null (no verification). */
export function locateCandidatePath(explicitArg?: string): string | null {
  return locateCandidate(explicitArg)?.path ?? null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function execFileSync(bin: string, args: string[]): ExecResult {
  const proc = Bun.spawnSync([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function parseVersionJson(stdout: string): { version: string; hostProtocol: string } | null {
  try {
    const v = JSON.parse(stdout) as {
      version?: string;
      host_protocol?: string;
      hostProtocol?: string;
    };
    const version = v.version;
    const hostProtocol = v.host_protocol ?? v.hostProtocol;
    if (typeof version === "string" && typeof hostProtocol === "string") {
      return { version, hostProtocol };
    }
    return null;
  } catch {
    return null;
  }
}

function parseVersionHuman(stdout: string): { version: string; hostProtocol: string } | null {
  // Human form:
  //   tronhawk-pack 0.1.1
  //   host-protocol 0.1.1
  const version = stdout.match(/^tronhawk-pack\s+(\S+)/m)?.[1];
  const hostProtocol = stdout.match(/^host-protocol\s+(\S+)/m)?.[1];
  if (version && hostProtocol) return { version, hostProtocol };
  // Tolerate the legacy `pack` bin name in the first line when the binary was
  // given explicitly (never auto-discovered under that name).
  const legacy = stdout.match(/^(?:pack|tronhawk-pack)\s+(\S+)/m)?.[1];
  if (legacy && hostProtocol) return { version: legacy, hostProtocol };
  return null;
}

/** Query `<bin> --version` (JSON first, human fallback). Throws NativeError on failure. */
export function queryNativeVersion(bin: string): { version: string; hostProtocol: string } {
  let r = execFileSync(bin, ["--version", "--json"]);
  if (r.exitCode === 0) {
    const parsed = parseVersionJson(r.stdout.trim());
    if (parsed) return parsed;
  }
  r = execFileSync(bin, ["--version"]);
  if (r.exitCode === 0) {
    const parsed = parseVersionHuman(r.stdout);
    if (parsed) return parsed;
  }
  throw new NativeError(
    `native engine at \`${bin}\` did not report a usable version ` +
      `(tried \`--version --json\` and \`--version\`). ` +
      `${installGuidance(readCliPackage().engineVersion)}`,
  );
}

function sha256File(p: string): string {
  const data = fs.readFileSync(p);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Verify the digest sidecar shipped beside the binary (`<bin>.sha256` containing
 * `<hex> [filename]`). Only a missing sidecar with ENOENT skips the check
 * (monorepo dev builds have no sidecar); an empty, malformed, or unreadable
 * (non-ENOENT) sidecar hard-fails. A present sidecar with a mismatch hard-fails.
 *
 * Returns the verified expected digest (lowercase hex), or null when there is
 * no sidecar to verify against. Callers must re-verify the snapshot itself
 * against the returned digest after copying (never trust a re-read of the
 * original — it may have been swapped in between).
 */
export function verifyDigestIfPresent(bin: string): string | null {
  const sidecar = `${bin}.sha256`;
  let text: string;
  try {
    text = fs.readFileSync(sidecar, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // dev build without a sidecar — nothing to verify
    throw new NativeError(
      `native engine digest sidecar \`${sidecar}\` cannot be read (${(e as Error).message}); ` +
        `refusing to run an unverifiable engine. ${installGuidance(readCliPackage().engineVersion)}`,
    );
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new NativeError(
      `native engine digest sidecar \`${sidecar}\` is empty (expected \`<sha256hex> [file]\`); ` +
        `refusing to run an unverifiable engine.`,
    );
  }
  const expected = trimmed.split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new NativeError(
      `native engine digest sidecar \`${sidecar}\` is malformed (expected \`<sha256hex> [file]\`).`,
    );
  }
  let actual: string;
  try {
    actual = sha256File(bin).toLowerCase();
  } catch (e) {
    throw new NativeError(
      `cannot hash native engine \`${bin}\` for digest verification (${(e as Error).message}).`,
    );
  }
  if (actual !== expected) {
    throw new NativeError(
      `native engine digest mismatch for \`${bin}\` (expected ${expected}, got ${actual}). ` +
        `Refusing to run a tampered engine. ${installGuidance(readCliPackage().engineVersion)}`,
    );
  }
  return expected;
}

/**
 * Re-verify a snapshot file against an already-verified expected digest.
 * This hashes the snapshot itself (the bytes that will actually be executed),
 * so a replacement of the original binary between verification and copy is
 * detected here. The offending snapshot file is deleted before throwing.
 */
function verifySnapshotDigest(snap: string, expectedDigest: string, originalPath: string): void {
  let actual: string;
  try {
    actual = sha256File(snap).toLowerCase();
  } catch (e) {
    removeSnapshotFile(snap);
    throw new NativeError(
      `cannot hash native engine snapshot \`${snap}\` for digest re-verification (${(e as Error).message}).`,
    );
  }
  if (actual !== expectedDigest) {
    removeSnapshotFile(snap);
    throw new NativeError(
      `native engine snapshot digest mismatch (expected ${expectedDigest}, got ${actual}): ` +
        `the original at \`${originalPath}\` changed between verification and snapshotting; ` +
        `refusing to run. ${installGuidance(readCliPackage().engineVersion)}`,
    );
  }
}

/**
 * Process-private temp root for engine snapshots. Created lazily on first use
 * and removed when the CLI process exits, so successful resolutions (whose
 * snapshot must outlive `resolveNative` — the caller execs it afterwards) are
 * still cleaned up. Snapshots that fail verification after creation are
 * deleted immediately at the failure site (see `resolveNative`).
 */
const ENGINE_SNAPSHOT_ROOT_PREFIX = "tronhawk-engines-";
let engineTempRoot: string | null = null;
let snapshotSeq = 0;

function engineTempRootDir(): string {
  if (engineTempRoot) return engineTempRoot;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), ENGINE_SNAPSHOT_ROOT_PREFIX));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows ignores POSIX modes — the per-user temp dir is still private.
  }
  engineTempRoot = dir;
  process.once("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort: the OS reclaims temp eventually.
    }
  });
  return dir;
}

/** Best-effort deletion of one snapshot file (failure paths must not leak). */
function removeSnapshotFile(snap: string): void {
  try {
    fs.rmSync(snap, { force: true });
  } catch {
    // ignore — reporting the original failure matters more.
  }
}

/**
 * Test-only hook invoked after digest verification, before snapshotting.
 * Lets the TOCTOU regression test swap the original file inside the former
 * race window deterministically. Always null in production.
 */
let afterVerifyHookForTest: ((originalPath: string) => void) | null = null;

/** @internal Test seam for the verify→copy race regression test. */
export function __setAfterVerifyHookForTest(
  fn: ((originalPath: string) => void) | null,
): void {
  afterVerifyHookForTest = fn;
}

/** @internal List live snapshot files (for the no-residue regression test). */
export function __listEngineSnapshotFilesForTest(): string[] {
  if (!engineTempRoot) return [];
  try {
    return fs
      .readdirSync(engineTempRoot)
      .map((n) => path.join(engineTempRoot as string, n));
  } catch {
    return [];
  }
}

/** @internal Remove the engine temp root now (exercises the exit-cleanup path). */
export function __cleanupEngineTempForTest(): void {
  if (!engineTempRoot) return;
  const dir = engineTempRoot;
  engineTempRoot = null;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Copy a verified binary to a process-private immutable snapshot and return the
 * snapshot path. All subsequent execs (`version` / `pack` / `inspect`) use the
 * snapshot, never the original path. The snapshot lives under the
 * process-private temp root (removed on process exit); callers must not delete
 * it while it may still be exec'd. On copy/verification failure the partial
 * snapshot is deleted before throwing.
 */
function snapshotBinary(verifiedPath: string): string {
  const root = engineTempRootDir();
  const base = path.basename(verifiedPath);
  snapshotSeq += 1;
  const snap = path.join(root, `snap-${process.pid}-${snapshotSeq}-${base}`);
  try {
    fs.copyFileSync(verifiedPath, snap);
    try {
      fs.chmodSync(snap, 0o700);
    } catch {
      // ignore on Windows
    }
    // Copy-fidelity check: the snapshot must be bit-identical to what was read
    // from the original just now. (Digest re-verification against the expected
    // digest happens separately in `resolveNative` — that is what closes the
    // verify→copy race; this check only catches copy corruption.)
    const before = sha256File(verifiedPath);
    const after = sha256File(snap);
    if (before !== after) {
      throw new NativeError(
        `native engine snapshot verification failed for \`${verifiedPath}\` (copy mismatch); refusing to run.`,
      );
    }
    return snap;
  } catch (e) {
    removeSnapshotFile(snap);
    throw e;
  }
}

/**
 * Resolve + fully verify the native engine (Gate 2). Throws NativeError (hard fail) when the
 * binary is missing, the platform is unsupported, the digest mismatches, or the reported
 * version differs from this CLI's expected `tronhawk.engineVersion` (explicit assertion).
 * Returns the snapshot path — callers must exec `info.path`, never the original.
 */
export function resolveNative(opts: { packBin?: string } = {}): NativeInfo {
  assertPlatformSupported();
  const { engineVersion: expected } = readCliPackage();
  const found = locateCandidate(opts.packBin);
  if (!found) {
    throw new NativeError(`native engine not found. ${installGuidance(expected)}`);
  }
  if (!isExecutableFile(found.path)) {
    const where =
      found.source === "TRONHAWK_PACK_BIN"
        ? "TRONHAWK_PACK_BIN points at a missing file"
        : found.source === "explicit-config"
          ? "explicit config `tronhawk.packBin` points at a missing file"
          : found.source === "explicit-arg"
            ? "explicit --pack-bin points at a missing file"
            : "workspace candidate is missing";
    throw new NativeError(
      `native engine not found at \`${found.path}\` (${where}). ` + installGuidance(expected),
    );
  }
  const expectedDigest = verifyDigestIfPresent(found.path);
  // Test seam: the TOCTOU regression test swaps the original here, inside the
  // former verify→copy race window. Production always runs with a null hook.
  try {
    afterVerifyHookForTest?.(found.path);
  } catch (e) {
    throw new NativeError(
      `native engine post-verify hook failed for \`${found.path}\` (${(e as Error).message}).`,
    );
  }
  // Snapshot the (possibly just swapped) original, then re-verify the snapshot
  // bytes themselves against the digest captured above. A swap is therefore
  // detected here — the snapshot can only ever contain verified bytes.
  const snap = snapshotBinary(found.path);
  try {
    if (expectedDigest) verifySnapshotDigest(snap, expectedDigest, found.path);
    // The sidecar (if any) belongs to the original; the snapshot was just
    // re-verified against its digest, so no second sidecar lookup is needed.
    // Snapshot before version query so even `--version` runs against the
    // immutable copy.
    const reported = queryNativeVersion(snap);
    if (reported.version !== expected) {
      throw new NativeError(
        `native engine version mismatch: found \`${reported.version}\` at \`${found.path}\` ` +
          `but this CLI (@tronhawk/cli) requires exactly \`${expected}\` (same-version engine rule). ` +
          installGuidance(expected),
      );
    }
    return { path: snap, version: reported.version, hostProtocol: reported.hostProtocol, source: found.source };
  } catch (e) {
    // Failure after the snapshot exists: delete it so failed resolutions
    // (digest re-verify, version query, version mismatch) leave no residue.
    // Live snapshots from successful resolutions are removed on process exit.
    removeSnapshotFile(snap);
    throw e;
  }
}

/** Exec the verified engine snapshot with captured stdio (for validate/pack/inspect). */
export function runNativeVerified(bin: string, args: string[]): ExecResult {
  return execFileSync(bin, args);
}

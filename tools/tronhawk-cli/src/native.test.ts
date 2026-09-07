import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  __cleanupEngineTempForTest,
  __listEngineSnapshotFilesForTest,
  __setAfterVerifyHookForTest,
  installGuidance,
  locateCandidate,
  queryNativeVersion,
  resolveNative,
} from "./native";
import { readCliPackage } from "./versions";

test("native guidance names the fix (no silent fallback)", () => {
  const msg = installGuidance("0.1.0");
  expect(msg).toContain("TRONHAWK_PACK_BIN");
  expect(msg).toContain("cargo build -p tronhawk-package");
  expect(msg.toLowerCase()).toContain("no typescript fallback");
});

// Engine-dependent tests: the ts job runs on a pure-bun runner with no
// `cargo build` (no target/{debug,release}/tronhawk-pack). Skip cleanly when
// no candidate resolves via the trusted sources (TRONHAWK_PACK_BIN /
// explicit config / workspace); the e2e acceptance gate builds the release
// engine and exercises the same paths. No hardcoded paths: the probe reuses
// locateCandidate() so every platform resolves identically.
//
// NOTE: bun:test `skipIf` is curried — `test.skipIf(cond)("name", fn)`.
// Passing (cond, name, fn) registers nothing (silently drops the test).
const hasNativeEngine = locateCandidate() !== null;
const itWithEngine = test.skipIf(!hasNativeEngine);

itWithEngine("native candidate resolves in the monorepo (debug or release build)", () => {
  // Requires `cargo build -p tronhawk-package` (debug) to have run; the e2e gate builds it.
  const candidate = locateCandidate();
  expect(candidate).not.toBeNull();
  expect(typeof candidate!.path).toBe("string");
  expect(["TRONHAWK_PACK_BIN", "explicit-config", "explicit-arg", "workspace"]).toContain(
    candidate!.source,
  );
});

itWithEngine("same-version engine resolves and matches the expected version", () => {
  const { engineVersion } = readCliPackage();
  const native = resolveNative();
  expect(native.version).toBe(engineVersion);
  expect(native.hostProtocol).toBe("0.1.0");
});

function makeVictimEngine(): { dir: string; victim: string } {
  const candidate = locateCandidate();
  if (!candidate) throw new Error("no native engine available for the race test");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-race-"));
  const victim = path.join(
    dir,
    `victim${process.platform === "win32" ? ".exe" : ""}`,
  );
  fs.copyFileSync(candidate.path, victim);
  const digest = createHash("sha256").update(fs.readFileSync(victim)).digest("hex");
  fs.writeFileSync(`${victim}.sha256`, `${digest}  ${path.basename(victim)}\n`, "utf8");
  return { dir, victim };
}

itWithEngine("TOCTOU: swapping the original after digest verification fails closed", () => {
  const { engineVersion } = readCliPackage();
  const { dir, victim } = makeVictimEngine();
  const savedEnv = process.env.TRONHAWK_PACK_BIN;
  try {
    process.env.TRONHAWK_PACK_BIN = victim;
    // Sanity: the unswapped victim resolves.
    const good = resolveNative();
    expect(good.version).toBe(engineVersion);
    // Arm the swap inside the former verify→copy race window: append inert
    // overlay bytes (PE/ELF loaders ignore trailing data), so the swapped
    // binary still runs but no longer matches the verified digest.
    __setAfterVerifyHookForTest((originalPath) => {
      fs.appendFileSync(originalPath, Buffer.alloc(1024, 0));
    });
    const before = __listEngineSnapshotFilesForTest();
    let failed = false;
    try {
      resolveNative();
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/snapshot digest mismatch|changed between verification/i);
    } finally {
      __setAfterVerifyHookForTest(null);
    }
    expect(failed).toBe(true);
    // The swapped binary is still a functional engine — the pre-fix code would
    // have snapshotted and executed exactly these bytes.
    const swapped = queryNativeVersion(victim);
    expect(swapped.version).toBe(engineVersion);
    // The failed resolution deleted its in-progress snapshot: no residue.
    expect(__listEngineSnapshotFilesForTest()).toEqual(before);
  } finally {
    __setAfterVerifyHookForTest(null);
    if (savedEnv === undefined) delete process.env.TRONHAWK_PACK_BIN;
    else process.env.TRONHAWK_PACK_BIN = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

itWithEngine(
  "failed resolutions leave no snapshot residue; cleanup removes the temp root",
  () => {
  const { engineVersion } = readCliPackage();
  // Ensure the process-private temp root exists.
  const native = resolveNative();
  expect(native.version).toBe(engineVersion);
  const filesBefore = __listEngineSnapshotFilesForTest();
  expect(filesBefore.length).toBeGreaterThan(0);
  // Failure before snapshot creation (missing binary) adds nothing.
  const savedEnv = process.env.TRONHAWK_PACK_BIN;
  try {
    process.env.TRONHAWK_PACK_BIN = path.join(
      os.tmpdir(),
      `tronhawk-definitely-missing-${process.pid}.exe`,
    );
    let failed = false;
    try {
      resolveNative();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(__listEngineSnapshotFilesForTest()).toEqual(filesBefore);
  } finally {
    if (savedEnv === undefined) delete process.env.TRONHAWK_PACK_BIN;
    else process.env.TRONHAWK_PACK_BIN = savedEnv;
  }
  // The exit-cleanup path removes everything, and resolution works after it
  // (the root is recreated lazily).
  __cleanupEngineTempForTest();
  expect(__listEngineSnapshotFilesForTest()).toEqual([]);
  const again = resolveNative();
  expect(again.version).toBe(engineVersion);
});

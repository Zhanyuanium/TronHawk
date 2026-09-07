import { test, expect } from "bun:test";
import * as path from "node:path";

import { sandboxCheck } from "./sandbox";

// The CLI reuses the canonical contract harness over these fixtures — the same
// corpus the conformance runner executes (tests/plugin-conformance), so both
// runners judge identical semantics.
function repoRel(...parts: string[]): string {
  // src/sandbox.test.ts -> tools/tronhawk-cli/ -> tools/ -> repo root.
  return path.resolve(import.meta.dir, "..", "..", "..", ...parts);
}

test("sandbox passes for plugins/ui-tweaks (built artifact preferred)", async () => {
  const r = await sandboxCheck(repoRel("plugins", "ui-tweaks"));
  expect(r.issues).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.checked.length).toBeGreaterThan(0);
}, 60000);

test("sandbox fails a malicious entry (dynamic require)", async () => {
  const r = await sandboxCheck(
    repoRel("tests", "plugin-conformance", "fixtures", "fail-dynamic-require"),
  );
  expect(r.ok).toBe(false);
  expect(r.issues.map((i) => i.message).join("\n")).toContain("require");
}, 60000);

test("sandbox passes CSS-only with a note (nothing to execute)", async () => {
  const r = await sandboxCheck(
    repoRel("tests", "plugin-conformance", "fixtures", "valid-css-only"),
  );
  expect(r.ok).toBe(true);
  expect(r.checked).toEqual([]);
  expect(r.notes.join("\n")).toContain("CSS-only");
}, 60000);

test("sandbox surfaces permission-denied behavior without failing lifecycle", async () => {
  const r = await sandboxCheck(
    repoRel("tests", "plugin-conformance", "fixtures", "denied-network-caught"),
  );
  expect(r.ok).toBe(true);
  expect(r.logs.join("\n")).toContain("DENIED:network.access not granted");
}, 60000);

test("sandbox fails cleanly on a missing plugin dir", async () => {
  const r = await sandboxCheck(repoRel("does-not-exist-sandbox"));
  expect(r.ok).toBe(false);
}, 60000);

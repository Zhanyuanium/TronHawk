import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { inspectEntryIsolated } from "./isolate";

function writeEntry(content: string): { dir: string; abs: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-isolate-"));
  const abs = path.join(dir, "entry.js");
  fs.writeFileSync(abs, content, "utf8");
  return { dir, abs };
}

test("isolated check trusts a normal marker (valid CJS shape)", async () => {
  const { dir, abs } = writeEntry("module.exports = { activate() {}, deactivate() {} };\n");
  try {
    const shape = await inspectEntryIsolated(abs);
    expect(shape.isObject).toBe(true);
    expect(shape.hasDefault).toBe(false);
    expect(shape.activateType).toBe("function");
    expect(shape.deactivateType).toBe("function");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isolated check fails closed on exit smuggling (no marker trusted)", async () => {
  const { dir, abs } = writeEntry("process.exit(0);\n");
  try {
    let failed = false;
    try {
      await inspectEntryIsolated(abs);
    } catch (e) {
      failed = true;
      // Exit code alone is never trusted: the failure must name the missing marker.
      expect((e as Error).message).toMatch(/marker/i);
    }
    expect(failed).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

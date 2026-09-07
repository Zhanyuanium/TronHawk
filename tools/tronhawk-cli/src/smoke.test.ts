import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { smokePlugin } from "./smoke";

function makePlugin(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-smoke-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}

const MANIFEST = JSON.stringify({
  id: "com.example.smoke",
  name: "Smoke",
  version: "0.1.0",
  author: "A",
  tronhawk: "^0.1",
  entry: { renderer: "dist/renderer.js" },
  permissions: ["renderer.script"],
});

test("smoke passes for a valid CommonJS entry", async () => {
  const dir = makePlugin({
    "manifest.json": MANIFEST,
    "dist/renderer.js": "module.exports = { activate() {}, deactivate() {} };",
  });
  try {
    const r = await smokePlugin(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke rejects a missing deactivate and the renderer gate", async () => {
  const dir = makePlugin({
    "manifest.json": JSON.stringify({
      id: "com.example.smoke",
      name: "Smoke",
      version: "0.1.0",
      author: "A",
      tronhawk: "^0.1",
      entry: { renderer: "dist/renderer.js" },
      permissions: [],
    }),
    "dist/renderer.js": "module.exports = { activate() {} };",
  });
  try {
    const r = await smokePlugin(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke rejects exports.default residue", async () => {
  const dir = makePlugin({
    "manifest.json": MANIFEST,
    "dist/renderer.js": "exports.default = { activate() {}, deactivate() {} };",
  });
  try {
    const r = await smokePlugin(dir);
    expect(r.ok).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("smoke fails closed on process.exit(0) smuggling (no trusted marker)", async () => {
  const dir = makePlugin({
    "manifest.json": MANIFEST,
    "dist/renderer.js": "process.exit(0);",
  });
  try {
    const r = await smokePlugin(dir);
    expect(r.ok).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

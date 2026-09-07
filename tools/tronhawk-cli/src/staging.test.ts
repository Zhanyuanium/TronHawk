import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createStaging } from "./staging";

function cssOnlyManifest(): string {
  return JSON.stringify({
    id: "com.example.css-only",
    name: "Css Only",
    version: "0.1.0",
    author: "A",
    tronhawk: "^0.1",
    entry: { css: "style.css" },
    permissions: ["renderer.css"],
  });
}

test("staging refuses a symlinked manifest.json", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-stage-manifest-out-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-stage-manifest-"));
  try {
    const realManifest = path.join(outer, "manifest.json");
    fs.writeFileSync(realManifest, cssOnlyManifest(), "utf8");
    fs.writeFileSync(path.join(dir, "style.css"), "body { color: red; }\n", "utf8");
    try {
      fs.symlinkSync(realManifest, path.join(dir, "manifest.json"), "file");
    } catch (e) {
      console.warn(`skipping symlink test (cannot create symlinks here): ${(e as Error).message}`);
      return;
    }
    let failed = false;
    try {
      createStaging(dir, { pluginDir: dir, outDir: path.join(dir, "dist"), entries: [] });
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/symlink/);
    }
    expect(failed).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

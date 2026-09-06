import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildPlugin } from "./build";
import { inspectEntryIsolated } from "./isolate";

function makeTsPlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "com.example.build",
      name: "Build",
      version: "0.1.0",
      author: "A",
      tronhawk: "^0.1",
      entry: { renderer: "src/renderer.ts" },
      permissions: ["renderer.script"],
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "renderer.ts"),
    [
      "const plugin = {",
      "  activate(ctx: unknown) { void ctx; },",
      "  deactivate(ctx: unknown) { void ctx; },",
      "};",
      "export default plugin;",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

test("build bundles TS default export to single-file CJS without exports.default", async () => {
  const dir = makeTsPlugin();
  try {
    const result = await buildPlugin(dir);
    expect(result.entries.length).toBe(1);
    const out = result.entries[0].outputAbs;
    expect(fs.existsSync(out)).toBe(true);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toContain("module.exports");
    expect(text).not.toContain("exports.default");
    expect(text).not.toMatch(/require\s*\(\s*["'][^./]/);
    // Runtime shape via the isolated checker (never require() in this process).
    const shape = await inspectEntryIsolated(out);
    expect(shape.isObject).toBe(true);
    expect(shape.hasDefault).toBe(false);
    expect(shape.activateType).toBe("function");
    expect(shape.deactivateType).toBe("function");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("build rejects unresolved externals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-bad-"));
  try {
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "com.example.bad",
        name: "Bad",
        version: "0.1.0",
        author: "A",
        tronhawk: "^0.1",
        entry: { renderer: "src/renderer.ts" },
        permissions: ["renderer.script"],
      }),
      "utf8",
    );
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "renderer.ts"),
      [
        'import { foo } from "some-missing-pkg-xyz123";',
        "export default { activate() { foo(); }, deactivate() {} };",
        "",
      ].join("\n"),
      "utf8",
    );
    let failed = false;
    try {
      await buildPlugin(dir);
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/resolve|external|bundle/i);
    }
    expect(failed).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("build fails closed on process.exit(0) smuggling", async () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-exit-"));
  try {
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "com.example.exit",
        name: "Exit",
        version: "0.1.0",
        author: "A",
        tronhawk: "^0.1",
        entry: { renderer: "src/renderer.js" },
        permissions: ["renderer.script"],
      }),
      "utf8",
    );
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "renderer.js"), "process.exit(0);\n", "utf8");
    let failed = false;
    try {
      await buildPlugin(dir);
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/isolated|marker|exit/i);
    }
    expect(failed).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("build rejects an out-of-root entry before bundling (no dist output)", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-outside-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-escape-"));
  try {
    fs.writeFileSync(
      path.join(outer, "evil.js"),
      "module.exports = { activate() {}, deactivate() {} };\n",
      "utf8",
    );
    // Sibling temp dirs: reach the outside file via `..`.
    const escapeRel = `../${path.basename(outer)}/evil.js`;
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        id: "com.example.escape",
        name: "Escape",
        version: "0.1.0",
        author: "A",
        tronhawk: "^0.1",
        entry: { renderer: escapeRel },
        permissions: ["renderer.script"],
      }),
      "utf8",
    );
    let failed = false;
    try {
      await buildPlugin(dir);
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/escapes the plugin root/);
    }
    expect(failed).toBe(true);
    // Failed before bundling: nothing was materialized under dist/.
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("build refuses a symlinked manifest.json", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-manifest-out-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tronhawk-build-manifest-"));
  try {
    const manifest = JSON.stringify({
      id: "com.example.linked",
      name: "Linked",
      version: "0.1.0",
      author: "A",
      tronhawk: "^0.1",
      entry: { renderer: "src/renderer.js" },
      permissions: ["renderer.script"],
    });
    const realManifest = path.join(outer, "manifest.json");
    fs.writeFileSync(realManifest, manifest, "utf8");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "renderer.js"),
      "module.exports = { activate() {}, deactivate() {} };\n",
      "utf8",
    );
    try {
      fs.symlinkSync(realManifest, path.join(dir, "manifest.json"), "file");
    } catch (e) {
      console.warn(`skipping symlink test (cannot create symlinks here): ${(e as Error).message}`);
      return;
    }
    let failed = false;
    try {
      await buildPlugin(dir);
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

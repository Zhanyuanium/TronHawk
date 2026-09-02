// Smoke tests for create-tronhawk-plugin.
import { describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { main } from "./cli";
import {
  buildFiles,
  humanize,
  isValidPluginId,
  manifestObject,
  slugify,
  type PluginType,
} from "./scaffold";

const CLI = path.join(import.meta.dir, "cli.ts");
const AUTHOR = "Test Author";

// --- helpers ---------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "create-tronhawk-plugin-"));
}

async function runCli(
  args: string[],
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function scaffoldFor(type: PluginType): ReturnType<typeof buildFiles> {
  return buildFiles({
    slug: "my-plugin",
    displayName: "My Plugin",
    author: AUTHOR,
    type,
    version: "0.1.0",
    pluginId: "com.example.my-plugin",
    sdkSpec: "workspace:*",
  });
}

/** True when every non-blank line is a `//` comment (i.e. no executable code). */
function onlyCommentsOrBlank(content: string): boolean {
  return content
    .split("\n")
    .every((l) => l.trim() === "" || l.trim().startsWith("//"));
}

// --- unit tests (template content) -----------------------------------------

describe("slugify / humanize / id validation", () => {
  test("slugifies directory names to kebab-case", () => {
    expect(slugify("Dark Scrollbar")).toBe("dark-scrollbar");
    expect(slugify("my_plugin.v2")).toBe("my-plugin-v2");
    expect(slugify("  ALREADY-kebab  ")).toBe("already-kebab");
  });

  test("humanize turns kebab names into display names", () => {
    expect(humanize("my-cool-plugin")).toBe("My Cool Plugin");
    expect(humanize("hello")).toBe("Hello");
  });

  test("plugin id rules mirror tronhawk-package validation", () => {
    expect(isValidPluginId("com.example.my-plugin")).toBe(true);
    expect(isValidPluginId("com.example")).toBe(true);
    expect(isValidPluginId("..")).toBe(false);
    expect(isValidPluginId("Upper")).toBe(false);
    expect(isValidPluginId("has space")).toBe(false);
  });
});

describe("scaffold templates", () => {
  const types: PluginType[] = ["css", "renderer", "main"];

  for (const type of types) {
    test(`${type}: all files exist and parse as JSON where applicable`, () => {
      const files = scaffoldFor(type);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("package.json");
      expect(paths).toContain("tsconfig.json");
      expect(paths).toContain("manifest.json");
      expect(paths).toContain("README.md");
      expect(paths).toContain(".gitignore");
      expect(paths).toContain("src/renderer.ts");
      expect(paths).toContain("src/main.ts");

      for (const f of files) {
        if (f.path.endsWith(".json")) {
          expect(() => readJsonFromContent(f.content)).not.toThrow();
        }
      }
    });
  }

  test("renderer type (default) wires css + renderer entries and permissions", () => {
    const files = scaffoldFor("renderer");
    const manifest = files.find((f) => f.path === "manifest.json")!;
    const obj = JSON.parse(manifest.content) as Record<string, unknown>;
    expect(obj.entry).toEqual({
      css: "style.css",
      renderer: "src/renderer.ts",
    });
    expect(obj.permissions).toEqual(["renderer.css", "renderer.script"]);
    const renderer = files.find((f) => f.path === "src/renderer.ts")!;
    expect(renderer.content).toContain("PluginModule<RendererContext>");
    expect(renderer.content).not.toContain("// import type");
    expect(files.some((f) => f.path === "style.css")).toBe(true);
  });

  test("css type is theme-only with the renderer.css permission", () => {
    const files = scaffoldFor("css");
    const manifest = files.find((f) => f.path === "manifest.json")!;
    const obj = JSON.parse(manifest.content) as Record<string, unknown>;
    expect(obj.entry).toEqual({ css: "style.css" });
    expect(obj.permissions).toEqual(["renderer.css"]);
    expect(files.some((f) => f.path === "style.css")).toBe(true);
  });

  test("main type wires entry.main with the electron.window permission", () => {
    const files = scaffoldFor("main");
    const manifest = files.find((f) => f.path === "manifest.json")!;
    const obj = JSON.parse(manifest.content) as Record<string, unknown>;
    expect(obj.entry).toEqual({ main: "src/main.ts" });
    expect(obj.permissions).toEqual(["electron.window"]);
    const mainSrc = files.find((f) => f.path === "src/main.ts")!;
    expect(mainSrc.content).toContain("PluginModule<MainContext>");
    const renderer = files.find((f) => f.path === "src/renderer.ts")!;
    expect(onlyCommentsOrBlank(renderer.content)).toBe(true);
  });

  test("package.json carries the SDK dep, typecheck script and manifest conventions", () => {
    const files = scaffoldFor("renderer");
    const pkg = files.find((f) => f.path === "package.json")!;
    const obj = JSON.parse(pkg.content) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(obj.name).toBe("tronhawk-plugin-my-plugin");
    expect(obj.scripts.typecheck).toBe("tsc --noEmit");
    expect(obj.scripts.pack).toBeUndefined(); // packing is documented, not scripted
    expect(obj.dependencies["@tronhawk/sdk"]).toBe("workspace:*");

    const readme = files.find((f) => f.path === "README.md")!;
    expect(readme.content).toContain(
      "cargo run -p tronhawk-package --bin pack",
    );

    const manifest = files.find((f) => f.path === "manifest.json")!;
    const m = JSON.parse(manifest.content) as Record<string, unknown>;
    expect(m.id).toBe("com.example.my-plugin");
    expect(m.name).toBe("My Plugin");
    expect(m.author).toBe(AUTHOR);
    expect(m.version).toBe("0.1.0");
    expect(m.tronhawk).toBe("^0.1");
  });

  test("commented starters are syntactically valid no-op TS", () => {
    const rendererFiles = scaffoldFor("renderer");
    const mainTs = rendererFiles.find((f) => f.path === "src/main.ts")!;
    // The disabled template must contain no executable statement.
    expect(onlyCommentsOrBlank(mainTs.content)).toBe(true);

    const mainFiles = scaffoldFor("main");
    const rendererTs = mainFiles.find((f) => f.path === "src/renderer.ts")!;
    expect(onlyCommentsOrBlank(rendererTs.content)).toBe(true);

    // Disabled templates still show the starter code (commented out).
    expect(rendererTs.content).toContain("// export default plugin;");
  });
});

// --- integration tests (spawn the real CLI against temp dirs) ---------------

describe("create-tronhawk-plugin CLI (spawned)", () => {
  test("--help prints usage and exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage");
    expect(r.stdout).toContain("--type <css|renderer|main>");
  });

  test("missing target exits 2", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing <name-or-dir>");
  });

  test("unknown --type exits 2", async () => {
    const r = await runCli(["--type", "bogus", "whatever"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown --type "bogus"');
  });

  test("invalid --id exits 2", async () => {
    const tmp = makeTmpDir();
    try {
      const r = await runCli(["--id", "Bad ID", path.join(tmp, "p")]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("invalid plugin id");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("scaffolds a renderer plugin into a temp dir; manifest + sources valid", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "my-plugin");
    try {
      const r = await runCli(["--author", AUTHOR, target]);
      expect(r.stdout).toContain("Scaffolded");
      expect(r.code).toBe(0);

      const manifest = readJson(path.join(target, "manifest.json")) as {
        entry: Record<string, string>;
        permissions: string[];
      };
      expect(manifest.entry.renderer).toBe("src/renderer.ts");
      expect(manifest.entry.css).toBe("style.css");
      expect(manifest.permissions).toEqual(["renderer.css", "renderer.script"]);

      const pkg = readJson(path.join(target, "package.json")) as {
        name: string;
        dependencies: Record<string, string>;
      };
      expect(pkg.name).toBe("tronhawk-plugin-my-plugin");
      expect(pkg.dependencies["@tronhawk/sdk"]).toBeTruthy();

      // Syntactically valid source files exist.
      for (const rel of ["src/renderer.ts", "src/main.ts", "style.css", "tsconfig.json", "README.md", ".gitignore"]) {
        expect(fs.existsSync(path.join(target, rel))).toBe(true);
      }
      expect(fs.existsSync(path.join(target, "src/renderer.ts"))).toBe(true);
      const renderer = fs.readFileSync(path.join(target, "src/renderer.ts"), "utf8");
      expect(renderer).toContain("PluginModule<RendererContext>");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("scaffolds a main-type plugin with entry.main", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "win-fx");
    try {
      const r = await runCli([
        "--author", AUTHOR,
        "--type", "main",
        "--name", "Win Fx",
        "--id", "com.acme.win-fx",
        target,
      ]);
      expect(r.code).toBe(0);
      const manifest = readJson(path.join(target, "manifest.json")) as {
        id: string;
        name: string;
        entry: Record<string, string>;
        permissions: string[];
      };
      expect(manifest.id).toBe("com.acme.win-fx");
      expect(manifest.name).toBe("Win Fx");
      expect(manifest.entry.main).toBe("src/main.ts");
      expect(manifest.permissions).toEqual(["electron.window"]);
      const main = fs.readFileSync(path.join(target, "src/main.ts"), "utf8");
      expect(main).toContain("PluginModule<MainContext>");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("scaffolds a css-only theme", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "theme");
    try {
      const r = await runCli(["--author", AUTHOR, "--type", "css", target]);
      expect(r.code).toBe(0);
      const manifest = readJson(path.join(target, "manifest.json")) as {
        entry: Record<string, string>;
        permissions: string[];
      };
      expect(manifest.entry.css).toBe("style.css");
      expect(manifest.entry.renderer).toBeUndefined();
      expect(manifest.permissions).toEqual(["renderer.css"]);
      expect(fs.existsSync(path.join(target, "style.css"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--sdk overrides the dependency spec", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "p");
    try {
      const r = await runCli(["--author", AUTHOR, "--sdk", "@tronhawk/sdk@0.2.0", target]);
      expect(r.code).toBe(0);
      const pkg = readJson(path.join(target, "package.json")) as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies["@tronhawk/sdk"]).toBe("@tronhawk/sdk@0.2.0");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses a non-empty target unless --force is passed", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "occupied");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "keep.txt"), "x");
    try {
      const r = await runCli(["--author", AUTHOR, target]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--force");
      expect(fs.existsSync(path.join(target, "keep.txt"))).toBe(true);

      const r2 = await runCli(["--author", AUTHOR, "--force", target]);
      expect(r2.code).toBe(0);
      expect(fs.existsSync(path.join(target, "keep.txt"))).toBe(false);
      expect(fs.existsSync(path.join(target, "manifest.json"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses to scaffold into the current directory", async () => {
    const tmp = makeTmpDir();
    try {
      const r = await runCli(["--author", AUTHOR, tmp], tmp);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("refusing to scaffold");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("manifest produced by the CLI matches manifestObject()", () => {
    const files = buildFiles({
      slug: "x",
      displayName: "X",
      author: AUTHOR,
      type: "renderer",
      version: "0.1.0",
      pluginId: "com.example.x",
      sdkSpec: "workspace:*",
    });
    const manifest = files.find((f) => f.path === "manifest.json")!;
    const viaCli = manifestObject({
      slug: "x",
      displayName: "X",
      author: AUTHOR,
      type: "renderer",
      version: "0.1.0",
      pluginId: "com.example.x",
      sdkSpec: "workspace:*",
    });
    expect(JSON.parse(manifest.content)).toEqual(viaCli);
  });
});

function readJsonFromContent(content: string): unknown {
  return JSON.parse(content);
}

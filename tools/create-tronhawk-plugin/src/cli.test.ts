// Smoke tests for create-tronhawk-plugin.
import { describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { main } from "./cli";
import {
  DEFAULT_CLI_SPEC,
  DEFAULT_SDK_SPEC,
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
    sdkSpec: DEFAULT_SDK_SPEC,
    cliSpec: DEFAULT_CLI_SPEC,
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
      expect(paths).toContain("src/renderer.js");
      expect(paths).toContain("src/main.js");
      // One starter smoke test per scaffold so `bun run test` passes out of
      // the box (bun test exits non-zero with no test files).
      expect(paths).toContain(
        type === "renderer"
          ? "src/renderer.test.ts"
          : type === "main"
            ? "src/main.test.ts"
            : "src/theme.test.ts",
      );

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
      renderer: "src/renderer.js",
    });
    expect(obj.permissions).toEqual(["renderer.css", "renderer.script"]);
    const renderer = files.find((f) => f.path === "src/renderer.js")!;
    expect(renderer.content).toContain("module.exports");
    expect(renderer.content).toContain("activate");
    expect(renderer.content).not.toContain("\nexport default");
    expect(files.some((f) => f.path === "style.css")).toBe(true);
    // The runtime entry must never be a TS ESM file.
    expect(files.some((f) => f.path === "src/renderer.ts")).toBe(false);
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
    expect(obj.entry).toEqual({ main: "src/main.js" });
    expect(obj.permissions).toEqual(["electron.window"]);
    const mainSrc = files.find((f) => f.path === "src/main.js")!;
    expect(mainSrc.content).toContain("module.exports");
    expect(mainSrc.content).toContain("activate");
    expect(mainSrc.content).not.toContain("\nexport default");
    expect(files.some((f) => f.path === "src/main.ts")).toBe(false);
    const renderer = files.find((f) => f.path === "src/renderer.js")!;
    expect(onlyCommentsOrBlank(renderer.content)).toBe(true);
  });

  test("package.json carries the registry SDK/CLI deps plus build/typecheck/test/pack scripts", () => {
    const files = scaffoldFor("renderer");
    const pkg = files.find((f) => f.path === "package.json")!;
    const obj = JSON.parse(pkg.content) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(obj.name).toBe("tronhawk-plugin-my-plugin");
    // Entries are bundled to dist/ by the CLI; typecheck + starter test need no host.
    expect(obj.scripts.build).toBe("tronhawk build .");
    expect(obj.scripts.typecheck).toBe("tsc --noEmit");
    // `bun test` exits non-zero with no test files, so the scaffold ships a
    // starter test and a script that runs it.
    expect(obj.scripts.test).toBe("bun test");
    expect(files.some((f) => f.path === "src/renderer.test.ts")).toBe(true);
    // CLI-driven pack (staging -> single authoritative Rust pack with the
    // temp + round-trip + atomic rename inside Rust).
    // Canonical subcommand form (the bare `<dir> <out.thx>` form is deprecated).
    expect(obj.scripts.pack).toBe("tronhawk pack . my-plugin.thx");
    // Registry defaults: never a workspace: link or a local file: probe, so an
    // external plugin cannot be masked by the monorepo.
    expect(obj.dependencies["@tronhawk/sdk"]).toBe(DEFAULT_SDK_SPEC);
    expect(obj.devDependencies["@tronhawk/cli"]).toBe(DEFAULT_CLI_SPEC);
    expect(JSON.stringify(obj)).not.toContain("workspace:");
    // @types/bun backs the `bun:test` import in the starter test file.
    expect(obj.devDependencies["@types/bun"]).toBeTruthy();

    const readme = files.find((f) => f.path === "README.md")!;
    expect(readme.content).toContain("tronhawk pack");
    expect(readme.content).toContain("TRONHAWK_PACK_BIN");
    expect(readme.content).toContain(
      "cargo run -p tronhawk-package --bin tronhawk-pack",
    );
    // Unified CLI pack: the old direct-engine `tronhawk-pack pack` bypass is gone.
    expect(readme.content).not.toContain("tronhawk-pack pack");
    // Standalone-first: the monorepo cargo flow is documented only as the
    // contributor alternative; the old "cd into the plugin folder and pack
    // with ." guidance is gone.
    expect(readme.content).not.toContain("`cd` into the plugin folder");
    expect(readme.content).not.toContain("with `.` as the path");
    // Runtime entries are CommonJS .js, never TS ESM.
    expect(readme.content).toContain("src/renderer.js");
    expect(readme.content).not.toContain('"renderer": "src/renderer.ts"');
    expect(readme.content).not.toContain('"main": "src/main.ts"');

    const manifest = files.find((f) => f.path === "manifest.json")!;
    const m = JSON.parse(manifest.content) as Record<string, unknown>;
    expect(m.id).toBe("com.example.my-plugin");
    expect(m.name).toBe("My Plugin");
    expect(m.author).toBe(AUTHOR);
    expect(m.version).toBe("0.1.0");
    expect(m.tronhawk).toBe("^0.1");
  });

  test("build/pack scripts are per-type: CLI bundle for JS entries, unified CLI pack for all types", () => {
    // `tronhawk build` hard-fails with no JS entry, so CSS-only plugins use an
    // echo build — but every type packs through the unified `tronhawk pack`
    // command (CSS-only skips build explicitly, staging still runs, same-version
    // Rust/SHA path). Never invoke the engine binary directly.
    const css = scaffoldFor("css");
    const cssPkg = JSON.parse(
      css.find((f) => f.path === "package.json")!.content,
    ) as { scripts: Record<string, string> };
    expect(cssPkg.scripts.build).toContain("no build step");
    expect(cssPkg.scripts.build).not.toContain("tronhawk");
    expect(cssPkg.scripts.pack).toBe("tronhawk pack . my-plugin.thx");

    for (const type of ["renderer", "main"] as const) {
      const files = scaffoldFor(type);
      const pkg = JSON.parse(
        files.find((f) => f.path === "package.json")!.content,
      ) as { scripts: Record<string, string> };
      expect(pkg.scripts.build).toBe("tronhawk build .");
      expect(pkg.scripts.pack).toBe("tronhawk pack . my-plugin.thx");
    }
  });

  test("starter tests import SDK mocks and the active entry (no host, no globals)", () => {
    const renderer = scaffoldFor("renderer");
    const rendererTest = renderer.find((f) => f.path === "src/renderer.test.ts")!;
    expect(rendererTest.content).toContain('from "bun:test"');
    expect(rendererTest.content).toContain("createMockRendererContext");
    expect(rendererTest.content).toContain('from "./renderer.js"');

    const main = scaffoldFor("main");
    const mainTest = main.find((f) => f.path === "src/main.test.ts")!;
    expect(mainTest.content).toContain("createMockMainContext");
    expect(mainTest.content).toContain('from "./main.js"');

    const css = scaffoldFor("css");
    const themeTest = css.find((f) => f.path === "src/theme.test.ts")!;
    expect(themeTest.content).toContain("entry.css");
    expect(themeTest.content).toContain("style.css");
  });

  test("scaffolded tsconfig resolves bun:test and default-imports CJS entries", () => {
    const files = scaffoldFor("renderer");
    const tsconfig = files.find((f) => f.path === "tsconfig.json")!;
    const obj = JSON.parse(tsconfig.content) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(obj.compilerOptions.types).toEqual(["bun"]);
    expect(obj.compilerOptions.esModuleInterop).toBe(true);
    expect(obj.compilerOptions.allowJs).toBe(true);
    expect(obj.compilerOptions.checkJs).toBe(true);
  });

  test("commented starters are syntactically valid no-op JS (CommonJS)", () => {
    const rendererFiles = scaffoldFor("renderer");
    const mainJs = rendererFiles.find((f) => f.path === "src/main.js")!;
    // The disabled template must contain no executable statement.
    expect(onlyCommentsOrBlank(mainJs.content)).toBe(true);

    const mainFiles = scaffoldFor("main");
    const rendererJs = mainFiles.find((f) => f.path === "src/renderer.js")!;
    expect(onlyCommentsOrBlank(rendererJs.content)).toBe(true);

    // Disabled templates still show the starter code (commented out).
    expect(rendererJs.content).toContain("// module.exports");
    expect(rendererJs.content).not.toContain("\nexport default");
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
      expect(manifest.entry.renderer).toBe("src/renderer.js");
      expect(manifest.entry.css).toBe("style.css");
      expect(manifest.permissions).toEqual(["renderer.css", "renderer.script"]);

      const pkg = readJson(path.join(target, "package.json")) as {
        name: string;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.name).toBe("tronhawk-plugin-my-plugin");
      // Registry defaults even when scaffolded from inside a checkout: no
      // workspace: link, no local file: probe.
      expect(pkg.dependencies["@tronhawk/sdk"]).toBe(DEFAULT_SDK_SPEC);
      expect(pkg.devDependencies["@tronhawk/cli"]).toBe(DEFAULT_CLI_SPEC);
      expect(pkg.scripts.build).toBe("tronhawk build .");
      expect(pkg.scripts.test).toBe("bun test");
      expect(pkg.scripts.pack).toBe("tronhawk pack . my-plugin.thx");

      // Syntactically valid source files exist.
      for (const rel of ["src/renderer.js", "src/main.js", "src/renderer.test.ts", "style.css", "tsconfig.json", "README.md", ".gitignore"]) {
        expect(fs.existsSync(path.join(target, rel))).toBe(true);
      }
      expect(fs.existsSync(path.join(target, "src/renderer.ts"))).toBe(false);
      expect(fs.existsSync(path.join(target, "src/main.ts"))).toBe(false);
      const renderer = fs.readFileSync(path.join(target, "src/renderer.js"), "utf8");
      expect(renderer).toContain("module.exports");
      expect(renderer).not.toContain("\nexport default");
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
      expect(manifest.entry.main).toBe("src/main.js");
      expect(manifest.permissions).toEqual(["electron.window"]);
      const main = fs.readFileSync(path.join(target, "src/main.js"), "utf8");
      expect(main).toContain("module.exports");
      expect(main).not.toContain("\nexport default");
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

  test("default scaffold has no workspace: spec anywhere (no monorepo masking)", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "plain");
    try {
      const r = await runCli(["--author", AUTHOR, target]);
      expect(r.code).toBe(0);
      const raw = fs.readFileSync(path.join(target, "package.json"), "utf8");
      expect(raw).not.toContain("workspace:");
      const pkg = JSON.parse(raw) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.dependencies["@tronhawk/sdk"]).toBe(DEFAULT_SDK_SPEC);
      expect(pkg.devDependencies["@tronhawk/cli"]).toBe(DEFAULT_CLI_SPEC);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--cli overrides the CLI dependency spec", async () => {
    const tmp = makeTmpDir();
    const target = path.join(tmp, "p");
    try {
      const r = await runCli(["--author", AUTHOR, "--cli", "file:/tmp/tronhawk-cli.tgz", target]);
      expect(r.code).toBe(0);
      const pkg = readJson(path.join(target, "package.json")) as {
        devDependencies: Record<string, string>;
      };
      expect(pkg.devDependencies["@tronhawk/cli"]).toBe("file:/tmp/tronhawk-cli.tgz");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("--sdk overrides the SDK dependency spec", async () => {
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

  test("summary routes every type through the unified tronhawk pack (no direct engine, no PATH engine)", async () => {
    for (const type of ["css", "renderer", "main"] as const) {
      const tmp = makeTmpDir();
      const target = path.join(tmp, `sum-${type}`);
      try {
        const r = await runCli(["--author", AUTHOR, "--type", type, target]);
        expect(r.code).toBe(0);
        // All types share one CLI pack line (CSS skips build but keeps the
        // same-version Rust/SHA path).
        expect(r.stdout).toContain(`tronhawk pack . sum-${type}.thx`);
        // The old CSS direct-engine bypass and the PATH-engine claim are gone.
        expect(r.stdout).not.toContain("tronhawk-pack pack");
        expect(r.stdout).not.toContain("on your PATH");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
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
      sdkSpec: DEFAULT_SDK_SPEC,
      cliSpec: DEFAULT_CLI_SPEC,
    });
    const manifest = files.find((f) => f.path === "manifest.json")!;
    const viaCli = manifestObject({
      slug: "x",
      displayName: "X",
      author: AUTHOR,
      type: "renderer",
      version: "0.1.0",
      pluginId: "com.example.x",
      sdkSpec: DEFAULT_SDK_SPEC,
      cliSpec: DEFAULT_CLI_SPEC,
    });
    expect(JSON.parse(manifest.content)).toEqual(viaCli);
  });
});

function readJsonFromContent(content: string): unknown {
  return JSON.parse(content);
}

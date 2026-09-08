// File templates + content builders for scaffolded TronHawk plugins.
//
// Conventions mirrored from the in-repo example plugins (plugins/ui-tweaks,
// plugins/glass-window): a bun package that depends on
// the published `@tronhawk/sdk` registry release (types + testing helpers, no
// host runtime), strict TS settings, and a `manifest.json` whose `tronhawk`
// field is the host runtime protocol version ("^0.1"), NOT the SDK npm
// version.
//
// Runtime entries are executable CommonJS `.js` files (`module.exports = {
// activate, deactivate }`). TypeScript ESM (`export default`) is never loaded
// directly by the QuickJS host, so `entry.renderer` / `entry.main` must point
// at `.js`, never `.ts`.
//
// Standalone-first: scaffolded plugins must work OUTSIDE any monorepo
// checkout. The default `@tronhawk/sdk` spec is the npm registry release
// line (DEFAULT_SDK_SPEC); `--sdk` overrides it (e.g. a local tarball).
// Packing uses the standalone `tronhawk-pack` GitHub Release binary, never
// `cargo -p` (which needs the Cargo workspace context).

export type PluginType = "css" | "renderer" | "main";

/**
 * Default `@tronhawk/sdk` range for scaffolded plugins: the published npm
 * release line. Keep in sync with `sdk/package.json` (`version` and the
 * `tronhawk` coordination fields there).
 */
export const DEFAULT_SDK_SPEC = "^0.2.0";

/**
 * Default `@tronhawk/cli` range for scaffolded plugins: the published npm
 * release line. Keep in sync with `tools/tronhawk-cli/package.json`
 * (`version`; the CLI's `tronhawk.engineVersion` pins the matching
 * `tronhawk-pack` release binary).
 */
export const DEFAULT_CLI_SPEC = "^0.1.1";

export interface ScaffoldOptions {
  /** Directory base name slugged to kebab-case (used for ids and file names). */
  slug: string;
  /** Human-readable plugin name (manifest `name`). */
  displayName: string;
  /** Manifest `author`. */
  author: string;
  /** Starter template kind. */
  type: PluginType;
  /** Plugin version (manifest + package). */
  version: string;
  /** Reverse-DNS plugin id. */
  pluginId: string;
  /** Dependency spec for `@tronhawk/sdk` (registry range by default, e.g. "^0.2.0"; `--sdk` overrides). */
  sdkSpec: string;
  /** Dependency spec for `@tronhawk/cli` (registry range by default, e.g. "^0.1.1"; `--cli` overrides). */
  cliSpec: string;
}

export interface ScaffoldFile {
  /** Path relative to the scaffold root. */
  path: string;
  content: string;
}

// --- identifiers ---

/** Kebab-case identifier derived from a directory / plugin name. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "my-cool-plugin" -> "My Cool Plugin". */
export function humanize(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Mirrors the id rules enforced by tronhawk-package's manifest validation. */
export function isValidPluginId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  if (!/^[a-z0-9._-]+$/.test(id)) return false;
  return id.split(".").every((seg) => seg.length > 0);
}

/** Collapse newlines/whitespace so a user-supplied name is safe inside comments. */
export function sanitizeDisplayName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

// --- shared static files ---

export function tsconfigContent(): string {
  return json({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      // Default-import the CommonJS entries from the starter tests
      // (import plugin from "./renderer.js").
      esModuleInterop: true,
      // @types/bun backs `import ... from "bun:test"` in the starter tests.
      types: ["bun"],
    },
    include: ["src"],
  });
}

export function gitignoreContent(): string {
  return [
    "# Node / bun",
    "node_modules/",
    "",
    "# Build output",
    "dist/",
    "out/",
    "",
    "# Packed plugin artifact",
    "*.thx",
    "",
    "# Logs",
    "*.log",
    "",
  ].join("\n");
}

export function styleCssContent(displayName: string): string {
  return [
    `/* ${displayName} - sample page theme.`,
    "   Injected as data via the manifest entry.css field; never executed. */",
    "body { background: #111 !important; color: #eee !important; }",
    "",
  ].join("\n");
}

// --- manifest / package.json ---

function typeWord(type: PluginType): string {
  switch (type) {
    case "css":
      return "CSS-only theme";
    case "renderer":
      return "renderer plugin";
    case "main":
      return "main-process plugin";
  }
}

export function manifestObject(o: ScaffoldOptions): Record<string, unknown> {
  // Runtime entries MUST be executable CommonJS `.js` files. The QuickJS host
  // evaluates the entry with `module`/`exports` scaffolding and reads
  // `module.exports.activate`/`deactivate`; a TypeScript ESM file
  // (`export default`) exports nothing the runtime recognizes.
  const entry: Record<string, string> = {};
  if (o.type === "css" || o.type === "renderer") {
    entry.css = "style.css";
  }
  if (o.type === "renderer") {
    entry.renderer = "src/renderer.js";
  }
  if (o.type === "main") {
    entry.main = "src/main.js";
  }

  const permissions: string[] =
    o.type === "main"
      ? ["electron.window"]
      : o.type === "renderer"
        ? ["renderer.css", "renderer.script"]
        : ["renderer.css"];

  return {
    id: o.pluginId,
    name: o.displayName,
    version: o.version,
    author: o.author,
    tronhawk: "^0.1",
    entry,
    permissions,
  };
}

export function manifestContent(o: ScaffoldOptions): string {
  return json(manifestObject(o));
}

export function packageJsonObject(o: ScaffoldOptions): Record<string, unknown> {
  const scripts: Record<string, string> = {
    // CSS-only plugins ship style.css as data: nothing to bundle.
    // (`tronhawk build` hard-fails with no JS entry, so do not call it;
    // `tronhawk pack` skips the build step explicitly for CSS-only but still
    // runs staging + the same-version Rust engine.)
    build:
      o.type === "css"
        ? 'echo "no build step (CSS-only: style.css ships as data)"'
        : "tronhawk build .",
    typecheck: "tsc --noEmit",
    // Starter smoke test (src/*.test.ts) runs against @tronhawk/sdk mock
    // contexts; no host runtime required.
    test: "bun test",
    // Unified CLI pack for every type: staging -> single authoritative Rust
    // `pack` (temp + same-crate round-trip + atomic rename inside Rust).
    // Needs the same-version native engine (see README). Never call the
    // engine binary directly: only `tronhawk pack` enforces the CLI/expected-
    // engine version + digest + snapshot guarantees.
    pack: `tronhawk pack . ${o.slug}.thx`,
  };
  return {
    name: `tronhawk-plugin-${o.slug}`,
    version: o.version,
    private: true,
    scripts,
    dependencies: {
      "@tronhawk/sdk": o.sdkSpec,
    },
    devDependencies: {
      "@tronhawk/cli": o.cliSpec,
      "@types/bun": "^1.4.0",
      typescript: "^5",
    },
  };
}

export function packageJsonContent(o: ScaffoldOptions): string {
  return json(packageJsonObject(o));
}

// --- JavaScript (CommonJS) source templates ---
//
// The host loads entries as CommonJS and reads `module.exports.activate` /
// `module.exports.deactivate`. Do NOT emit `export default` here: ESM is never
// executed by the runtime. JSDoc `@type` comments keep `bun run typecheck`
// (tsc with allowJs/checkJs) validating the plain `.js` against
// `@tronhawk/sdk` without a build step.

export function rendererBody(o: ScaffoldOptions): string {
  const title = JSON.stringify(`TronHawk - ${o.displayName}`);
  return [
    `/** @type {import("@tronhawk/sdk").PluginModule<import("@tronhawk/sdk").RendererContext>} */`,
    `module.exports = {`,
    `  activate(ctx) {`,
    `    ctx.logger.info("${o.slug} activated");`,
    `    ctx.script.setDocumentTitle(${title});`,
    `  },`,
    `  deactivate(ctx) {`,
    `    ctx.logger.info("${o.slug} deactivated");`,
    `  },`,
    `};`,
    ``,
  ].join("\n");
}

export function mainBody(o: ScaffoldOptions): string {
  return [
    `/** @type {import("@tronhawk/sdk").PluginModule<import("@tronhawk/sdk").MainContext>} */`,
    `module.exports = {`,
    `  activate(ctx) {`,
    `    ctx.logger.info("${o.slug} activated");`,
    `    ctx.window.onCreated((win) => {`,
    `      ctx.logger.info("${o.slug} window created: " + win);`,
    `    });`,
    `  },`,
    `  deactivate(ctx) {`,
    `    ctx.logger.info("${o.slug} deactivated");`,
    `  },`,
    `};`,
    ``,
  ].join("\n");
}

/** Prefix every line with "// " so the code stays a syntactically valid no-op. */
function commentify(code: string, intro: string[]): string {
  const commentedIntro = intro.map((l) => (l ? `// ${l}` : "//"));
  const commentedBody = code
    .split("\n")
    .map((l) => (l === "" ? "//" : `// ${l}`));
  return [...commentedIntro, "//", ...commentedBody].join("\n") + "\n";
}

export function rendererActive(o: ScaffoldOptions): string {
  const lines = [
    `${o.displayName} - TronHawk renderer plugin (CommonJS entry).`,
    `Runs in the Chromium renderer context of TronHawk windows.`,
    `The runtime loads this file directly and reads module.exports.activate /`,
    `module.exports.deactivate; do NOT convert it to ESM (export default).`,
    `Page CSS ships as static data in style.css (manifest entry.css).`,
    `The script API below (ctx.script) requires the renderer.script permission.`,
    `See the commented src/main.js for the optional main-process template.`,
  ];
  return commentifyBody(lines, rendererBody(o));
}

function commentifyBody(banner: string[], body: string): string {
  const header = banner.map((l) => `// ${l}`).join("\n");
  return header + "\n" + body;
}

export function mainActive(o: ScaffoldOptions): string {
  const lines = [
    `${o.displayName} - TronHawk main-process plugin (CommonJS entry).`,
    `Runs in the Electron main process; only APIs covered by the declared`,
    `permissions are allowed (ctx.window needs the electron.window permission).`,
    `The runtime loads this file directly and reads module.exports.activate /`,
    `module.exports.deactivate; do NOT convert it to ESM (export default).`,
    `See the commented src/renderer.js for the optional renderer template.`,
  ];
  return commentifyBody(lines, mainBody(o));
}

export function rendererCommented(o: ScaffoldOptions): string {
  const intro = [
    `Optional renderer starter (currently commented out).`,
    `It would run in the Chromium renderer context of TronHawk windows.`,
    `The runtime entry must stay executable CommonJS (module.exports);`,
    `a TypeScript ESM file (export default) is never loaded directly.`,
    `To enable it:`,
    `  1. Uncomment the module.exports block below in src/renderer.js.`,
    `  2. In manifest.json add "renderer": "src/renderer.js" to "entry".`,
    `  3. Add the permissions your code needs (e.g. "renderer.script").`,
  ];
  return commentify(rendererBody(o), intro);
}

export function mainCommented(o: ScaffoldOptions): string {
  const intro = [
    `Optional Electron main-process starter (currently commented out).`,
    `It would run in the Electron main process and can control windows.`,
    `The runtime entry must stay executable CommonJS (module.exports);`,
    `a TypeScript ESM file (export default) is never loaded directly.`,
    `To enable it:`,
    `  1. Uncomment the module.exports block below in src/main.js.`,
    `  2. In manifest.json add "main": "src/main.js" to "entry".`,
    `  3. Add the permissions your code needs (e.g. "electron.window").`,
  ];
  return commentify(mainBody(o), intro);
}

// --- bun test starters (run against @tronhawk/sdk mocks, no host required) ---
//
// `bun test` exits non-zero when a package has no test files, so every
// scaffolded plugin ships exactly one starter smoke test for its active
// surface. The tests import only explicit modules (`bun:test`,
// `@tronhawk/sdk`, relative entries; default-imports rely on
// esModuleInterop), and `types: ["bun"]` resolves `bun:test`, so they
// typecheck under the scaffolded tsconfig with just `@types/bun` +
// `typescript` installed.

export function rendererTestContent(o: ScaffoldOptions): string {
  return [
    `// Smoke test for the ${o.slug} renderer entry (bun test, no host required).`,
    `import { describe, expect, test } from "bun:test";`,
    ``,
    `import { createMockRendererContext } from "@tronhawk/sdk";`,
    `import plugin from "./renderer.js";`,
    ``,
    `describe("renderer entry", () => {`,
    `  test("exposes activate/deactivate", () => {`,
    `    expect(typeof plugin.activate).toBe("function");`,
    `    expect(typeof plugin.deactivate).toBe("function");`,
    `  });`,
    ``,
    `  test("activate/deactivate run against a mock renderer context", () => {`,
    `    const ctx = createMockRendererContext();`,
    `    plugin.activate(ctx);`,
    `    plugin.deactivate(ctx);`,
    `  });`,
    `});`,
    ``,
  ].join("\n");
}

export function mainTestContent(o: ScaffoldOptions): string {
  return [
    `// Smoke test for the ${o.slug} main-process entry (bun test, no host required).`,
    `import { describe, expect, test } from "bun:test";`,
    ``,
    `import { createMockMainContext } from "@tronhawk/sdk";`,
    `import plugin from "./main.js";`,
    ``,
    `describe("main entry", () => {`,
    `  test("exposes activate/deactivate", () => {`,
    `    expect(typeof plugin.activate).toBe("function");`,
    `    expect(typeof plugin.deactivate).toBe("function");`,
    `  });`,
    ``,
    `  test("activate/deactivate run against a mock main context", () => {`,
    `    const ctx = createMockMainContext();`,
    `    plugin.activate(ctx);`,
    `    plugin.deactivate(ctx);`,
    `  });`,
    `});`,
    ``,
  ].join("\n");
}

export function themeTestContent(o: ScaffoldOptions): string {
  return [
    `// Smoke test for the ${o.slug} CSS-only theme (bun test, no host required).`,
    `// Uses fetch (DOM lib) so no node types are needed to read local files.`,
    `import { describe, expect, test } from "bun:test";`,
    ``,
    `describe("css theme", () => {`,
    `  test("manifest wires entry.css and the theme file is non-empty", async () => {`,
    `    const manifest = (await fetch(`,
    `      new URL("../manifest.json", import.meta.url),`,
    `    ).then((r) => r.json())) as { entry?: Record<string, string> };`,
    `    expect(manifest.entry?.css).toBe("style.css");`,
    `    const css = await fetch(new URL("../style.css", import.meta.url)).then((r) =>`,
    `      r.text(),`,
    `    );`,
    `    expect(css.trim().length).toBeGreaterThan(0);`,
    `  });`,
    `});`,
    ``,
  ].join("\n");
}

// --- README ---

export function readmeContent(o: ScaffoldOptions): string {
  const typeIntro: Record<PluginType, string> = {
    css: `${o.displayName} is a CSS-only TronHawk plugin. TronHawk injects style.css into pages as data (it is never executed as JavaScript). No renderer or main-process code is wired up yet.`,
    renderer: `${o.displayName} is a renderer plugin: page CSS ships as static data (style.css) and src/renderer.js (CommonJS, module.exports) runs in the Chromium renderer context of TronHawk windows.`,
    main: `${o.displayName} is a main-process plugin: src/main.js (CommonJS, module.exports) runs in the Electron main process and can observe and control TronHawk windows.`,
  };

  const rendererState =
    o.type === "renderer"
      ? "active CommonJS starter (wired in manifest.json)"
      : o.type === "main"
        ? "commented-out starter (enable it in manifest.json to use a renderer)"
        : "commented-out optional starter";
  const mainState =
    o.type === "main"
      ? "active CommonJS starter (wired in manifest.json)"
      : "commented-out optional starter";

  const cssLine =
    o.type === "main" ? "`style.css` - page CSS referenced by `manifest.json`" : "`style.css` - page theme injected via `manifest.json`";

  // All types pack through the unified CLI command. CSS-only skips the build
  // step explicitly (style.css ships as data) but still runs staging + the
  // same-version Rust engine; per-type build scripts still differ.
  const buildStepLine =
    o.type === "css"
      ? `# no build step (CSS-only: style.css ships as data)`
      : `bun run build          # tronhawk build .: bundle entries to dist/ (single-file CommonJS)`;
  const packStepLine = `bun run pack           # tronhawk pack . ${o.slug}.thx: ${o.type === "css" ? "staging (no build) -> Rust pack (temp + round-trip + rename inside Rust)" : "build -> staging -> Rust pack (temp + round-trip + rename inside Rust)"}`;

  const packSection = [
    `### Build, validate, pack`,
    ``,
    `The \`@tronhawk/cli\` devDependency (the \`tronhawk\` binary) drives the toolchain.`,
    `Authoritative checks always run in the same-version Rust engine`,
    `(\`tronhawk-pack\`); a passing \`build\`/\`test\` never substitutes for \`validate\`:`,
    ``,
    `\`\`\`sh`,
    `${buildStepLine}`,
    `./node_modules/.bin/tronhawk validate .    # authoritative dir check (writes nothing)`,
    `./node_modules/.bin/tronhawk test . --sandbox  # QuickJS contract harness (ships inside the CLI, no checkout needed)`,
    `${packStepLine}`,
    `./node_modules/.bin/tronhawk inspect ${o.slug}.thx   # passthrough to the Rust engine (behavior defined by Rust)`,
    `\`\`\``,
    ``,
    `How to invoke \`tronhawk\`: \`tronhawk\` is a devDependency binary (\`node_modules/.bin/tronhawk[.exe]\`), not on \`PATH\`. A bare \`tronhawk validate .\` fails with "command not found" — \`bun run <script>\` resolves \`.bin\` automatically, a bare command does not. Pick one: (1) \`./node_modules/.bin/tronhawk …\` (most reliable, used above); (2) add \`.bin\` to \`PATH\` for this shell session only; (3) put the command in \`package.json\` \`scripts\` and run \`bun run <script>\` (recommended for repeated use; \`build\`/\`pack\` already work this way). Add scripts for the commands you run often, e.g. \`{ "scripts": { "validate": "tronhawk validate .", "sandbox": "tronhawk test . --sandbox", "inspect": "tronhawk inspect ./${o.slug}.thx" } }\` then \`bun run validate\` / \`bun run sandbox\`.`,
    ``,
    `(CSS-only plugins skip the build step with an explicit notice but still run`,
    `staging; every type packs through the unified \`tronhawk pack\` command and the`,
    `same-version Rust/SHA path. Never invoke the engine binary directly: only the`,
    `CLI enforces the expected-engine version, digest, and snapshot guarantees.)`,
    `The CLI needs the native engine (same-version \`tronhawk-pack\`): set`,
    `\`TRONHAWK_PACK_BIN\` (explicit, highest priority) to the engine binary, configure \`tronhawk.packBin\` in`,
    `the CLI package, or build it inside a TronHawk checkout`,
    `(\`cargo build -p tronhawk-package --release\`, resolved from`,
    `\`target/{release,debug}/tronhawk-pack\`). Download the asset matching your`,
    `OS/arch from the TronHawk GitHub Release (e.g.`,
    `\`tronhawk-pack-x86_64-pc-windows-msvc.exe\`). The CLI's`,
    `\`tronhawk.engineVersion\` must exactly match \`tronhawk-pack --version\`;`,
    `a missing binary, digest mismatch, or version mismatch hard-fails with install`,
    `guidance — there is no TypeScript fallback packer and no PATH search for the`,
    `generic \`pack\` name.`,
    ``,
    `Alternative (inside a TronHawk monorepo checkout, from the repo root):`,
    ``,
    `\`\`\`sh`,
    `cargo run -p tronhawk-package --bin tronhawk-pack -- validate <path-to-plugin>`,
    `cargo run -p tronhawk-package --bin tronhawk-pack -- pack <path-to-plugin> ${o.slug}.thx`,
    `\`\`\``,
    ``,
    `Exit codes are a stable contract: 0 success, 1 authoritative rejection`,
    `(the message on stderr names the cause), 2 CLI usage error.`,
    `\`tronhawk pack --json\` prints exactly one JSON document (from Rust).`,
    `The engine packs every file in the plugin directory, so remove`,
    `\`node_modules\` first to keep the \`.thx\` small (then \`bun install\` to`,
    `restore); the CLI staging does this selection automatically.`,
    `The \`${o.slug}.thx\` artifact is git-ignored.`,
  ].join("\n");

  const pkgLine =
    o.type === "css"
      ? "bun package metadata; build/typecheck/test/pack scripts (no build step: CSS ships as data)"
      : "bun package metadata; build/typecheck/test/pack scripts (entries bundled to dist/)";
  const testFileName =
    o.type === "renderer"
      ? "renderer.test.ts"
      : o.type === "main"
        ? "main.test.ts"
        : "theme.test.ts";
  const testLine =
    o.type === "renderer"
      ? "renderer entry smoke test (bun test, @tronhawk/sdk mocks)"
      : o.type === "main"
        ? "main entry smoke test (bun test, @tronhawk/sdk mocks)"
        : "theme smoke test (bun test, manifest + style.css)";
  // CSS-only plugins ship style.css as data: `tronhawk build` hard-fails
  // with no JS entry, so their build script is a no-op echo. `tronhawk pack`
  // still handles them natively (skips build explicitly, staging still runs).
  // (buildStepLine/packStepLine are declared above, before packSection.)

  return [
    `# ${o.displayName}`,
    ``,
    typeIntro[o.type],
    ``,
    `Scaffolded with \`create-tronhawk-plugin\`.`,
    ``,
    `## Layout`,
    ``,
    `\`\`\``,
    `${o.slug}/`,
    `├── package.json       # ${pkgLine}`,
    `├── tsconfig.json      # strict TS settings used by \`bun run typecheck\` (no emit; checks .js via allowJs/checkJs; bun types + esModuleInterop for tests)`,
    `├── manifest.json      # TronHawk manifest: id, entry points, permissions`,
    `├── README.md`,
    `├── ${cssLine}`,
    `└── src/`,
    `    ├── renderer.js    # ${rendererState}`,
    `    ├── main.js        # ${mainState}`,
    `    └── ${testFileName}  # ${testLine}`,
    `\`\`\``,
    ``,
    `## manifest.json`,
    ``,
    `\`\`\`json`,
    `${manifestContent(o).trimEnd()}`,
    `\`\`\``,
    ``,
    `- \`id\` - unique reverse-DNS identifier (change it before publishing).`,
    `- \`name\` / \`author\` / \`version\` - display metadata; \`version\` is semver.`,
    `- \`tronhawk\` - the TronHawk **runtime protocol version** the plugin targets. This is`,
    `  NOT the \`@tronhawk/sdk\` npm version.`,
    `- \`entry\` - files the host loads. \`css\` is injected as data; \`renderer\` runs in the`,
    `  renderer context; \`main\` runs in the Electron main process. JS entries must be`,
    `  executable CommonJS (\`module.exports.activate\`/\`deactivate\`); TypeScript ESM`,
    `  (\`export default\`) is never loaded directly by the runtime.`,
    `- \`permissions\` - capabilities the plugin declares. The full list lives in the`,
    `  Permissions table of \`docs/PLUGIN-SDK.md\` in the TronHawk repo.`,
    ``,
    `## Get started`,
    ``,
    `\`\`\`sh`,
    `bun install         # @tronhawk/sdk + @tronhawk/cli + typescript from the npm registry`,
    `${buildStepLine}`,
    `bun run typecheck   # tsc --noEmit over src/ (checks .js via allowJs/checkJs)`,
    `bun test            # starter smoke test against @tronhawk/sdk mocks (no host)`,
    `\`\`\``,
    ``,
    ...(o.type === "css"
      ? [
          `There is no build step: \`style.css\` ships as data (never executed). If you add`,
          `a JS entry later, \`tronhawk build\` bundles it to \`dist/\` as single-file CommonJS.`,
        ]
      : [
          `Entries are bundled to \`dist/\` by \`tronhawk build\` (single-file CommonJS:`,
          `\`module.exports.activate\`/\`deactivate\`); do not hand them to the runtime as`,
          `TypeScript ESM (\`export default\` is never loaded directly).`,
        ]),
    ``,
    `The \`@tronhawk/sdk\` (\`${o.sdkSpec}\`) and \`@tronhawk/cli\` (\`${o.cliSpec}\`) dependencies`,
    `default to the npm registry; pass \`--sdk\` / \`--cli\` at scaffold time to override`,
    `(e.g. \`--cli file:/path/to/tronhawk-cli.tgz\` for an unpublished tarball).`,
    ``,
    `## Editing`,
    ``,
    editingSection(o),
    packSection,
    ``,
  ].join("\n");
}

function editingSection(o: ScaffoldOptions): string {
  const lines: string[] =
    o.type === "css"
      ? [
          `Put your theme in \`style.css\`. Both \`src/renderer.js\` and \`src/main.js\` hold`,
          `commented CommonJS starters: uncomment the \`module.exports\` block, add the matching \`entry\` field to`,
          `manifest.json, declare the permissions the code uses, and re-run \`bun run typecheck\`.`,
        ]
      : o.type === "renderer"
        ? [
            `Most work happens in \`src/renderer.js\` and \`style.css\`. If you only need CSS, drop`,
            `the \`renderer\` entry from manifest.json and remove \`renderer.script\` from`,
            `permissions. To add main-process behavior, enable the commented \`src/main.js\`.`,
          ]
        : [
            `Most work happens in \`src/main.js\`. If you need page CSS or renderer behavior,`,
            `add a \`style.css\` + \`renderer\` entry (or the commented \`src/renderer.js\`) and`,
            `declare the matching permissions.`,
          ];
  return lines.join("\n");
}

// --- assembly ---

/**
 * Every scaffolded plugin gets this file set; the contents vary by type so the
 * inactive context ships as a fully commented template.
 */
export function buildFiles(o: ScaffoldOptions): ScaffoldFile[] {
  const hasCss = o.type === "css" || o.type === "renderer";
  const rendererActiveFile = o.type === "renderer";
  const mainActiveFile = o.type === "main";

  const files: ScaffoldFile[] = [
    { path: ".gitignore", content: gitignoreContent() },
    { path: "README.md", content: readmeContent(o) },
    { path: "manifest.json", content: manifestContent(o) },
    { path: "package.json", content: packageJsonContent(o) },
    { path: "tsconfig.json", content: tsconfigContent() },
    {
      path: "src/renderer.js",
      content: rendererActiveFile ? rendererActive(o) : rendererCommented(o),
    },
    {
      path: "src/main.js",
      content: mainActiveFile ? mainActive(o) : mainCommented(o),
    },
  ];
  if (hasCss) {
    files.push({ path: "style.css", content: styleCssContent(o.displayName) });
  }
  // One starter smoke test per scaffold so `bun run test` passes out of the
  // box (`bun test` exits non-zero with no test files). The tests run against
  // @tronhawk/sdk mock contexts; no host runtime required.
  if (rendererActiveFile) {
    files.push({ path: "src/renderer.test.ts", content: rendererTestContent(o) });
  } else if (mainActiveFile) {
    files.push({ path: "src/main.test.ts", content: mainTestContent(o) });
  } else {
    files.push({ path: "src/theme.test.ts", content: themeTestContent(o) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function typeLabel(type: PluginType): string {
  return typeWord(type);
}

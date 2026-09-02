// File templates + content builders for scaffolded TronHawk plugins.
//
// Conventions mirrored from the in-repo example plugins (plugins/hello-world,
// plugins/ui-tweaks, plugins/window-effects): a bun package that depends on
// `@tronhawk/sdk` (types only), strict TS settings, and a `manifest.json`
// whose `tronhawk` field is the host runtime protocol version ("^0.1"), NOT
// the SDK npm version.

export type PluginType = "css" | "renderer" | "main";

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
  /** Dependency spec for `@tronhawk/sdk` (e.g. "workspace:*", "file:../.."). */
  sdkSpec: string;
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
      types: [],
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
  const entry: Record<string, string> = {};
  if (o.type === "css" || o.type === "renderer") {
    entry.css = "style.css";
  }
  if (o.type === "renderer") {
    entry.renderer = "src/renderer.ts";
  }
  if (o.type === "main") {
    entry.main = "src/main.ts";
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
    build: 'echo "no build step yet"',
    typecheck: "tsc --noEmit",
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
      typescript: "^5",
    },
  };
}

export function packageJsonContent(o: ScaffoldOptions): string {
  return json(packageJsonObject(o));
}

// --- TypeScript source templates ---

export function rendererBody(o: ScaffoldOptions): string {
  const title = JSON.stringify(`TronHawk - ${o.displayName}`);
  return [
    `import type { PluginModule, RendererContext } from "@tronhawk/sdk";`,
    "",
    `const plugin: PluginModule<RendererContext> = {`,
    `  activate(ctx: RendererContext) {`,
    `    ctx.logger.info("${o.slug} activated");`,
    `    ctx.script.setDocumentTitle(${title});`,
    `  },`,
    `  deactivate(ctx: RendererContext) {`,
    `    ctx.logger.info("${o.slug} deactivated");`,
    `  },`,
    `};`,
    ``,
    `export default plugin;`,
    ``,
  ].join("\n");
}

export function mainBody(o: ScaffoldOptions): string {
  return [
    `import type { MainContext, PluginModule } from "@tronhawk/sdk";`,
    "",
    `const plugin: PluginModule<MainContext> = {`,
    `  activate(ctx: MainContext) {`,
    `    ctx.logger.info("${o.slug} activated");`,
    `    ctx.window.onCreated((win) => {`,
    `      ctx.logger.info("${o.slug} window created: " + win);`,
    `    });`,
    `  },`,
    `  deactivate(ctx: MainContext) {`,
    `    ctx.logger.info("${o.slug} deactivated");`,
    `  },`,
    `};`,
    ``,
    `export default plugin;`,
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
    `${o.displayName} - TronHawk renderer plugin.`,
    `Runs in the Chromium renderer context of TronHawk windows.`,
    `Page CSS ships as static data in style.css (manifest entry.css).`,
    `The script API below (ctx.script) requires the renderer.script permission.`,
    `See the commented src/main.ts for the optional main-process template.`,
  ];
  return commentifyBody(lines, rendererBody(o));
}

function commentifyBody(banner: string[], body: string): string {
  const header = banner.map((l) => `// ${l}`).join("\n");
  return header + "\n" + body;
}

export function mainActive(o: ScaffoldOptions): string {
  const lines = [
    `${o.displayName} - TronHawk main-process plugin.`,
    `Runs in the Electron main process; only APIs covered by the declared`,
    `permissions are allowed (ctx.window needs the electron.window permission).`,
    `See the commented src/renderer.ts for the optional renderer template.`,
  ];
  return commentifyBody(lines, mainBody(o));
}

export function rendererCommented(o: ScaffoldOptions): string {
  const intro = [
    `Optional renderer starter (currently commented out).`,
    `It would run in the Chromium renderer context of TronHawk windows.`,
    `To enable it:`,
    `  1. Uncomment the import and the plugin module below.`,
    `  2. In manifest.json add "renderer": "src/renderer.ts" to "entry".`,
    `  3. Add the permissions your code needs (e.g. "renderer.script").`,
  ];
  return commentify(rendererBody(o), intro);
}

export function mainCommented(o: ScaffoldOptions): string {
  const intro = [
    `Optional Electron main-process starter (currently commented out).`,
    `It would run in the Electron main process and can control windows.`,
    `To enable it:`,
    `  1. Uncomment the import and the plugin module below.`,
    `  2. In manifest.json add "main": "src/main.ts" to "entry".`,
    `  3. Add the permissions your code needs (e.g. "electron.window").`,
  ];
  return commentify(mainBody(o), intro);
}

// --- README ---

export function readmeContent(o: ScaffoldOptions): string {
  const typeIntro: Record<PluginType, string> = {
    css: `${o.displayName} is a CSS-only TronHawk plugin. TronHawk injects style.css into pages as data (it is never executed as JavaScript). No renderer or main-process code is wired up yet.`,
    renderer: `${o.displayName} is a renderer plugin: page CSS ships as static data (style.css) and src/renderer.ts runs in the Chromium renderer context of TronHawk windows.`,
    main: `${o.displayName} is a main-process plugin: src/main.ts runs in the Electron main process and can observe and control TronHawk windows.`,
  };

  const rendererState =
    o.type === "renderer"
      ? "active starter (wired in manifest.json)"
      : o.type === "main"
        ? "commented-out starter (enable it in manifest.json to use a renderer)"
        : "commented-out optional starter";
  const mainState =
    o.type === "main"
      ? "active starter (wired in manifest.json)"
      : "commented-out optional starter";

  const cssLine =
    o.type === "main" ? "`style.css` - page CSS referenced by `manifest.json`" : "`style.css` - page theme injected via `manifest.json`";

  const packSection = [
    `### Pack to .thx`,
    ``,
    `Packing is handled by the Rust binary in the TronHawk repo (\`crates/package\`). From the`,
    `monorepo root, run:`,
    ``,
    `\`\`\`sh`,
    `cargo run -p tronhawk-package --bin pack -- <path-to-plugin> ${o.slug}.thx`,
    `\`\`\``,
    ``,
    `(If the plugin lives inside the monorepo, \`cd\` into the plugin folder and run the same`,
    `command with \`.\` as the path.)`,
    ``,
    `The packer validates \`manifest.json\` and its entry files, then packs every file in the`,
    `folder. It **refuses symlinks**, so remove \`node_modules\` before packing (it is only`,
    `needed for \`bun run typecheck\`), and run \`bun install\` again afterwards if you keep`,
    `developing. The \`${o.slug}.thx\` artifact is git-ignored.`,
  ].join("\n");

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
    `├── package.json       # bun package metadata; typecheck / pack scripts`,
    `├── tsconfig.json      # strict TS settings used by \`bun run typecheck\` (no emit)`,
    `├── manifest.json      # TronHawk manifest: id, entry points, permissions`,
    `├── README.md`,
    `├── ${cssLine}`,
    `└── src/`,
    `    ├── renderer.ts    # ${rendererState}`,
    `    └── main.ts        # ${mainState}`,
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
    `  renderer context; \`main\` runs in the Electron main process.`,
    `- \`permissions\` - capabilities the plugin declares. The full list lives in the`,
    `  Permissions table of \`docs/PLUGIN-SDK.md\` in the TronHawk repo.`,
    ``,
    `## Get started`,
    ``,
    `\`\`\`sh`,
    `bun install         # links @tronhawk/sdk and typescript`,
    `bun run typecheck   # tsc --noEmit over src/`,
    `\`\`\``,
    ``,
    `The \`@tronhawk/sdk\` dependency is \`${o.sdkSpec}\`${o.sdkSpec.startsWith("workspace:") ? " - run \`bun install\` from the monorepo root so the workspace link is registered." : " - bun resolves it relative to this package."}`,
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
          `Put your theme in \`style.css\`. Both \`src/renderer.ts\` and \`src/main.ts\` hold`,
          `commented starters: uncomment the code, add the matching \`entry\` field to`,
          `manifest.json, declare the permissions the code uses, and re-run \`bun run typecheck\`.`,
        ]
      : o.type === "renderer"
        ? [
            `Most work happens in \`src/renderer.ts\` and \`style.css\`. If you only need CSS, drop`,
            `the \`renderer\` entry from manifest.json and remove \`renderer.script\` from`,
            `permissions. To add main-process behavior, enable the commented \`src/main.ts\`.`,
          ]
        : [
            `Most work happens in \`src/main.ts\`. If you need page CSS or renderer behavior,`,
            `add a \`style.css\` + \`renderer\` entry (or the commented \`src/renderer.ts\`) and`,
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
      path: "src/renderer.ts",
      content: rendererActiveFile ? rendererActive(o) : rendererCommented(o),
    },
    {
      path: "src/main.ts",
      content: mainActiveFile ? mainActive(o) : mainCommented(o),
    },
  ];
  if (hasCss) {
    files.push({ path: "style.css", content: styleCssContent(o.displayName) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function typeLabel(type: PluginType): string {
  return typeWord(type);
}

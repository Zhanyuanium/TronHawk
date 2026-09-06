// Docs-contract regression guards (owner boundary: docs/PLUGIN-SDK.md, README.md,
// README_zh.md, CONTRIBUTING.md, sdk/README.md, sdk/README.zh-CN.md,
// sdk/src/lifecycle-contract.typecheck.ts, docs/adr/0008-async-host-functions.md,
// docs/BACKLOG.md). Each guard asserts the correct phrasing exists AND the stale
// phrasing is gone, so a future doc drift fails loudly.
//
// Host facts (read-only reference, verified against the implementation):
// - `ctx.webContents.*` is NOT mounted by the host (crates/runtime/js/src/index.js
//   runMainPlugin only mounts window/logger/lifecycle/config/network; the harness
//   notes "ctx.webContents.* stays unmounted: Future"); the SDK MainContext type
//   carries no `webContents` field.
// - `activate`/`deactivate` fulfill-value is IGNORED (watchAsyncActivate /
//   drainThenableResult dispose the resolved value without inspecting it).
// - Standalone `@tronhawk/cli` + same-version `tronhawk-pack` is the preferred
//   pack path (tools/create-tronhawk-plugin/README.md); the `cargo run -p`
//   monorepo flow is contributors-only.
// - `ctx.dom.observe` polls every 500 ms (crates/runtime/js/src/index.js
//   `}, 500);` in maybeStartPolling).
//
// Run with `bun test tests/docs-contract.test.js` (or `bun test tests/`) from the repo root.
const { describe, test, expect } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PLUGIN_SDK = "docs/PLUGIN-SDK.md";
const HOST_JS = "crates/runtime/js/src/index.js";

describe("docs-contract: ctx.webContents is Future / unmounted", () => {
  test("PLUGIN-SDK interface drops webContents and the body marks it future", () => {
    const doc = read(PLUGIN_SDK);
    // Correct: status table still lists it as Future, the TS interface matches the
    // SDK type deletion (no webContents), and the body calls it out as future.
    expect(doc).toContain("`ctx.webContents.*` | Future");
    expect(doc).toContain(
      "interface MainContext extends PluginContext { window; onLoad; onRendererReady; onUnload; }",
    );
    expect(doc).toContain("(future) `ctx.webContents.*`");
    // Stale: webContents presented as a usable mounted interface.
    expect(doc).not.toContain("ctx.webContents.openDevTools");
    expect(doc).not.toContain(
      "interface MainContext extends PluginContext { window; webContents;",
    );
  });
});

describe("docs-contract: activate/deactivate resolve value is ignored", () => {
  const staleResolveValue = (doc) => {
    // Stale: a fulfilled-with-value promise is rejected / must resolve to nothing.
    expect(doc).not.toContain("resolving with a value is rejected");
    expect(doc).not.toContain("must resolve to");
    expect(doc).not.toContain("rejecting a Promise of a concrete value");
    expect(doc).not.toContain("a Promise of a concrete value is not a");
  };

  test("PLUGIN-SDK says ignored, not rejected", () => {
    const doc = read(PLUGIN_SDK);
    // Correct: host ignores the fulfillment value; only rejection fails the hook.
    expect(doc).toContain("resolve value");
    expect(doc).toContain("ignored");
    expect(doc).toContain("only a rejection fails the hook");
    staleResolveValue(doc);
    // Guard against over-correction: event/observe callbacks are still sync-void
    // and their Promise return is still rejected (ADR 0008).
    expect(doc).toContain("never drains their return value");
  });

  test("SDK README (en/zh) do not reject a fulfilled resolve value", () => {
    for (const rel of ["sdk/README.md", "sdk/README.zh-CN.md"]) {
      const doc = read(rel);
      expect(doc).toContain("activate");
      expect(doc).toContain("Promise");
      staleResolveValue(doc);
    }
  });

  test("lifecycle-contract.typecheck locks ignore semantics (accepts Promise of a concrete value)", () => {
    const src = read("sdk/src/lifecycle-contract.typecheck.ts");
    expect(src).toContain("_ValuePromiseActivateAccepted");
    expect(src).toContain("_ValuePromiseDeactivateAccepted");
    expect(src).toContain(
      "IsAssignable<(ctx: MainContext) => Promise<string>, MainActivate> extends true",
    );
    expect(src).toContain(
      "IsAssignable<(ctx: MainContext) => Promise<string>, MainDeactivate> extends true",
    );
    expect(src).toContain("resolve value is ignored");
    expect(src).toContain("only a rejection fails the hook");
    expect(src).not.toContain("_ValuePromiseActivateRejected");
    expect(src).not.toContain("_ValuePromiseDeactivateRejected");
    staleResolveValue(src);
  });

  test("ADR 0008 and BACKLOG spell void | Promise<unknown> (ignore semantics)", () => {
    for (const rel of [
      "docs/adr/0008-async-host-functions.md",
      "docs/BACKLOG.md",
    ]) {
      const doc = read(rel);
      expect(doc).toContain("void | Promise<unknown>");
      expect(doc).toContain("resolve value is ignored");
      expect(doc).toContain("only a rejection fails the hook");
      expect(doc).not.toContain("void | Promise<void>");
      staleResolveValue(doc);
    }
  });
});

describe("docs-contract: standalone pack preferred, monorepo contributors-only", () => {
  test("README.md prefers standalone, no checkout-required claim", () => {
    const doc = read("README.md");
    expect(doc).toContain("standalone `@tronhawk/cli`");
    expect(doc).toContain("no TronHawk checkout needed");
    expect(doc).toContain("contributors-only alternative");
    expect(doc).not.toContain("still requires this");
  });

  test("README_zh.md prefers standalone, no checkout-required claim", () => {
    const doc = read("README_zh.md");
    expect(doc).toContain("standalone");
    expect(doc).toContain("不需要 TronHawk");
    expect(doc).toContain("仅是贡献者备选");
    expect(doc).not.toContain("需要这个 checkout");
  });

  test("CONTRIBUTING.md prefers standalone, no checkout-required claim", () => {
    const doc = read("CONTRIBUTING.md");
    expect(doc).toContain("standalone `@tronhawk/cli`");
    expect(doc).toContain("no TronHawk checkout needed");
    expect(doc).toContain("contributors-only alternative");
    expect(doc).not.toContain("still requires this");
  });
});

describe("docs-contract: dom.observe poll cadence matches host (500 ms)", () => {
  test("host polls every 500 ms", () => {
    const host = read(HOST_JS);
    // maybeStartPolling: `pollTimer = setInterval(() => { ... }, 500);`
    expect(host).toContain("pollTimer = setInterval");
    expect(host).toContain("}, 500);");
  });

  test("PLUGIN-SDK states 500 ms everywhere, no ~100 ms remains", () => {
    const doc = read(PLUGIN_SDK);
    const hits = doc.match(/500 ms cadence/g) || [];
    // Table row + Renderer API section.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(doc).not.toContain("~100 ms");
    expect(doc).not.toContain("100 ms cadence");
  });

  test("SDK README (en/zh) states 500 ms, no ~100 ms remains", () => {
    const en = read("sdk/README.md");
    expect(en).toContain("500 ms cadence");
    expect(en).not.toContain("~100 ms");
    expect(en).not.toContain("100 ms cadence");

    const zh = read("sdk/README.zh-CN.md");
    expect(zh).toContain("500ms 轮询");
    expect(zh).not.toContain("约 100ms");
    expect(zh).not.toContain("约100ms");
  });
});

// Tier-2 async host-API tests for `ctx.dom` (ADR 0008 Option B).
//
// Exercise src/index.js against a stub Electron host with real QuickJS sandboxes. `ctx.dom` is
// renderer-only and gated by `renderer.dom`; `query` snapshots the first match (serialized data,
// never a live DOM node) and `observe` re-delivers snapshots via a host-owned poll timer + diff.
// A fake contents with an injectable executeJavaScript drives both.
//
// Run with `bun test` from crates/runtime/js.
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const { EventEmitter } = require("events");

const electron = {
  BrowserWindow: { getAllWindows: () => [], fromId: () => null },
  app: new EventEmitter(),
  protocol: {},
};
mock.module("electron", () => electron);

const runtime = require("./index.js");
const testing = runtime.__testing;
const { applyPlan } = runtime;

let pluginLogs = [];
let executedSnippets = []; // captured executeJavaScript snippets
let execResults = []; // queue of executeJavaScript results (strings or null)

function pluginMessages(id, level, needle) {
  return pluginLogs.filter(
    ([pid, lvl, message]) => pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
}

const PID = "com.example.dom";
const SNAPSHOT_JSON = JSON.stringify({
  tag: "div",
  id: "app-root",
  className: "panel",
  attrs: { "data-x": "1" },
  text: "Hello",
  rect: { x: 1, y: 2, width: 100, height: 50 },
});

function planFor(revision, plugins) {
  return { revision, plugins };
}

function makeContents() {
  const contents = new EventEmitter();
  contents.id = 1;
  contents.getType = () => "window";
  contents.insertCSS = async () => "k";
  contents.removeInsertedCSS = async () => {};
  contents.isDestroyed = () => false;
  contents.executeJavaScript = async (snippet) => {
    executedSnippets.push(snippet);
    if (execResults.length > 0) return execResults.shift();
    return null;
  };
  return contents;
}

function loadRendererPlugin({ grants = ["renderer.dom"], rendererSource, revision = "r1" } = {}) {
  const contents = makeContents();
  electron.app.emit("web-contents-created", null, contents);
  applyPlan(
    planFor(revision, [
      { id: PID, version: "1", granted: grants, renderer: rendererSource, css: null, main: null },
    ]),
  );
  contents.emit("did-finish-load");
  return contents;
}

const QUERY_FIXTURE = `
module.exports = {
  activate: async (ctx) => {
    const el = await ctx.dom.query(".foo");
    ctx.logger.info("DOM-QUERY:" + (el === null ? "null" : (el.tag + ":" + el.id)));
  },
};
`;

const OBSERVE_FIXTURE = `
module.exports = {
  activate: (ctx) => {
    const disconnect = ctx.dom.observe(".bar", (node) => {
      ctx.logger.info("DOM-OBS:" + (node && node.tag));
    });
    globalThis.__disconnect = disconnect;
  },
};
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("timeout waiting for: " + what);
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  pluginLogs = [];
  executedSnippets = [];
  execResults = [];
  runtime.start(electron.app, {
    runtimeLog: () => {},
    pluginLog: (pid, level, message) => pluginLogs.push([pid, level, String(message)]),
  });
  await sleep(0);
});

afterEach(() => {
  for (const key of testing.rendererPlugins().keys()) {
    try {
      testing.rendererPlugins().get(key).deactivate();
    } catch (_e) {
      /* best effort */
    }
  }
  testing.reset();
  electron.app.removeAllListeners();
});

describe("ctx.dom (ADR 0008)", () => {
  test("query resolves a serialized DomElement snapshot (data, never a live node)", async () => {
    execResults.push(SNAPSHOT_JSON);
    const contents = loadRendererPlugin({ rendererSource: QUERY_FIXTURE });
    void contents;
    await waitFor(() => pluginMessages(PID, "info", "DOM-QUERY").length > 0, "query resolved");
    expect(pluginMessages(PID, "info", "DOM-QUERY")[0][2]).toBe("DOM-QUERY:div:app-root");
    // The executed snippet is host-owned and inserts the selector as JSON data.
    const snippets = executedSnippets.join("\n");
    expect(snippets).toContain("document.querySelector");
    expect(snippets).toContain("JSON.parse");
    expect(testing.rendererPlugins().has(`${PID}@1`)).toBe(true);
  });

  test("query resolves null when nothing matches", async () => {
    execResults.push(null);
    loadRendererPlugin({ rendererSource: QUERY_FIXTURE });
    await waitFor(() => pluginMessages(PID, "info", "DOM-QUERY").length > 0, "query resolved");
    expect(pluginMessages(PID, "info", "DOM-QUERY")[0][2]).toBe("DOM-QUERY:null");
  });

  test("observe re-delivers a snapshot via the poll timer for a new match", async () => {
    // Sequence: first poll returns null, second returns a snapshot => diff fires the callback.
    execResults.push(null, SNAPSHOT_JSON);
    const contents = loadRendererPlugin({ rendererSource: OBSERVE_FIXTURE });
    void contents;
    await waitFor(() => pluginMessages(PID, "info", "DOM-OBS").length > 0, "observe cb fired");
    expect(pluginMessages(PID, "info", "DOM-OBS").length).toBeGreaterThanOrEqual(1);
    expect(pluginMessages(PID, "info", "DOM-OBS")[0][2]).toBe("DOM-OBS:div");
  });

  test("observe is fail-closed: a throwing callback unregisters its observer", async () => {
    const THROW_FIXTURE = `
module.exports = {
  activate: (ctx) => {
    ctx.dom.observe(".nope", (node) => {
      ctx.logger.info("DOM-THROW-before");
      throw new Error("boom");
    });
  },
};
`;
    // Every poll returns a snapshot, so the callback would re-fire on each tick if it stayed
    // subscribed. Fail-closed means the first throw unregisters the observer.
    execResults.push(SNAPSHOT_JSON, SNAPSHOT_JSON, SNAPSHOT_JSON);
    const contents = loadRendererPlugin({ rendererSource: THROW_FIXTURE });
    void contents;
    await waitFor(
      () => pluginMessages(PID, "info", "DOM-THROW-before").length > 0,
      "throwing cb fired once",
    );
    await waitFor(
      () => pluginMessages(PID, "warn", "observer unregistered").length > 0,
      "fail-closed unregister logged",
    );
    // Allow a couple more ticks; the observer must NOT re-fire.
    await sleep(1200);
    expect(pluginMessages(PID, "info", "DOM-THROW-before").length).toBe(1);
  });

  test("ctx.dom is absent without the renderer.dom grant", async () => {
    const src = `module.exports = { activate: (ctx) => { ctx.logger.info("DOM-TYPEOF:" + (typeof ctx.dom)); } };`;
    loadRendererPlugin({ grants: ["renderer.script"], rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "DOM-TYPEOF").length > 0, "plugin loaded");
    expect(pluginMessages(PID, "info", "DOM-TYPEOF")[0][2]).toBe("DOM-TYPEOF:undefined");
  });
});

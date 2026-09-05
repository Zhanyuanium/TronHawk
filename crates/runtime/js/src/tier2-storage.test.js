// Tier-2 async host-API tests for `ctx.storage` (ADR 0008 Option B).
//
// These exercise src/index.js directly against a stub Electron host with real QuickJS sandboxes.
// `ctx.storage` is renderer-only and gated by `renderer.storage`; it bridges to the target page's
// localStorage through a host-owned `executeJavaScript` template (key/value are data, namespaced
// `tronhawk:<pluginId>:`). A fake contents simulates the page's localStorage semantics so get/set
// round-trips are verified end-to-end.
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
let executedSnippets = []; // captured executeJavaScript snippets (verify data-only + namespacing)
let pageStorage = {}; // fake localStorage backing store (key -> JSON string)

function pluginMessages(id, level, needle) {
  return pluginLogs.filter(
    ([pid, lvl, message]) => pid === id && (level === undefined || lvl === level) && message.includes(needle),
  );
}

const PID = "com.example.storage";
const NAMESPACE = "tronhawk:" + PID + ":";

function planFor(revision, plugins) {
  return { revision, plugins };
}

// Simulate the page's localStorage: parse the host-owned snippet's `p + <key>` access against the
// namespace-prefixed store. This mirrors the real template (`p` = the namespace prefix).
function makeContents() {
  const contents = new EventEmitter();
  contents.id = 1;
  contents.getType = () => "window";
  contents.insertCSS = async () => "k";
  contents.removeInsertedCSS = async () => {};
  contents.isDestroyed = () => false;
  contents.executeJavaScript = async (snippet) => {
    executedSnippets.push(snippet);
    const getMatch = snippet.match(/localStorage\.getItem\(p\+("(?:[^"\\]|\\.)*")\)/);
    if (getMatch) {
      const key = NAMESPACE + JSON.parse(getMatch[1]);
      return pageStorage[key] !== undefined ? JSON.parse(pageStorage[key]) : null;
    }
    const setMatch = snippet.match(/localStorage\.setItem\(p\+("(?:[^"\\]|\\.)*"),("(?:[^"\\]|\\.)*")\)/);
    if (setMatch) {
      const key = NAMESPACE + JSON.parse(setMatch[1]);
      pageStorage[key] = JSON.parse(setMatch[2]);
      return null;
    }
    return null;
  };
  return contents;
}

function loadRendererPlugin({ grants = ["renderer.storage"], rendererSource, revision = "r1" } = {}) {
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

const GET_MISSING_FIXTURE = `
module.exports = {
  activate: async (ctx) => {
    const got = await ctx.storage.get("greeting");
    ctx.logger.info("STOR-GOT:" + (got === null ? "null" : got));
  },
};
`;

const GET_SET_FIXTURE = `
module.exports = {
  activate: async (ctx) => {
    const got = await ctx.storage.get("greeting");
    ctx.logger.info("STOR-GOT:" + (got === null ? "null" : got));
    await ctx.storage.set("greeting", "hello");
    ctx.logger.info("STOR-SET-DONE");
  },
};
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for: " + what);
}

beforeEach(async () => {
  testing.reset();
  electron.app.removeAllListeners();
  pluginLogs = [];
  executedSnippets = [];
  pageStorage = {};
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

describe("ctx.storage (ADR 0008)", () => {
  test("get returns null for a missing key (host data, not JS source)", async () => {
    loadRendererPlugin({ rendererSource: GET_MISSING_FIXTURE });
    await waitFor(() => pluginMessages(PID, "info", "STOR-GOT").length > 0, "get resolved");
    expect(pluginMessages(PID, "info", "STOR-GOT")[0][2]).toBe("STOR-GOT:null");
    // The executed snippet is host-owned data: namespaced key, JSON-stringified, uses localStorage.
    const snippets = executedSnippets.join("\n");
    expect(snippets).toContain("tronhawk:" + PID + ":");
    expect(snippets).toContain('"greeting"');
    expect(snippets).toContain("localStorage.getItem");
    // Runtime loaded the plugin (rendererPlugins keyed pluginId@contentsId).
    expect(testing.rendererPlugins().has(`${PID}@1`)).toBe(true);
  });

  test("get then set round-trips through the page store; set is persisted namespaced", async () => {
    loadRendererPlugin({ rendererSource: GET_SET_FIXTURE });
    await waitFor(() => pluginMessages(PID, "info", "STOR-GOT").length > 0, "get resolved");
    await waitFor(() => pluginMessages(PID, "info", "STOR-SET-DONE").length > 0, "set completed");
    expect(pluginMessages(PID, "info", "STOR-GOT")[0][2]).toBe("STOR-GOT:null");
    // The set wrote to the namespace-prefixed page store.
    expect(pageStorage[NAMESPACE + "greeting"]).toBe(JSON.stringify("hello"));
    // The executed set snippet is a host-owned data template: the namespace is a `p` variable
    // (never a plugin-supplied literal), the key/value are JSON-stringified data, never JS source.
    const snippets = executedSnippets.join("\n");
    expect(snippets).toContain('var p="tronhawk:' + PID + ':"');
    expect(snippets).toContain("localStorage.setItem");
    expect(snippets).toContain('p+"greeting"');
    expect(snippets).toContain('"\\"hello\\""'); // the JSON-stringified value is data, not code
  });

  test("ctx.storage is absent without the renderer.storage grant", async () => {
    const src = `module.exports = { activate: (ctx) => { ctx.logger.info("STOR-TYPEOF:" + (typeof ctx.storage)); } };`;
    loadRendererPlugin({ grants: ["renderer.script"], rendererSource: src });
    await waitFor(() => pluginMessages(PID, "info", "STOR-TYPEOF").length > 0, "plugin loaded");
    expect(pluginMessages(PID, "info", "STOR-TYPEOF")[0][2]).toBe("STOR-TYPEOF:undefined");
  });
});

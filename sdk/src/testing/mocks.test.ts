import { test, expect } from "bun:test";
import type { DomElement } from "../index";
import {
  ALL_PERMISSIONS,
  ContractViolationError,
  createTestingMainContext,
  createTestingRendererContext,
} from "./index";

test("renderer mocks deny by default: no grants, no silent success", async () => {
  const { ctx, calls } = createTestingRendererContext();

  // Host parity: css insertion bridges webContents.insertCSS, so the mock API
  // is asynchronous like the host — denied calls reject.
  await expect(ctx.css.insert("body {}")).rejects.toThrow(
    /renderer\.css not granted/,
  );
  await expect(ctx.css.remove("test-style-1")).rejects.toThrow(/not granted/);
  expect(() => ctx.script.setDocumentTitle("hi")).toThrow(
    /renderer\.script not granted/,
  );
  await expect(ctx.dom.query("body")).rejects.toThrow(
    /renderer\.dom not granted/,
  );
  expect(() =>
    ctx.dom.observe("body", () => {}),
  ).toThrow(/renderer\.dom not granted/);
  await expect(ctx.storage.get("k")).rejects.toThrow(
    /renderer\.storage not granted/,
  );
  await expect(ctx.storage.set("k", "v")).rejects.toThrow(/not granted/);
  await expect(
    ctx.network.request({ url: "https://example.test/" }),
  ).rejects.toThrow(/network\.access not granted/);
  expect(ctx.raw).toBeUndefined();

  // Denied attempts are still recorded in the ordered log for auditability,
  // but none of them land in the successful-call records.
  expect(calls.ordered.length).toBeGreaterThan(0);
  expect(calls.ordered.every((c) => c.denied)).toBe(true);
  expect(calls.cssInsert).toEqual([]);
  expect(calls.domQuery).toEqual([]);
  expect(calls.scriptSetTitle).toEqual([]);
});

test("renderer mocks allow grant-by-grant: css only", async () => {
  const { ctx } = createTestingRendererContext({
    grants: ["renderer.css"],
  });

  expect(typeof (await ctx.css.insert("a {}"))).toBe("string");
  await expect(ctx.dom.query("a")).rejects.toThrow(/not granted/);
  expect(() => ctx.script.setDocumentTitle("t")).toThrow(/not granted/);
  await expect(ctx.storage.get("k")).rejects.toThrow(/not granted/);
});

test("main mocks gate window/events by electron.window", async () => {
  const { ctx, calls } = createTestingMainContext();

  // Host parity: window handles are the numeric Electron webContents ids.
  expect(() => ctx.window.setOpacity(1, 0.5)).toThrow(
    /electron\.window not granted/,
  );
  expect(() => ctx.window.setSize(1, 800, 600)).toThrow(/not granted/);
  expect(() =>
    ctx.onLoad(() => undefined),
  ).toThrow(/electron\.window not granted/);
  expect(() =>
    ctx.onRendererReady(() => undefined),
  ).toThrow(/not granted/);
  expect(() =>
    ctx.onUnload(() => undefined),
  ).toThrow(/not granted/);
  await expect(
    ctx.network.request({ url: "https://example.test/" }),
  ).rejects.toThrow(/network\.access not granted/);
  expect(ctx.raw).toBeUndefined();
  expect(calls.ordered.every((c) => c.denied)).toBe(true);

  const granted = createTestingMainContext({ grants: ["electron.window"] });
  expect(() => granted.ctx.window.setOpacity(1, 0.5)).not.toThrow();
  expect(() =>
    granted.ctx.onLoad(() => undefined),
  ).not.toThrow();
  // network.access is still missing: per-grant gating, not all-or-nothing.
  await expect(
    granted.ctx.network.request({ url: "https://example.test/" }),
  ).rejects.toThrow(/network\.access not granted/);
});

test("ctx.raw is absent without runtime.unsafe and stubbed with it", () => {
  const without = createTestingRendererContext({
    grants: ALL_PERMISSIONS.filter((p) => p !== "runtime.unsafe"),
  });
  expect(without.ctx.raw).toBeUndefined();

  const withUnsafe = createTestingRendererContext({
    grants: ["runtime.unsafe"],
  });
  expect(withUnsafe.ctx.raw).toBeDefined();

  const mainWithout = createTestingMainContext({ grants: [] });
  expect(mainWithout.ctx.raw).toBeUndefined();
  const mainWith = createTestingMainContext({ grants: ["runtime.unsafe"] });
  expect(mainWith.ctx.raw).toBeDefined();
});

test("calls record css insert/remove, dom query sequence, and script calls in order", async () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.css", "renderer.dom", "renderer.script"],
  });

  const id = await harness.ctx.css.insert("body { color: red; }");
  harness.ctx.script.setDocumentTitle("hello");
  await harness.ctx.dom.query("body");
  await harness.ctx.dom.query(".row");
  await harness.ctx.css.remove(id);
  harness.ctx.script.setDocumentTitle("bye");

  expect(harness.calls.cssInsert.map((c) => c.css)).toEqual([
    "body { color: red; }",
  ]);
  expect(typeof harness.calls.cssInsert[0]?.styleId).toBe("string");
  expect(harness.calls.cssRemove.map((c) => c.id)).toEqual([id]);
  expect(harness.calls.domQuery.map((c) => c.selector)).toEqual([
    "body",
    ".row",
  ]);
  expect(harness.calls.scriptSetTitle.map((c) => c.title)).toEqual([
    "hello",
    "bye",
  ]);
  expect(harness.calls.ordered.map((c) => c.api)).toEqual([
    "css.insert",
    "script.setDocumentTitle",
    "dom.query",
    "dom.query",
    "css.remove",
    "script.setDocumentTitle",
  ]);
  const seqs = harness.calls.ordered.map((c) => c.seq);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  expect(harness.calls.ordered.every((c) => !c.denied)).toBe(true);
});

test("storage and network records carry keys and urls", async () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.storage", "network.access"],
    storageSeed: { theme: "light" },
  });

  expect(await harness.ctx.storage.get("theme")).toBe("light");
  await harness.ctx.storage.set("theme", "dark");
  expect(await harness.ctx.storage.get("theme")).toBe("dark");
  await harness.ctx.network.request({
    url: "https://example.test/data",
    method: "GET",
  });

  expect(harness.calls.storageGet.map((c) => c.key)).toEqual([
    "theme",
    "theme",
  ]);
  expect(harness.calls.storageSet).toEqual([
    expect.objectContaining({ key: "theme", value: "dark" }),
  ]);
  expect(harness.calls.networkRequest.map((c) => c.url)).toEqual([
    "https://example.test/data",
  ]);
});

test("dom.observe disconnect stops delivery", () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.dom"],
  });
  let seen = 0;
  const disconnect = harness.ctx.dom.observe(".row", () => {
    seen++;
  });
  const node = {
    nodeId: 1,
    tag: "div",
    id: "",
    className: "row",
    attrs: {},
    text: "hi",
  };
  harness.emitDom(".row", node);
  expect(seen).toBe(1);
  disconnect();
  harness.emitDom(".row", node);
  expect(seen).toBe(1);
  expect(
    harness.calls.ordered.map((c) => c.api),
  ).toContain("dom.disconnect");
});

test("dom.observe disconnect is idempotent: repeats record nothing", () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.dom"],
  });
  const disconnect = harness.ctx.dom.observe(".row", () => {});
  disconnect();
  disconnect();
  disconnect();
  const disconnects = harness.calls.ordered.filter(
    (c) => c.api === "dom.disconnect",
  );
  expect(disconnects).toHaveLength(1);
  expect(disconnects.every((c) => !c.denied)).toBe(true);
});

test("dom.observe callback failure unregisters the observer (fail-closed)", () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.dom"],
  });
  const bad = (() => "nope") as unknown as (node: DomElement) => undefined;
  harness.ctx.dom.observe(".row", bad);
  const node = {
    nodeId: 1,
    tag: "div",
    id: "",
    className: "row",
    attrs: {},
    text: "hi",
  };
  // The violation still propagates so the test sees it…
  expect(() => harness.emitDom(".row", node)).toThrow(
    ContractViolationError,
  );
  // …but the observer is unregistered like the host does: a second emit is a
  // silent no-op instead of re-invoking the poisoned callback.
  expect(() => harness.emitDom(".row", node)).not.toThrow();
  expect(harness.domObservers[0]?.disconnected).toBe(true);
});

test("lifecycle handles flow unchanged into window ops (host parity)", () => {
  // Host parity (unified WindowHandle): the host issues BrowserWindow.id from
  // all three events when a window is bound, and every window op accepts that
  // opaque numeric. The mocks pass values through and record them; the host
  // resolves via fromId (then a contents-id scan on miss), proven end-to-end
  // in platform.test.js (including the A/B cross-namespace collision).
  const harness = createTestingMainContext({ grants: ["electron.window"] });
  let created: number | undefined;
  let ready: number | undefined;
  let unloaded: number | undefined;
  harness.ctx.window.onCreated((w) => {
    created = w;
  });
  harness.ctx.onRendererReady((w) => {
    ready = w;
  });
  harness.ctx.onUnload((w) => {
    unloaded = w;
  });
  harness.emitCreated(100);
  harness.emitRendererReady(100);
  harness.emitUnload(100);
  expect(created).toBe(100);
  expect(ready).toBe(100);
  expect(unloaded).toBe(100);
  harness.ctx.window.setOpacity(created!, 0.5);
  harness.ctx.window.setSize(ready!, 800, 600);
  harness.ctx.window.setPosition(unloaded!, 10, 20);
  expect(harness.calls.windowSetOpacity).toEqual([
    expect.objectContaining({ window: 100, opacity: 0.5 }),
  ]);
  expect(harness.calls.windowSetSize).toEqual([
    expect.objectContaining({ window: 100, width: 800, height: 600 }),
  ]);
  expect(harness.calls.windowSetPosition).toEqual([
    expect.objectContaining({ window: 100, x: 10, y: 20 }),
  ]);
});

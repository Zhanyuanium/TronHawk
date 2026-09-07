import { test, expect } from "bun:test";
import type {
  DomElement,
  MainContext,
  PluginModule,
  RendererContext,
} from "../index";
import {
  ContractViolationError,
  assertSyncUndefined,
  drainActivate,
  drainDeactivate,
  invokeEventCallback,
} from "./index";
import {
  createTestingMainContext,
  createTestingRendererContext,
} from "./index";

function sampleNode(): DomElement {
  return {
    nodeId: 1,
    tag: "div",
    id: "",
    className: "row",
    attrs: { role: "row" },
    text: "hi",
  };
}

test("drain resolves synchronous undefined hooks", async () => {
  const plugin: PluginModule<RendererContext> = {
    activate() {},
    deactivate() {},
  };
  const { ctx } = createTestingRendererContext({ grants: [] });
  await drainActivate(plugin, ctx);
  await drainDeactivate(plugin, ctx);
});

test("drain awaits async hooks before resolving (Promise drain semantics)", async () => {
  const order: string[] = [];
  const plugin: PluginModule<RendererContext> = {
    async activate() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("activated");
    },
    async deactivate() {
      await Promise.resolve();
      order.push("deactivated");
    },
  };
  const { ctx } = createTestingRendererContext({ grants: [] });

  let activatedEarly = false;
  const pending = drainActivate(plugin, ctx).then(() => {
    activatedEarly = order.includes("activated");
  });
  await pending;
  expect(order).toEqual(["activated"]);
  expect(activatedEarly).toBe(true);

  await drainDeactivate(plugin, ctx);
  expect(order).toEqual(["activated", "deactivated"]);
});

test("drain accepts hooks resolving to a concrete value (host parity) but still rejects sync non-undefined", async () => {
  const { ctx } = createTestingRendererContext({ grants: [] });
  // Host parity (crates/runtime/js/src/index.js `watchAsyncActivate` +
  // `drainThenableResult` never inspect the fulfilled value; the canonical
  // harness `pumpUntilSettled` agrees): fulfillment of any value accepts —
  // only rejection fails, and only a synchronous non-`undefined` return fails
  // the void contract.
  const asyncValue = {
    activate: () => Promise.resolve("oops"),
    deactivate() {},
  } as unknown as PluginModule<RendererContext>;
  await drainActivate(asyncValue, ctx);

  const deactValue = {
    activate() {},
    deactivate: () => Promise.resolve(42),
  } as unknown as PluginModule<RendererContext>;
  await drainDeactivate(deactValue, ctx);

  const asyncReject = {
    activate: () => Promise.reject(new Error("boom")),
    deactivate() {},
  } as unknown as PluginModule<RendererContext>;
  await expect(drainActivate(asyncReject, ctx)).rejects.toThrow("boom");

  const syncBad = {
    activate: (() => "oops") as unknown as () => undefined,
    deactivate() {},
  } as unknown as PluginModule<RendererContext>;
  await expect(drainActivate(syncBad, ctx)).rejects.toBeInstanceOf(
    ContractViolationError,
  );
});

test("dom.observe callback returning a value is detected on emit", () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.dom"],
  });
  const bad = (() => "nope") as unknown as (node: DomElement) => undefined;
  harness.ctx.dom.observe(".row", bad);
  expect(() => harness.emitDom(".row", sampleNode())).toThrow(
    ContractViolationError,
  );
  // Host parity (fail-closed): the violating observer is unregistered, so a
  // second emit is a silent no-op instead of throwing again.
  expect(() => harness.emitDom(".row", sampleNode())).not.toThrow();
  expect(harness.domObservers[0]?.disconnected).toBe(true);
});

test("dom.observe callback returning a Promise is detected on emit", () => {
  const harness = createTestingRendererContext({
    grants: ["renderer.dom"],
  });
  const asyncCb = (() =>
    Promise.resolve()) as unknown as (node: DomElement) => undefined;
  harness.ctx.dom.observe(".row", asyncCb);
  expect(() => harness.emitDom(".row", sampleNode())).toThrow(
    /Promise\/thenable/,
  );
  expect(harness.domObservers[0]?.disconnected).toBe(true);
});

test("main lifecycle callbacks returning values are detected on emit", () => {
  const harness = createTestingMainContext({ grants: ["electron.window"] });
  const asyncOnLoad = (() =>
    Promise.resolve()) as unknown as () => undefined;
  harness.ctx.onLoad(asyncOnLoad);
  expect(() => harness.emitLoad()).toThrow(ContractViolationError);

  const harness2 = createTestingMainContext({ grants: ["electron.window"] });
  const valueCb = (() =>
    "win") as unknown as (window: number) => undefined;
  harness2.ctx.onRendererReady(valueCb);
  expect(() => harness2.emitRendererReady(1)).toThrow(
    ContractViolationError,
  );

  const harness3 = createTestingMainContext({ grants: ["electron.window"] });
  const unloadBad = (() => 7) as unknown as (window: number) => undefined;
  harness3.ctx.onUnload(unloadBad);
  expect(() => harness3.emitUnload(9)).toThrow(ContractViolationError);
});

test("valid synchronous undefined callbacks pass through emit", () => {
  const renderer = createTestingRendererContext({
    grants: ["renderer.dom"],
  });
  let seen = 0;
  renderer.ctx.dom.observe(".row", () => {
    seen++;
  });
  renderer.emitDom(".row", sampleNode());
  expect(seen).toBe(1);

  const main = createTestingMainContext({ grants: ["electron.window"] });
  const fired: string[] = [];
  main.ctx.onLoad(() => {
    fired.push("load");
  });
  main.ctx.window.onCreated((window) => {
    fired.push(`created:${window}`);
  });
  main.emitLoad();
  main.emitCreated(1);
  expect(fired).toEqual(["load", "created:1"]);
});

test("assertSyncUndefined and invokeEventCallback detect violations directly", () => {
  expect(() => assertSyncUndefined(undefined, "evt")).not.toThrow();
  expect(() => assertSyncUndefined("x", "evt")).toThrow(
    ContractViolationError,
  );
  expect(() => assertSyncUndefined(Promise.resolve(), "evt")).toThrow(
    /never drained/,
  );
  expect(() =>
    invokeEventCallback("evt", () => undefined),
  ).not.toThrow();
  expect(() =>
    invokeEventCallback(
      "evt",
      (() => 1) as unknown as () => unknown,
    ),
  ).toThrow(ContractViolationError);
});

test("activate can use granted APIs through the drain", async () => {
  const plugin: PluginModule<RendererContext> = {
    async activate(ctx) {
      await ctx.css.insert("body {}");
      await ctx.dom.query("body");
    },
    deactivate(ctx) {
      ctx.logger.info("bye");
    },
  };
  const harness = createTestingRendererContext({
    grants: ["renderer.css", "renderer.dom"],
  });
  await drainActivate(plugin, harness.ctx);
  expect(harness.calls.cssInsert).toHaveLength(1);
  expect(harness.calls.domQuery.map((c) => c.selector)).toEqual(["body"]);
  await drainDeactivate(plugin, harness.ctx);
  expect(harness.loggerMessages.map((m) => m.message)).toEqual(["bye"]);
});

test("main plugin activate/deactivate drain against the main harness", async () => {
  const seen: number[] = [];
  const plugin: PluginModule<MainContext> = {
    activate(ctx) {
      ctx.window.onCreated((window) => {
        seen.push(window);
      });
    },
    async deactivate() {},
  };
  const harness = createTestingMainContext({ grants: ["electron.window"] });
  await drainActivate(plugin, harness.ctx);
  harness.emitCreated(1);
  expect(seen).toEqual([1]);
  await drainDeactivate(plugin, harness.ctx);
});

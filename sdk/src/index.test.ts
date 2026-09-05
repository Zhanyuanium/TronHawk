import { test, expect, spyOn } from "bun:test";
import {
  createLogger,
  injectCSS,
  createMockRendererContext,
  createMockMainContext,
} from "./index";

test("createLogger exposes info/warn/error", () => {
  const logger = createLogger("com.example.test");
  expect(typeof logger.info).toBe("function");
  expect(typeof logger.warn).toBe("function");
  expect(typeof logger.error).toBe("function");
});

test("createLogger attributes levels and ignores non-string messages", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const logger = createLogger("com.example.owner");
    logger.warn("careful");
    (logger.error as (message: unknown) => void)({ arbitrary: "field" });

    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith("[com.example.owner][warn] careful");
  } finally {
    output.mockRestore();
  }
});

test("injectCSS delegates to the renderer context css API", () => {
  const ctx = createMockRendererContext();
  const id = injectCSS(ctx, "body { color: red; }");
  expect(typeof id).toBe("string");
});

test("mock renderer context exposes renderer APIs", () => {
  const ctx = createMockRendererContext();
  expect(typeof ctx.css.insert).toBe("function");
  expect(typeof ctx.css.remove).toBe("function");
  expect(typeof ctx.dom.query).toBe("function");
  expect(typeof ctx.dom.observe).toBe("function");
  expect(typeof ctx.script.setDocumentTitle).toBe("function");
  expect("execute" in ctx.script).toBe(false);
  expect(typeof ctx.storage.get).toBe("function");
  expect(typeof ctx.storage.set).toBe("function");
  expect(typeof ctx.network.request).toBe("function");
  expect(typeof ctx.logger.info).toBe("function");
});

test("mock renderer async APIs resolve; observe returns a disconnect", async () => {
  const ctx = createMockRendererContext();

  const node = await ctx.dom.query("body");
  expect(node).toBeNull();

  const disconnect = ctx.dom.observe(".row", () => {});
  expect(typeof disconnect).toBe("function");

  expect(await ctx.storage.get("theme")).toBeNull();
  expect(await ctx.storage.set("theme", "dark")).toBeUndefined();

  const res = await ctx.network.request({ url: "https://example.test/data" });
  expect(res.status).toBe(200);
  expect(res.body).toBe("");
});

test("mock main context network request resolves a canned response", async () => {
  const ctx = createMockMainContext();
  const res = await ctx.network.request({ url: "https://example.test/data" });
  expect(res.status).toBe(200);
  expect(res.headers).toEqual({});
});

test("mock main context exposes main APIs with window handle params", () => {
  const ctx = createMockMainContext();
  expect(typeof ctx.window.onCreated).toBe("function");
  expect(typeof ctx.window.setOpacity).toBe("function");
  expect(typeof ctx.webContents.openDevTools).toBe("function");
  expect("executeJavaScript" in ctx.webContents).toBe(false);
});

test("plugin_context_raw_is_optional", () => {
  const renderer = createMockRendererContext();
  const main = createMockMainContext();
  expect(renderer.raw).toBeUndefined();
  expect(main.raw).toBeUndefined();

  const raw = { electron: {}, node: { require: () => {}, process: {} } };
  const rendererWithRaw = createMockRendererContext({ raw });
  const mainWithRaw = createMockMainContext({ raw });
  expect(rendererWithRaw.raw).toBe(raw);
  expect(mainWithRaw.raw).toBe(raw);
  expect(rendererWithRaw.raw?.electron).toBe(raw.electron);
  expect(mainWithRaw.raw?.node.process).toBe(raw.node.process);
});

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
  expect(typeof ctx.logger.info).toBe("function");
});

test("mock main context exposes main APIs with window handle params", () => {
  const ctx = createMockMainContext();
  expect(typeof ctx.window.onCreated).toBe("function");
  expect(typeof ctx.window.setOpacity).toBe("function");
  expect(typeof ctx.webContents.openDevTools).toBe("function");
  expect("executeJavaScript" in ctx.webContents).toBe(false);
});

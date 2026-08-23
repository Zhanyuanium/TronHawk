import { test, expect } from "bun:test";
import {
  injectCSS,
  createLogger,
  requestNetwork,
  mockElectron,
} from "./index";

test("exports SDK utility stubs", () => {
  expect(typeof injectCSS).toBe("function");
  expect(typeof createLogger).toBe("function");
  expect(typeof requestNetwork).toBe("function");
  expect(typeof mockElectron).toBe("function");
});

test("requestNetwork rejects", async () => {
  await expect(requestNetwork({ url: "https://example.com" })).rejects.toThrow(
    "not implemented",
  );
});

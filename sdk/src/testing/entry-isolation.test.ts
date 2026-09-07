import { test, expect, spyOn } from "bun:test";
import * as main from "../index";

const MAIN_RUNTIME_EXPORTS = [
  "createLogger",
  "createMockMainContext",
  "createMockRendererContext",
  "injectCSS",
];

const TESTING_ONLY_EXPORTS = [
  "createTestingRendererContext",
  "createTestingMainContext",
  "drainActivate",
  "drainDeactivate",
  "assertSyncUndefined",
  "invokeEventCallback",
  "isThenable",
  "ContractViolationError",
  "normalizeGrants",
  "hasGrant",
  "deniedError",
  "ALL_PERMISSIONS",
];

test("main entry exposes only the stable public surface", () => {
  expect(Object.keys(main).sort()).toEqual([...MAIN_RUNTIME_EXPORTS].sort());
  for (const leaked of TESTING_ONLY_EXPORTS) {
    expect(Object.keys(main)).not.toContain(leaked);
  }
});

test("main entry import has no observable side effects", async () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const reimported = await import("../index");
    expect(Object.keys(reimported).sort()).toEqual(
      Object.keys(main).sort(),
    );
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
  }
  expect(
    (globalThis as Record<string, unknown>).__tronhawkSdkSideEffect,
  ).toBeUndefined();
});

test("main entry source has no top-level side-effect statements", async () => {
  const src = await Bun.file(
    new URL("../index.ts", import.meta.url),
  ).text();
  // Heuristic guard: a top-level (column 0) console/global/timer statement
  // would run on import. In the current contract file every console use
  // lives inside a function body (indented).
  const banned = /^(console\.|globalThis|process\.|await\s|setTimeout\(|setInterval\(|queueMicrotask\()/;
  for (const line of src.split("\n")) {
    expect(line.match(banned)).toBeNull();
  }
  expect(src).not.toMatch(/from\s+["']\.\/testing/);
});

test("testing surface is exposed only through ./testing", async () => {
  const testing = await import("./index");
  for (const name of TESTING_ONLY_EXPORTS) {
    expect(Object.keys(testing)).toContain(name);
  }
  expect(typeof testing.createTestingRendererContext).toBe("function");
  expect(typeof testing.drainActivate).toBe("function");
});

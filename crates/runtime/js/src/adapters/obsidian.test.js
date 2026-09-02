// Obsidian adapter matcher tests — pure contract only (no electron). The `onBootstrap` frame
// instrumentation needs a real Electron app and is verified by the manual Gate 0 matrix, not in CI
// (importing this file must not pull in electron or start any observer).
const { describe, test, expect } = require("bun:test");
const adapters = require("../adapters");
const obsidian = require("./obsidian");
const example = require("./example");

// Keep any adapter-selection warnings out of test output.
adapters.init({ log: () => {} });

describe("obsidian adapter matches()", () => {
  test("matches appInfo.name === 'obsidian'", () => {
    expect(obsidian.matches({ name: "obsidian" })).toBe(true);
    expect(
      obsidian.matches({
        name: "obsidian",
        packageJsonName: undefined,
        exeBasename: undefined,
      }),
    ).toBe(true);
  });

  test("matches appInfo.packageJsonName === 'obsidian'", () => {
    expect(obsidian.matches({ packageJsonName: "obsidian" })).toBe(true);
    expect(obsidian.matches({ name: undefined, packageJsonName: "obsidian" })).toBe(true);
  });

  test("matches exeBasename 'Obsidian.exe' case-insensitively", () => {
    expect(obsidian.matches({ exeBasename: "Obsidian.exe" })).toBe(true);
    expect(obsidian.matches({ exeBasename: "OBSIDIAN.EXE" })).toBe(true);
    expect(
      obsidian.matches({
        name: undefined,
        packageJsonName: undefined,
        exeBasename: "obsidian.exe",
      }),
    ).toBe(true);
  });

  test("does not match the TronHawk test app or unrelated names", () => {
    expect(obsidian.matches({ name: "tronhawk-test-app" })).toBe(false);
    expect(obsidian.matches({ packageJsonName: "tronhawk-test-app" })).toBe(false);
    expect(obsidian.matches({ name: "notepad" })).toBe(false);
    expect(obsidian.matches({ name: "obsidian-not-the-app" })).toBe(false);
    expect(obsidian.matches({ exeBasename: "Obsidian.exe.bak" })).toBe(false);
  });

  test("never throws and returns false for absent/undefined fields", () => {
    expect(() => obsidian.matches(undefined)).not.toThrow();
    expect(() => obsidian.matches(null)).not.toThrow();
    expect(() => obsidian.matches({})).not.toThrow();
    expect(() => obsidian.matches("obsidian")).not.toThrow();
    expect(
      () =>
        obsidian.matches({
          name: undefined,
          packageJsonName: undefined,
          exeBasename: undefined,
        }),
    ).not.toThrow();
    expect(obsidian.matches(undefined)).toBe(false);
    expect(obsidian.matches(null)).toBe(false);
    expect(obsidian.matches({})).toBe(false);
    expect(obsidian.matches({ name: undefined, packageJsonName: undefined })).toBe(false);
    expect(
      obsidian.matches({ name: undefined, packageJsonName: undefined, exeBasename: undefined }),
    ).toBe(false);
  });
});

describe("obsidian adapter registration order", () => {
  test("example still wins for the TronHawk test app (registered first)", () => {
    expect(adapters.select({ name: "tronhawk-test-app" })).toBe(example);
    // Even a test-app whose exe looks like Obsidian resolves to example: first match wins.
    expect(
      adapters.select({
        name: "tronhawk-test-app",
        packageJsonName: undefined,
        exeBasename: "Obsidian.exe",
      }),
    ).toBe(example);
  });

  test("obsidian wins for Obsidian appInfo", () => {
    expect(adapters.select({ name: "obsidian" })).toBe(obsidian);
    expect(adapters.select({ packageJsonName: "obsidian" })).toBe(obsidian);
    expect(
      adapters.select({
        name: "something",
        packageJsonName: undefined,
        exeBasename: "Obsidian.exe",
      }),
    ).toBe(obsidian);
  });
});

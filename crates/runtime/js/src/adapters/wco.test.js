// WCO adapter tests — pure contract only (no electron). The `onWindowOptions` hook is a pure
// options transform (exercised here and via adapters.applyWindowOptions); the BrowserWindow
// construction interception in src/index.js is verified on the real target / test-app WCO
// simulation, not in CI.
const { describe, test, expect } = require("bun:test");
const adapters = require("../adapters");
const wco = require("./wco");
const example = require("./example");
const obsidian = require("./obsidian");

// Keep any adapter-selection warnings out of test output.
adapters.init({ log: () => {} });

describe("wco adapter matches()", () => {
  test("matches the TronHawk test app (its WCO verification host)", () => {
    expect(wco.matches({ name: "tronhawk-test-app" })).toBe(true);
    expect(wco.matches({ packageJsonName: "tronhawk-test-app" })).toBe(true);
  });

  test("does not match other apps or near-misses", () => {
    expect(wco.matches({ name: "code" })).toBe(false);
    expect(wco.matches({ packageJsonName: "obsidian" })).toBe(false);
    expect(wco.matches({ exeBasename: "Code.exe" })).toBe(false);
    expect(wco.matches({ exeBasename: "notepad.exe" })).toBe(false);
  });

  test("never throws and returns false for absent/undefined fields", () => {
    expect(() => wco.matches(undefined)).not.toThrow();
    expect(() => wco.matches(null)).not.toThrow();
    expect(() => wco.matches({})).not.toThrow();
    expect(() => wco.matches("tronhawk-test-app")).not.toThrow();
    expect(wco.matches(undefined)).toBe(false);
    expect(wco.matches(null)).toBe(false);
    expect(wco.matches({})).toBe(false);
    expect(wco.matches({ name: undefined, exeBasename: undefined })).toBe(false);
  });
});

describe("wco adapter onWindowOptions()", () => {
  test("removes titleBarOverlay and forces titleBarStyle hidden without drawn controls", () => {
    const original = {
      width: 800,
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#2f3241", symbolColor: "#ffffff", height: 30 },
      webPreferences: { contextIsolation: true },
    };
    const next = wco.onWindowOptions(original);
    expect(next).not.toBe(original);
    expect(next.titleBarOverlay).toBeUndefined();
    expect(next.titleBarStyle).toBe("hidden");
    expect(next.width).toBe(800);
    expect(next.webPreferences).toEqual({ contextIsolation: true });
    // Never mutates the caller's original options object.
    expect(original.titleBarOverlay).toBeDefined();
  });

  test("is tolerant of undefined/null/no-opts input", () => {
    expect(() => wco.onWindowOptions(undefined)).not.toThrow();
    expect(() => wco.onWindowOptions(null)).not.toThrow();
    const next = wco.onWindowOptions(undefined);
    expect(next).toEqual({ titleBarStyle: "hidden" });
  });
});

describe("wco adapter registration order", () => {
  test("wco selected for the test app (wins before example); obsidian unaffected", () => {
    expect(adapters.select({ name: "tronhawk-test-app" })).toBe(wco);
    expect(adapters.select({ packageJsonName: "tronhawk-test-app" })).toBe(wco);
    expect(adapters.select({ packageJsonName: "obsidian" })).toBe(obsidian);
    // example remains a valid adapter but no longer wins the test-app match.
    expect(example.matches({ name: "tronhawk-test-app" })).toBe(true);
  });
});

// electron-require-shim tests — pure contract only (no real Electron needed).
//
// The shim wraps require("module")._load and hands out a Proxy facade whose BrowserWindow getter
// returns a wrapping constructor (ADR 0009). The runtime package does NOT install electron (the
// runtime.js bundle is built with `--external electron`), so we supply a fake electron via
// bun's mock.module — the same approach index.test.js uses.
//
// Two concerns, tested separately:
//   1. facade semantics (pure): `createElectronFacade` — BrowserWindow getter yields the wrapper,
//      other properties forward, set forwards, prototype preserved.
//   2. module-hook behavior: `installElectronFacade` wraps _load exactly once (idempotent), the
//      returned facade's BrowserWindow getter returns the wrapper, and `uninstallElectronFacade`
//      restores _load.
const { describe, test, expect, beforeEach, afterEach, mock } = require("bun:test");
const shim = require("./electron-require-shim");

// --- Fake electron, supplied via mock.module so the shim's internal require("electron") resolves
// --- in this electron-less package. BrowserWindow is a getter-only non-configurable accessor to
// --- mirror the real electron module (ADR 0009 fact 3).
let realBW = function RealBW() {};
const realElectron = { app: { name: "app" }, protocol: {} };
Object.defineProperty(realElectron, "BrowserWindow", {
  get: () => realBW,
  configurable: false,
  enumerable: true,
});
mock.module("electron", () => realElectron);

const Module = require("module");
const electronLoad = Module._load; // capture the loader before shim wraps it

beforeEach(() => {
  shim.uninstallElectronFacade();
  realBW = function RealBW() {};
});

afterEach(() => {
  shim.uninstallElectronFacade();
});

describe("createElectronFacade (pure facade semantics)", () => {
  test("BrowserWindow getter returns the wrapped constructor (cached once)", () => {
    let calls = 0;
    const wrapped = function WrappedBW() {};
    const facade = shim.createElectronFacade(realElectron, () => {
      calls += 1;
      return wrapped;
    });
    expect(facade.BrowserWindow).toBe(wrapped);
    expect(facade.BrowserWindow).toBe(wrapped); // cached, getFacadeBrowserWindow called once
    expect(calls).toBe(1);
  });

  test("forwards non-BrowserWindow properties and prototype to the real module", () => {
    const wrapped = function WrappedBW() {};
    const facade = shim.createElectronFacade(realElectron, () => wrapped);
    expect(facade.app).toBe(realElectron.app);
    expect(facade.protocol).toBe(realElectron.protocol);
    expect("app" in facade).toBe(true);
  });

  test("forwards set to the real module (getter-only accessor: assignment no-ops on real)", () => {
    const wrapped = function WrappedBW() {};
    const facade = shim.createElectronFacade(realElectron, () => wrapped);
    facade.BrowserWindow = wrapped; // sloppy-mode assignment to a getter-only accessor
    expect(facade.BrowserWindow).toBe(wrapped); // facade get still returns wrapped
    expect(realElectron.BrowserWindow).toBe(realBW); // real module untouched (no-op)
    // Non-accessor properties forward set normally.
    facade.someExtra = 42;
    expect(realElectron.someExtra).toBe(42);
  });
});

describe("installElectronFacade (module-hook)", () => {
  test("requires a function; returns null (no wrap) when given null", () => {
    const before = Module._load;
    const result = shim.installElectronFacade(null);
    expect(result).toBeNull();
    expect(Module._load).toBe(before);
  });

  test("wraps _load, returns a facade whose BrowserWindow getter yields the wrapper", () => {
    const wrapped = function WrappedBW() {};
    const before = Module._load;
    const facade = shim.installElectronFacade(() => wrapped);
    expect(facade).toBeTruthy();
    expect(Module._load).not.toBe(before);
    expect(facade.BrowserWindow).toBe(wrapped);
  });

  test("is idempotent: second install returns the same facade, wrapper unchanged", () => {
    const wrapped = function WrappedBW() {};
    const f1 = shim.installElectronFacade(() => wrapped);
    const loadAfterFirst = Module._load;
    const f2 = shim.installElectronFacade(() => function Other() {});
    expect(f2).toBe(f1);
    expect(Module._load).toBe(loadAfterFirst); // no re-wrap
    expect(f1.BrowserWindow).toBe(wrapped);
  });

  test("wrapped BrowserWindow applies adapter options before constructing", () => {
    const seen = [];
    const wrapped = function (...args) {
      const opts = args[0] && typeof args[0] === "object" ? args[0] : {};
      const next = Object.assign({}, opts);
      delete next.titleBarOverlay;
      next.titleBarStyle = "hidden";
      seen.push(next);
      return new realBW(args[0]); // construct through real
    };
    const facade = shim.installElectronFacade(() => wrapped);
    const BW = facade.BrowserWindow;
    new BW({ titleBarStyle: "hidden", titleBarOverlay: { color: "#000" }, width: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0].titleBarOverlay).toBeUndefined();
    expect(seen[0].titleBarStyle).toBe("hidden");
  });
});

describe("uninstallElectronFacade", () => {
  test("restores the original _load after install", () => {
    const wrapped = function WrappedBW() {};
    const before = Module._load;
    shim.installElectronFacade(() => wrapped);
    expect(Module._load).not.toBe(before);
    shim.uninstallElectronFacade();
    expect(Module._load).toBe(before);
  });

  test("is a harmless no-op when nothing is installed", () => {
    const before = Module._load;
    expect(() => shim.uninstallElectronFacade()).not.toThrow();
    expect(Module._load).toBe(before);
  });
});

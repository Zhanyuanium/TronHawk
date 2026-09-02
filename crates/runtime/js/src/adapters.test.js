// Adapter registry/selection tests — pure contract only (no electron needed; the app object is
// mocked). Run with `bun test` from crates/runtime/js (auto-discovers *.test.js).
const { describe, test, expect } = require("bun:test");
const path = require("path");
const adapters = require("./adapters");
const example = require("./adapters/example");

// Keep expected warnings (throwing matches/onBootstrap) out of the test output.
adapters.init({ log: () => {} });

const TEST_APP_DIR = path.join(__dirname, "..", "..", "..", "..", "apps", "test-app");

function appMock(overrides = {}) {
  return {
    getName: () => overrides.name,
    getAppPath: () => overrides.appPath,
    ...overrides,
  };
}

describe("buildAppInfo", () => {
  test("tolerates a degenerate app object and never throws", () => {
    let info;
    expect(() => {
      info = adapters.buildAppInfo({});
    }).not.toThrow();
    expect(info.name).toBeUndefined();
    expect(info.appPath).toBeUndefined();
    expect(info.packageJsonName).toBeUndefined();
  });

  test("tolerates null/undefined and getName/getAppPath returning undefined", () => {
    expect(() => adapters.buildAppInfo(null)).not.toThrow();
    expect(() => adapters.buildAppInfo(undefined)).not.toThrow();
    const info = adapters.buildAppInfo({
      getName: () => undefined,
      getAppPath: () => undefined,
    });
    expect(info.name).toBeUndefined();
    expect(info.appPath).toBeUndefined();
    expect(info.packageJsonName).toBeUndefined();
  });

  test("tolerates throwing getName/getAppPath", () => {
    const info = adapters.buildAppInfo({
      getName: () => {
        throw new Error("not ready");
      },
      getAppPath: () => {
        throw new Error("not ready");
      },
    });
    expect(info.name).toBeUndefined();
    expect(info.appPath).toBeUndefined();
    expect(info.packageJsonName).toBeUndefined();
  });

  test("reads packageJsonName when appPath has a valid package.json", () => {
    const app = appMock({ name: "tronhawk-test-app", appPath: TEST_APP_DIR });
    const info = adapters.buildAppInfo(app);
    expect(info.name).toBe("tronhawk-test-app");
    expect(info.appPath).toBe(TEST_APP_DIR);
    expect(info.packageJsonName).toBe("tronhawk-test-app");
  });

  test("leaves packageJsonName undefined when appPath has no package.json", () => {
    // __dirname (crates/runtime/js/src) has no package.json.
    const app = appMock({ name: "whatever", appPath: __dirname });
    const info = adapters.buildAppInfo(app);
    expect(info.appPath).toBe(__dirname);
    expect(info.packageJsonName).toBeUndefined();
    expect(() => adapters.buildAppInfo(app)).not.toThrow();
  });

  test("surfaces exeBasename and electronVersion fields", () => {
    const app = appMock({ name: "some-app", appPath: "/nonexistent" });
    const info = adapters.buildAppInfo(app);
    expect(info.exeBasename).toBe(path.basename(process.execPath));
    expect(info.electronVersion).toBe(process.versions.electron);
  });
});

describe("select", () => {
  const matchingInfo = { name: "tronhawk-test-app", packageJsonName: undefined };
  const nonMatchingInfo = { name: "another-app", packageJsonName: undefined };

  test("returns the example adapter for a matching appInfo", () => {
    expect(adapters.select(matchingInfo)).toBe(example);
  });

  test("returns null when nothing matches", () => {
    expect(adapters.select(nonMatchingInfo)).toBeNull();
    expect(adapters.select({ name: undefined, packageJsonName: undefined })).toBeNull();
    expect(adapters.select({})).toBeNull();
  });

  test("a throwing matches() is treated as no-match and does not throw out of select", () => {
    const boom = { id: "boom", matches: () => { throw new Error("boom"); } };
    let result;
    expect(() => {
      result = adapters.select(nonMatchingInfo, [boom]);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  test("select skips a throwing adapter and returns the next matching one", () => {
    const boom = { id: "boom", matches: () => { throw new Error("boom"); } };
    const result = adapters.select(matchingInfo, [boom, example]);
    expect(result).toBe(example);
  });

  test("first match wins when several adapters match", () => {
    const first = { id: "first", matches: () => true };
    const second = { id: "second", matches: () => true };
    expect(adapters.select({ name: "x" }, [first, second])).toBe(first);
    // Non-matching first adapter falls through to the matching one.
    expect(adapters.select(matchingInfo, [{ id: "no", matches: () => false }, example])).toBe(
      example,
    );
  });
});

describe("runOnBootstrap", () => {
  test("does nothing when onBootstrap is absent", () => {
    expect(() => adapters.runOnBootstrap({ id: "noop" }, {})).not.toThrow();
    expect(() => adapters.runOnBootstrap(null, {})).not.toThrow();
  });

  test("calls onBootstrap with ctx and continues when it throws (fail-open)", () => {
    const seen = [];
    const ok = {
      id: "ok",
      onBootstrap(ctx) {
        seen.push(ctx);
      },
    };
    const ctx = { app: {}, appInfo: { name: "tronhawk-test-app" } };
    adapters.runOnBootstrap(ok, ctx);
    expect(seen).toEqual([ctx]);

    const boom = {
      id: "boom",
      onBootstrap() {
        throw new Error("bootstrap exploded");
      },
    };
    expect(() => adapters.runOnBootstrap(boom, ctx)).not.toThrow();
  });
});

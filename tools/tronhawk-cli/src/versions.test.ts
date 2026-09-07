import { test, expect } from "bun:test";
import { assertReleaseTagMatches, readCliPackage } from "./versions";

test("cli/engine/protocol versions are managed independently", () => {
  const info = readCliPackage();
  // All three exist as separate fields (never assume equality, even when equal today).
  expect(typeof info.cliVersion).toBe("string");
  expect(typeof info.engineVersion).toBe("string");
  expect(typeof info.protocolVersion).toBe("string");
  expect(info.cliVersion.length).toBeGreaterThan(0);
  expect(info.engineVersion.length).toBeGreaterThan(0);
  expect(info.protocolVersion.length).toBeGreaterThan(0);
});

test("release-tag consistency is only an explicit assertion", () => {
  expect(() => assertReleaseTagMatches("v0.1.1", "0.1.1", "engine")).not.toThrow();
  expect(() => assertReleaseTagMatches("v0.2.0", "0.1.1", "engine")).toThrow();
});

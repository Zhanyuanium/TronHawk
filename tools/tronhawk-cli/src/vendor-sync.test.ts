import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { cliRoot } from "./versions";
import { findWorkspaceRoot } from "./native";

// The vendored harness must stay byte-identical to the canonical source:
// `test --sandbox` resolves the vendored copy first (standalone installs),
// so any drift would silently fork the contract.
function vendoredPath(): string {
  return path.join(cliRoot(), "src", "vendor", "contract-harness.js");
}

function checkoutPath(): string | null {
  const root = findWorkspaceRoot(cliRoot()) ?? findWorkspaceRoot(process.cwd());
  if (!root) return null;
  return path.join(root, "crates", "runtime", "js", "src", "contract-harness.js");
}

test("vendored harness is carried with the CLI package", () => {
  expect(fs.existsSync(vendoredPath())).toBe(true);
});

test("vendored harness is byte-identical to the canonical source", () => {
  const checkout = checkoutPath();
  if (!checkout || !fs.existsSync(checkout)) return; // tarball install: nothing to compare against
  const a = fs.readFileSync(vendoredPath());
  const b = fs.readFileSync(checkout);
  expect(a.equals(b)).toBe(true);
});

test("vendored harness exposes the sandbox contract", () => {
  const mod = createRequire(import.meta.url)(vendoredPath()) as Record<string, unknown>;
  expect(mod.CONTRACT_VERSION).toBe(1);
  expect(typeof mod.runContractCheck).toBe("function");
});

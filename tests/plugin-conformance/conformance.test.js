// Plugin-conformance runner: executes the shared corpus in
// tests/plugin-conformance/index.json through the canonical contract harness
// (crates/runtime/js/src/contract-harness.js) — the same harness the CLI
// reuses for `tronhawk test --sandbox`, so both runners judge identical
// semantics over identical fixtures.
//
// Scope of THIS runner: `sandbox` expectations (pass/fail) plus structural
// validity of every case (index schema, fixture files, zip-spec shape).
// `validate` / `extract` expectations are owned by Rust (`crates/package`
// `conformance_validate_corpus` / `conformance_extract_corpus`, run via
// `cargo test -p tronhawk-package`), which consumes the same index.json; this
// file only asserts those entries are well-formed (non-empty needles,
// referenced files exist). There is no `core-plan` runner: index.json
// `runners` intentionally omits it.
//
// Run with `bun test tests/plugin-conformance` from the repo root.
const { describe, test, expect } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const harness = require("../../crates/runtime/js/src/contract-harness.js");

const ROOT = path.join(__dirname, "..", "..");
const CONF_DIR = path.join(ROOT, "tests", "plugin-conformance");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function logText(report) {
  return report.logs.map(([, message]) => String(message)).join("\n");
}

// Ordered-subsequence match: every needle appears in order in the log text.
function logsContainInOrder(text, needles) {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    from = at + needle.length;
  }
  return true;
}

const index = readJson(path.join(CONF_DIR, "index.json"));

describe("conformance index schema", () => {
  test("index version is 1 with exactly the wired runners (no core-plan)", () => {
    expect(index.version).toBe(1);
    expect([...index.runners].sort()).toEqual(["cli-sandbox", "rust-extract", "rust-validate"]);
    expect(index.runners).not.toContain("core-plan");
  });

  test("case ids are unique and dirs exist", () => {
    const ids = new Set();
    for (const c of index.cases) {
      expect(typeof c.id).toBe("string");
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(["plugin", "zip-spec"]).toContain(c.kind);
      const dir = path.join(CONF_DIR, c.dir);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
  });

  test("plugin cases ship a parseable manifest.json", () => {
    for (const c of index.cases.filter((c) => c.kind === "plugin")) {
      const manifest = readJson(path.join(CONF_DIR, c.dir, "manifest.json"));
      expect(typeof manifest.id).toBe("string");
      expect(typeof manifest.tronhawk).toBe("string");
    }
  });

  test("validate/extract expectations carry non-empty needles when rejecting", () => {
    for (const c of index.cases) {
      for (const scope of ["validate", "extract"]) {
        const exp = c[scope];
        if (exp && exp.expect === "reject") {
          expect(typeof exp.needle).toBe("string");
          expect(exp.needle.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("zip-spec cases describe a materializable hostile archive", () => {
    for (const c of index.cases.filter((c) => c.kind === "zip-spec")) {
      const spec = readJson(path.join(CONF_DIR, c.dir, "zip-spec.json"));
      expect(Array.isArray(spec.entries)).toBe(true);
      expect(spec.entries.length).toBeGreaterThan(0);
      for (const e of spec.entries) {
        expect(typeof e.name).toBe("string");
        expect(typeof e.content === "string" || typeof e.contentFile === "string").toBe(true);
        if (e.contentFile) {
          expect(fs.statSync(path.join(CONF_DIR, c.dir, e.contentFile)).isFile()).toBe(true);
        }
      }
      expect(spec.extract.expect).toBe("reject");
    }
  });

  test("sandbox pass/fail cases declare entry + assertions", () => {
    for (const c of index.cases) {
      const s = c.sandbox;
      expect(s && typeof s.expect).toBe("string");
      expect(["pass", "fail", "skip"]).toContain(s.expect);
      if (s.expect === "fail") {
        expect(Array.isArray(s.needles) && s.needles.length > 0).toBe(true);
      }
      if (s.expect === "pass" && s.entry) {
        expect(["renderer", "main"]).toContain(s.entry);
      }
    }
  });
});

describe("conformance sandbox cases (canonical harness)", () => {
  for (const c of index.cases.filter(
    (c) => c.kind === "plugin" && c.sandbox && c.sandbox.expect !== "skip",
  )) {
    const s = c.sandbox;
    if (s.expect === "pass" && !s.entry) {
      test(`${c.id}: CSS-only has nothing to execute`, () => {
        const manifest = readJson(path.join(CONF_DIR, c.dir, "manifest.json"));
        const entry = manifest.entry || {};
        expect(typeof entry.renderer).toBe("undefined");
        expect(typeof entry.main).toBe("undefined");
      });
      continue;
    }
    test(`${c.id}: sandbox ${s.expect}`, async () => {
      const manifest = readJson(path.join(CONF_DIR, c.dir, "manifest.json"));
      const rel = manifest.entry && manifest.entry[s.entry];
      expect(typeof rel).toBe("string");
      const source = fs.readFileSync(path.join(CONF_DIR, c.dir, rel), "utf8");
      const report = await harness.runContractCheck({
        source,
        permissions: manifest.permissions || [],
        kind: s.entry === "main" ? "main" : "renderer",
      });
      if (s.expect === "pass") {
        expect(report.issues).toEqual([]);
        expect(report.ok).toBe(true);
        if (s.expectLogs) {
          expect(logsContainInOrder(logText(report), s.expectLogs)).toBe(true);
        }
      } else {
        expect(report.ok).toBe(false);
        const joined = report.issues.join("\n");
        for (const needle of s.needles) {
          expect(joined).toContain(needle);
        }
      }
    }, 30000);
  }
});

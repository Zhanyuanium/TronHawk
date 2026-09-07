# Plugin conformance fixtures

Shared corpus for every runner that judges a plugin artifact — Rust
(`tronhawk-package` validate/extract) and the CLI sandbox
(`tronhawk test --sandbox` via the canonical harness). No runner owns these
files; each runner consumes `index.json` and asserts its own scope.
`index.json` `runners` is exactly
`["rust-validate", "rust-extract", "cli-sandbox"]` — there is no `core-plan`
runner, so it is intentionally omitted (not declared).

- `validate`: manifest schema + `tronhawk` protocol gate + entry-file
  resolution on the unpacked directory. Owner: Rust (`crates/package`,
  `conformance_validate_corpus`, run via `cargo test -p tronhawk-package`).
  `expect: "ok"` (14 cases) must validate clean via `load_plugin_dir`;
  `"reject"` (4 cases) must fail with `needle` in the error. This JS runner
  only checks these entries are well-formed; it never judges them.
- `sandbox`: module/lifecycle contract in a QuickJS VM with the host's
  CommonJS loading convention (`module.exports.activate`/`deactivate`,
  Promise drain, sync-void callbacks, permission-gated ctx). Owner: the
  canonical harness (`crates/runtime/js/src/contract-harness.js`), consumed
  here by `conformance.test.js` and by the CLI. `"pass"` runs the declared
  `entry` (`"renderer"`/`"main"`, `null` = CSS-only, nothing to execute) and
  requires zero issues plus every `expectLogs` entry (in order) in the
  captured logs. `"fail"` requires rejection with every `needles` entry in
  the report. `"skip"` (with `reason`) marks cases outside the sandbox scope
  (schema-only and archive-level cases).
- `extract`: archive hardening (zip-slip, duplicates, traversal) on a `.thx`
  materialized from `zip-spec.json` (`entries[].name` written with `content`
  bytes or the referenced `contentFile`). Owner: Rust (`crates/package`,
  `conformance_extract_corpus`, run via `cargo test -p tronhawk-package`).
  All 3 cases `expect: "reject"` with `needle` in the error and an empty
  dest dir. The CLI never builds archives itself, so it skips these.

Case kinds: `plugin` (a directory with `manifest.json`, packed/validated as
is) and `zip-spec` (a hostile archive described declaratively — no binary
blobs checked in; the runner materializes the zip).

Conventions: fixture ids are `com.example.<case>`; `tronhawk: "^0.1"`;
`version: "0.1.0"`. Negative plugin fixtures fail for exactly one reason —
referenced entry files are present so schema failures precede file IO.

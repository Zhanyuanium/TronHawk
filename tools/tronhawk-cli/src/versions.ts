// CLI / engine / protocol versions are managed independently (Gate 2).
// Never compare them with `===` across kinds and never derive one from another:
// - CLI version: this package's `version`.
// - Engine version: this package's `tronhawk.engineVersion` (must exactly match the
//   native `tronhawk-pack --version` at runtime).
// - Protocol version: this package's `tronhawk.protocolVersion` (the host protocol the
//   CLI was built against for documentation); the authoritative default lives in the Rust
//   engine (`HOST_PROTOCOL_VERSION`). The CLI forwards `--host-version` when given and
//   otherwise omits the flag so Rust uses its own default.

import * as fs from "node:fs";
import * as path from "node:path";

export interface CliPackageInfo {
  cliVersion: string;
  engineVersion: string;
  protocolVersion: string;
}

export function cliRoot(): string {
  // src/versions.ts -> tools/tronhawk-cli/
  return path.resolve(import.meta.dir, "..");
}

export function readCliPackage(): CliPackageInfo {
  const pkgPath = path.join(cliRoot(), "package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as {
    version?: string;
    tronhawk?: { engineVersion?: string; protocolVersion?: string; packBin?: string };
  };
  // Gate 2: missing fields must fail — never derive one version from another
  // (no `engineVersion ?? cliVersion`, no `protocolVersion ?? "0.1.0"`, no
  // `"0.0.0"` placeholder). Release-tag / package / engine consistency is only
  // ever an explicit assertion by the caller (see `assertEngineVersion` in
  // native.ts); this module never compares versions across kinds.
  const cliVersion = pkg.version;
  if (typeof cliVersion !== "string" || cliVersion.length === 0) {
    throw new Error(
      `@tronhawk/cli package.json is missing the required "version" field (${pkgPath}).`,
    );
  }
  const engineVersion = pkg.tronhawk?.engineVersion;
  if (typeof engineVersion !== "string" || engineVersion.length === 0) {
    throw new Error(
      `@tronhawk/cli package.json is missing the required "tronhawk.engineVersion" field (${pkgPath}); refusing to derive it from the CLI version.`,
    );
  }
  const protocolVersion = pkg.tronhawk?.protocolVersion;
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new Error(
      `@tronhawk/cli package.json is missing the required "tronhawk.protocolVersion" field (${pkgPath}); refusing to derive a default.`,
    );
  }
  return { cliVersion, engineVersion, protocolVersion };
}

/** Explicit release-tag assertion (the only allowed cross-version comparison). */
export function assertReleaseTagMatches(tag: string, expected: string, what: string): void {
  const norm = (s: string) => s.trim().replace(/^v/, "");
  if (norm(tag) !== norm(expected)) {
    throw new Error(
      `${what} version mismatch: release tag \`${tag}\` does not match expected \`${expected}\` (explicit assertion; versions are otherwise managed independently).`,
    );
  }
}

export function versionReportJson(): Record<string, string> {
  const info = readCliPackage();
  return {
    name: "@tronhawk/cli",
    cli: info.cliVersion,
    engine_expected: info.engineVersion,
    protocol_expected: info.protocolVersion,
  };
}

export function versionReportHuman(): string {
  const info = readCliPackage();
  return [
    `@tronhawk/cli ${info.cliVersion}`,
    `engine (expected) ${info.engineVersion}`,
    `protocol (expected) ${info.protocolVersion}`,
    `platform ${process.platform}-${process.arch}`,
  ].join("\n");
}

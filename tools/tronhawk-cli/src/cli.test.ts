import { test, expect } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "./cli";

const CLI = path.resolve(import.meta.dir, "cli.ts");

function runCli(args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

test("parseArgs splits command, flags, and positionals", () => {
  const p = parseArgs(["pack", "a", "b.thx", "--host-version", "0.1.0", "--json"]);
  expect(p.command).toBe("pack");
  expect(p.positionals).toEqual(["a", "b.thx"]);
  expect(p.hostVersion).toBe("0.1.0");
  expect(p.json).toBe(true);
});

test("cli --help exits 0 with usage", () => {
  const r = runCli(["--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("tronhawk pack");
  expect(r.out).toContain("tronhawk inspect");
});

test("cli unknown command exits 2", () => {
  const r = runCli(["bogus-command"]);
  expect(r.code).toBe(2);
  expect(r.err + r.out).toContain("unknown command");
});

test("cli --version reports the three independently-managed versions", () => {
  const r = runCli(["--version"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("@tronhawk/cli");
  expect(r.out).toContain("engine (expected)");
  expect(r.out).toContain("protocol (expected)");
});

test("cli help pack documents CSS-only and single-JSON contract", () => {
  const r = runCli(["help", "pack"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("CSS-only");
  expect(r.out).toContain("single Rust");
});

test("cli help inspect documents Rust passthrough", () => {
  const r = runCli(["help", "inspect"]);
  expect(r.code).toBe(0);
  expect(r.out.toLowerCase()).toContain("passthrough");
});

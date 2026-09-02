// ChatGPT adapter matcher tests — pure contract only (no electron). The `renderer.gate`/`onBootstrap`
// need a real Electron app and are verified on the real target, not in CI.
const { describe, test, expect } = require("bun:test");
const adapters = require("../adapters");
const chatgpt = require("./chatgpt");
const example = require("./example");
const obsidian = require("./obsidian");

// Keep any adapter-selection warnings out of test output.
adapters.init({ log: () => {} });

describe("chatgpt adapter matches()", () => {
  test("matches openai-codex-electron packageJsonName", () => {
    expect(chatgpt.matches({ packageJsonName: "openai-codex-electron" })).toBe(true);
  });

  test("matches ChatGPT.exe and codex.exe case-insensitively", () => {
    expect(chatgpt.matches({ exeBasename: "ChatGPT.exe" })).toBe(true);
    expect(chatgpt.matches({ exeBasename: "codex.exe" })).toBe(true);
    expect(chatgpt.matches({ exeBasename: "CODE X.EXE".replace(" ", "") })).toBe(true);
  });

  test("does not match other apps or near-misses", () => {
    expect(chatgpt.matches({ name: "tronhawk-test-app" })).toBe(false);
    expect(chatgpt.matches({ packageJsonName: "obsidian" })).toBe(false);
    expect(chatgpt.matches({ exeBasename: "notepad.exe" })).toBe(false);
    expect(chatgpt.matches({ exeBasename: "ChatGPT.exe.bak" })).toBe(false);
  });

  test("never throws and returns false for absent/undefined fields", () => {
    expect(() => chatgpt.matches(undefined)).not.toThrow();
    expect(() => chatgpt.matches(null)).not.toThrow();
    expect(() => chatgpt.matches({})).not.toThrow();
    expect(() => chatgpt.matches("openai-codex-electron")).not.toThrow();
    expect(chatgpt.matches(undefined)).toBe(false);
    expect(chatgpt.matches({})).toBe(false);
    expect(chatgpt.matches({ packageJsonName: undefined, exeBasename: undefined })).toBe(false);
  });
});

describe("chatgpt adapter registration order", () => {
  test("chatgpt selected for ChatGPT appInfo; example/obsidian unaffected", () => {
    expect(adapters.select({ packageJsonName: "openai-codex-electron" })).toBe(chatgpt);
    expect(adapters.select({ exeBasename: "ChatGPT.exe" })).toBe(chatgpt);
    expect(adapters.select({ packageJsonName: "tronhawk-test-app" })).toBe(example);
    expect(adapters.select({ packageJsonName: "obsidian" })).toBe(obsidian);
  });
});

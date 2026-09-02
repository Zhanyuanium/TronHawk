// makeSelectorGate tests — pure JS (no electron). Uses real timers with tiny values: bun has no
// reliable fake timers, and gate.js is designed so these tests need none (interval 5 / timeout 30).
const { describe, test, expect } = require("bun:test");
const { makeSelectorGate } = require("./gate");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No-op probe that stays silent forever (always false / always rejects).
const neverPresent = () => Promise.resolve(false);
const alwaysReject = () => Promise.reject(new Error("probe exploded"));

describe("makeSelectorGate", () => {
  test("calls ready() once when probe() resolves true on the first tick", async () => {
    let calls = 0;
    makeSelectorGate(
      () => Promise.resolve(true),
      () => {
        calls += 1;
      },
      { intervalMs: 5, timeoutMs: 30 },
    );
    await sleep(50);
    expect(calls).toBe(1);
    // Long past the timeout too: still exactly once.
    await sleep(40);
    expect(calls).toBe(1);
  });

  test("probe() always false -> ready() only on timeout, exactly once", async () => {
    let calls = 0;
    let readyAt = 0;
    const startedAt = Date.now();
    makeSelectorGate(
      neverPresent,
      () => {
        calls += 1;
        readyAt = Date.now();
      },
      { intervalMs: 5, timeoutMs: 30 },
    );
    await sleep(100);
    expect(calls).toBe(1);
    // Timers never fire early: the only path here is the 30ms timeout.
    expect(readyAt - startedAt).toBeGreaterThanOrEqual(30 - 5);
    await sleep(60);
    expect(calls).toBe(1);
  });

  test("probe() rejects -> keeps polling, ready() on timeout exactly once", async () => {
    let calls = 0;
    makeSelectorGate(
      alwaysReject,
      () => {
        calls += 1;
      },
      { intervalMs: 5, timeoutMs: 30 },
    );
    await sleep(100);
    expect(calls).toBe(1);
    await sleep(60);
    expect(calls).toBe(1);
  });

  test("stop() runs ready() once synchronously; repeated stops add no further ready()", async () => {
    let calls = 0;
    const gate = makeSelectorGate(
      neverPresent,
      () => {
        calls += 1;
      },
      { intervalMs: 5, timeoutMs: 30 },
    );
    gate.stop();
    expect(calls).toBe(1);
    gate.stop();
    gate.stop();
    expect(calls).toBe(1);
    // Well past what would have been the timeout: timers were cleared, nothing more fires.
    await sleep(80);
    expect(calls).toBe(1);
  });

  test("a throwing ready() neither propagates nor crashes; ready() still runs once", async () => {
    let calls = 0;
    let gate;
    expect(() => {
      gate = makeSelectorGate(
        () => Promise.resolve(true),
        () => {
          calls += 1;
          throw new Error("ready exploded");
        },
        { intervalMs: 5, timeoutMs: 30 },
      );
    }).not.toThrow();
    expect(gate).toBeDefined();
    await sleep(50);
    expect(calls).toBe(1);
    await sleep(40);
    expect(calls).toBe(1);
  });
});

// Selector-poll gate helper for compat-adapter renderer timing (Path A).
//
// Pure JS — no electron import, no top-level side effects — so this file is importable under
// `bun test` with no host. An adapter uses it to delay its `ready()` until the app's OWN
// UI-ready signal appears (e.g. Obsidian's `.workspace` root) instead of the runtime's fixed
// `did-finish-load` timing.
//
// Fail-open: `ready()` is always called exactly once — when `probe()` first resolves true, when
// `timeoutMs` elapses, or when `stop()` is called. All timers are cleared on finish.

// Poll `probe()` (async, returns Promise<boolean>) every `intervalMs`; when it resolves true
// (or `timeoutMs` elapses, or `stop()` is called) call `ready()` exactly once and clean up.
function makeSelectorGate(probe, ready, opts = {}) {
  const intervalMs = typeof opts.intervalMs === "number" ? opts.intervalMs : 200;
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 15000;
  let done = false;
  let timer = null;
  let timeout = null;
  const finish = () => {
    if (done) return; // exactly-once
    done = true;
    if (timer !== null) clearInterval(timer);
    if (timeout !== null) clearTimeout(timeout);
    try {
      ready();
    } catch (_e) {
      // ready() must not rethrow into a timer.
    }
  };
  timer = setInterval(() => {
    if (done) return;
    Promise.resolve()
      .then(() => probe())
      .then((present) => {
        if (present) finish();
      })
      .catch(() => {
        // Transient rejection — retry next tick.
      });
  }, intervalMs);
  timeout = setTimeout(finish, timeoutMs);
  return { stop: finish };
}

module.exports = { makeSelectorGate };

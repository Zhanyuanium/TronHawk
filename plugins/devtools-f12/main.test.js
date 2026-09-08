// Lifecycle tests for the devtools-f12 main plugin, against fake Electron
// surfaces (no host needed). Run: bun test plugins/devtools-f12
import { describe, test, expect } from "bun:test";
import plugin from "./main.js";

function makeLogger() {
  return { infos: [], warns: [], info(m) { this.infos.push(m); }, warn(m) { this.warns.push(m); } };
}

function makeContents() {
  const listeners = {};
  return {
    devToolsOpened: false,
    preventDefaultCalls: 0,
    isDevToolsOpened() { return this.devToolsOpened; },
    openDevTools() { this.devToolsOpened = true; },
    closeDevTools() { this.devToolsOpened = false; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    listenerCount(ev) { return (listeners[ev] || []).length; },
    emit(ev, ...args) { (listeners[ev] || []).slice().forEach((f) => f(...args)); },
  };
}

function makeElectron(windows = []) {
  const appListeners = {};
  const app = {
    on(ev, fn) { (appListeners[ev] = appListeners[ev] || []).push(fn); },
    off(ev, fn) { appListeners[ev] = (appListeners[ev] || []).filter((f) => f !== fn); },
    listenerCount(ev) { return (appListeners[ev] || []).length; },
    emit(ev, ...args) { (appListeners[ev] || []).slice().forEach((f) => f(...args)); },
  };
  const wins = windows.map((c) => ({ webContents: c }));
  return { app, BrowserWindow: { getAllWindows: () => wins.slice(), _wins: wins } };
}

function f12Event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

const bareF12 = { type: "keyDown", key: "F12", code: "F12" };

function ctxWith(electron) {
  return { logger: makeLogger(), raw: { electron } };
}

describe("devtools-f12", () => {
  test("bare F12 toggles the event's own window DevTools", () => {
    const a = makeContents();
    const b = makeContents();
    const electron = makeElectron([a, b]);
    const ctx = ctxWith(electron);
    plugin.activate(ctx);
    expect(ctx.logger.infos.join("\n")).toMatch(/windows watched: 2/);

    const ev = f12Event();
    a.emit("before-input-event", ev, { ...bareF12 });
    expect(ev.prevented).toBe(true);
    expect(a.devToolsOpened).toBe(true);
    expect(b.devToolsOpened).toBe(false);

    a.emit("before-input-event", f12Event(), { ...bareF12 });
    expect(a.devToolsOpened).toBe(false);
    plugin.deactivate(ctx);
  });

  test("modifiers, auto-repeat and non-F12 keys are ignored", () => {
    const c = makeContents();
    const ctx = ctxWith(makeElectron([c]));
    plugin.activate(ctx);
    const cases = [
      { ...bareF12, shift: true },
      { ...bareF12, control: true },
      { ...bareF12, alt: true },
      { ...bareF12, meta: true },
      { ...bareF12, isAutoRepeat: true },
      { type: "keyUp", key: "F12", code: "F12" },
      { type: "keyDown", key: "F11", code: "F11" },
    ];
    for (const input of cases) {
      const ev = f12Event();
      c.emit("before-input-event", ev, input);
      expect(c.devToolsOpened).toBe(false);
      expect(ev.prevented).toBe(false);
    }
    plugin.deactivate(ctx);
  });

  test("windows created later are watched", () => {
    const electron = makeElectron([]);
    const ctx = ctxWith(electron);
    plugin.activate(ctx);
    const c = makeContents();
    electron.app.emit("browser-window-created", {}, { webContents: c });
    c.emit("before-input-event", f12Event(), { ...bareF12 });
    expect(c.devToolsOpened).toBe(true);
    plugin.deactivate(ctx);
  });

  test("deactivate removes every listener; reactivate does not stack", () => {
    const c = makeContents();
    const electron = makeElectron([c]);
    const ctx = ctxWith(electron);
    plugin.activate(ctx);
    plugin.deactivate(ctx);
    expect(c.listenerCount("before-input-event")).toBe(0);
    expect(electron.app.listenerCount("browser-window-created")).toBe(0);
    expect(ctx.logger.infos).toContain("devtools-f12 deactivated");

    // After deactivate, F12 does nothing.
    c.emit("before-input-event", f12Event(), { ...bareF12 });
    expect(c.devToolsOpened).toBe(false);

    // Reactivate twice: still exactly one toggle per keypress.
    plugin.activate(ctx);
    plugin.activate(ctx);
    expect(c.listenerCount("before-input-event")).toBe(1);
    c.emit("before-input-event", f12Event(), { ...bareF12 });
    expect(c.devToolsOpened).toBe(true);
    plugin.deactivate(ctx);
    expect(c.listenerCount("before-input-event")).toBe(0);
  });

  test("missing ctx.raw warns once and attaches nothing", () => {
    const ctx = { logger: makeLogger() };
    plugin.activate(ctx);
    expect(ctx.logger.warns.join("\n")).toMatch(/ctx\.raw absent/);
    plugin.deactivate(ctx);
  });
});

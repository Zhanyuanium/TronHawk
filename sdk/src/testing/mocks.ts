// Permission-aware mock contexts for plugin unit tests (no host required).
//
// Unlike the legacy `createMockRendererContext`/`createMockMainContext` in the
// package root (which succeed on every API by default), these harnesses fail
// closed: `grants` defaults to `[]` and each API checks its own permission
// before running. An ungranted sync API throws, an ungranted async API
// rejects, and `ctx.raw` is absent without `runtime.unsafe`.
//
// Every invocation — granted or denied — is appended to `calls.ordered` with
// a monotonically increasing `seq`, so tests can assert cross-API ordering.
// The per-API arrays (`cssInsert`, `domQuery`, `scriptSetTitle`, …) record
// successful calls only.

import type {
  DomElement,
  MainContext,
  NetworkRequest,
  NetworkResponse,
  RawAPI,
  RendererContext,
  WindowHandle,
} from "../index";
import { invokeEventCallback } from "./lifecycle";
import {
  deniedError,
  normalizeGrants,
  type PluginPermission,
} from "./permissions";

/** API names used in the ordered call record. */
export type TestingApiName =
  | "css.insert"
  | "css.remove"
  | "dom.query"
  | "dom.observe"
  | "dom.disconnect"
  | "script.setDocumentTitle"
  | "storage.get"
  | "storage.set"
  | "windowControls.mount"
  | "windowControls.unmount"
  | "network.request"
  | "window.onCreated"
  | "window.setOpacity"
  | "window.setSize"
  | "window.setPosition"
  | "window.setVibrancy"
  | "window.setMica"
  | "onLoad"
  | "onRendererReady"
  | "onUnload";

/** One recorded invocation attempt. `denied` marks fail-closed rejections. */
export interface OrderedCall {
  seq: number;
  api: TestingApiName;
  args: unknown[];
  denied: boolean;
}

export interface CssInsertRecord {
  seq: number;
  css: string;
  styleId: string;
}
export interface CssRemoveRecord {
  seq: number;
  id: string;
}
export interface DomQueryRecord {
  seq: number;
  selector: string;
}
export interface DomObserveRecord {
  seq: number;
  selector: string;
}
export interface ScriptTitleRecord {
  seq: number;
  title: string;
}
export interface NetworkRequestRecord {
  seq: number;
  url: string;
  method?: string;
}
export interface StorageGetRecord {
  seq: number;
  key: string;
}
export interface StorageSetRecord {
  seq: number;
  key: string;
  value: string;
}
export interface WindowControlsMountRecord {
  seq: number;
}
export interface WindowControlsUnmountRecord {
  seq: number;
}

/** Successful-call records for a renderer harness, plus the ordered log. */
export interface RendererCalls {
  cssInsert: CssInsertRecord[];
  cssRemove: CssRemoveRecord[];
  domQuery: DomQueryRecord[];
  domObserve: DomObserveRecord[];
  scriptSetTitle: ScriptTitleRecord[];
  networkRequest: NetworkRequestRecord[];
  storageGet: StorageGetRecord[];
  storageSet: StorageSetRecord[];
  windowControlsMount: WindowControlsMountRecord[];
  windowControlsUnmount: WindowControlsUnmountRecord[];
  ordered: OrderedCall[];
}

export interface MainCalls {
  windowOnCreated: Array<{ seq: number }>;
  windowSetOpacity: Array<{ seq: number; window: WindowHandle; opacity: number }>;
  windowSetSize: Array<{
    seq: number;
    window: WindowHandle;
    width: number;
    height: number;
  }>;
  windowSetPosition: Array<{
    seq: number;
    window: WindowHandle;
    x: number;
    y: number;
  }>;
  windowSetVibrancy: Array<{
    seq: number;
    window: WindowHandle;
    material: string;
  }>;
  windowSetMica: Array<{
    seq: number;
    window: WindowHandle;
    enabled: boolean;
  }>;
  eventSubscriptions: Array<{
    seq: number;
    event: "onLoad" | "onRendererReady" | "onUnload";
  }>;
  networkRequest: NetworkRequestRecord[];
  ordered: OrderedCall[];
}

export interface LoggerMessage {
  level: "info" | "warn" | "error";
  message: string;
}

/** Options for {@link createTestingRendererContext}. */
export interface RendererTestingOptions {
  /** Declared grants to allow. Defaults to `[]` (deny everything gated). */
  grants?: readonly PluginPermission[];
  pluginId?: string;
  /** Canned `dom.query` handler. Defaults to resolving `null` (no match). */
  domQuery?: (
    selector: string,
  ) => DomElement | null | Promise<DomElement | null>;
  /** Canned `network.request` handler. Defaults to a canned 200 response. */
  network?: (
    req: NetworkRequest,
  ) => NetworkResponse | Promise<NetworkResponse>;
  /** Seed entries for the in-memory `storage` namespace. */
  storageSeed?: Readonly<Record<string, string>>;
  /** Override for `ctx.raw` when `runtime.unsafe` is granted. */
  rawStub?: RawAPI;
}

/** Options for {@link createTestingMainContext}. */
export interface MainTestingOptions {
  /** Declared grants to allow. Defaults to `[]` (deny everything gated). */
  grants?: readonly PluginPermission[];
  pluginId?: string;
  /** Canned `network.request` handler. Defaults to a canned 200 response. */
  network?: (
    req: NetworkRequest,
  ) => NetworkResponse | Promise<NetworkResponse>;
  /** Override for `ctx.raw` when `runtime.unsafe` is granted. */
  rawStub?: RawAPI;
}

/** A registered `dom.observe` subscription. */
export interface DomObserverEntry {
  selector: string;
  callback: (node: DomElement) => unknown;
  disconnected: boolean;
}

function sampleRawStub(): RawAPI {
  return {
    electron: {},
    node: {
      require: () => {
        throw new Error("test raw stub has no modules");
      },
      process: {},
    },
  };
}

function createRecorder() {
  let next = 0;
  const ordered: OrderedCall[] = [];
  const record = (
    api: TestingApiName,
    args: unknown[],
    denied: boolean,
  ): number => {
    const seq = next++;
    ordered.push({ seq, api, args, denied });
    return seq;
  };
  return { ordered, record };
}

function createRecordingLogger(loggerMessages: LoggerMessage[]) {
  const push =
    (level: LoggerMessage["level"]) =>
    (message: string): void => {
      loggerMessages.push({ level, message });
    };
  return { info: push("info"), warn: push("warn"), error: push("error") };
}

/** Renderer harness: permission-aware `ctx`, call records, DOM emit tools. */
export interface TestingRendererHarness {
  ctx: RendererContext;
  calls: RendererCalls;
  /** Active `dom.observe` subscriptions (including disconnected ones). */
  domObservers: DomObserverEntry[];
  /**
   * Deliver `node` to every connected observer of `selector`, asserting the
   * synchronous-`undefined` contract on each callback. Throws
   * `ContractViolationError` on the first violating callback.
   */
  emitDom(selector: string, node: DomElement): void;
  /** Current in-memory storage entries (for assertions). */
  storageEntries(): Array<[string, string]>;
  loggerMessages: LoggerMessage[];
}

/**
 * Create a permission-aware renderer context. Only the APIs covered by
 * `options.grants` succeed; every other gated API throws (sync) or rejects
 * (async) with a `<permission> not granted` error.
 */
export function createTestingRendererContext(
  options: RendererTestingOptions = {},
): TestingRendererHarness {
  const granted = normalizeGrants(options.grants);
  void (options.pluginId ?? "test.plugin");
  const { ordered, record } = createRecorder();
  const calls: RendererCalls = {
    cssInsert: [],
    cssRemove: [],
    domQuery: [],
    domObserve: [],
    scriptSetTitle: [],
    networkRequest: [],
    storageGet: [],
    storageSet: [],
    windowControlsMount: [],
    windowControlsUnmount: [],
    ordered,
  };
  const loggerMessages: LoggerMessage[] = [];
  const configStore = new Map<string, unknown>();
  const storage = new Map<string, string>(
    Object.entries(options.storageSeed ?? {}),
  );
  const domObservers: DomObserverEntry[] = [];
  let styleCounter = 0;
  const liveStyles = new Set<string>();

  const ctx: RendererContext = {
    logger: createRecordingLogger(loggerMessages),
    network: {
      request: async (req: NetworkRequest): Promise<NetworkResponse> => {
        const denied = !granted.has("network.access");
        const seq = record(
          "network.request",
          [req],
          denied,
        );
        if (denied) throw deniedError("network.access", "network.request");
        calls.networkRequest.push({
          seq,
          url: req.url,
          method: req.method,
        });
        if (options.network) return options.network(req);
        return { status: 200, headers: {}, body: "" };
      },
    },
    config: {
      get: (key: string): unknown => configStore.get(key),
      set: (key: string, value: unknown): void => {
        configStore.set(key, value);
      },
    },
    css: {
      // Host parity: insertion bridges `webContents.insertCSS`, so it is
      // asynchronous — `insert` resolves to the style id, `remove` settles
      // after the bounded host retry window. Denied calls reject.
      insert: async (css: string): Promise<string> => {
        const denied = !granted.has("renderer.css");
        const seq = record("css.insert", [css], denied);
        if (denied) throw deniedError("renderer.css", "css.insert");
        const styleId = `test-style-${++styleCounter}`;
        liveStyles.add(styleId);
        calls.cssInsert.push({ seq, css, styleId });
        return styleId;
      },
      remove: async (id: string): Promise<void> => {
        const denied = !granted.has("renderer.css");
        const seq = record("css.remove", [id], denied);
        if (denied) throw deniedError("renderer.css", "css.remove");
        liveStyles.delete(id);
        calls.cssRemove.push({ seq, id });
      },
    },
    dom: {
      query: async (selector: string): Promise<DomElement | null> => {
        const denied = !granted.has("renderer.dom");
        const seq = record("dom.query", [selector], denied);
        if (denied) throw deniedError("renderer.dom", "dom.query");
        calls.domQuery.push({ seq, selector });
        if (options.domQuery) return options.domQuery(selector);
        return null;
      },
      observe: (
        selector: string,
        cb: (node: DomElement) => void,
      ): (() => void) => {
        const denied = !granted.has("renderer.dom");
        const seq = record("dom.observe", [selector], denied);
        if (denied) throw deniedError("renderer.dom", "dom.observe");
        calls.domObserve.push({ seq, selector });
        const entry: DomObserverEntry = {
          selector,
          callback: cb as (node: DomElement) => unknown,
          disconnected: false,
        };
        domObservers.push(entry);
        // Host parity: disconnect is idempotent — only the first (effective)
        // call records and marks; repeats are silent no-ops.
        return () => {
          if (entry.disconnected) return;
          record("dom.disconnect", [selector], false);
          entry.disconnected = true;
        };
      },
    },
    script: {
      setDocumentTitle: (title: string): void => {
        const denied = !granted.has("renderer.script");
        const seq = record("script.setDocumentTitle", [title], denied);
        if (denied)
          throw deniedError("renderer.script", "script.setDocumentTitle");
        calls.scriptSetTitle.push({ seq, title });
      },
    },
    storage: {
      get: async (key: string): Promise<string | null> => {
        const denied = !granted.has("renderer.storage");
        const seq = record("storage.get", [key], denied);
        if (denied) throw deniedError("renderer.storage", "storage.get");
        calls.storageGet.push({ seq, key });
        return storage.get(key) ?? null;
      },
      set: async (key: string, value: string): Promise<void> => {
        const denied = !granted.has("renderer.storage");
        const seq = record("storage.set", [key, value], denied);
        if (denied) throw deniedError("renderer.storage", "storage.set");
        calls.storageSet.push({ seq, key, value });
        storage.set(key, value);
      },
    },
    windowControls: {
      mount: async (): Promise<void> => {
        const denied = !granted.has("electron.windowControls");
        const seq = record("windowControls.mount", [], denied);
        if (denied)
          throw deniedError(
            "electron.windowControls",
            "windowControls.mount",
          );
        calls.windowControlsMount.push({ seq });
      },
      unmount: async (): Promise<void> => {
        const denied = !granted.has("electron.windowControls");
        const seq = record("windowControls.unmount", [], denied);
        if (denied)
          throw deniedError(
            "electron.windowControls",
            "windowControls.unmount",
          );
        calls.windowControlsUnmount.push({ seq });
      },
    },
    ...(granted.has("runtime.unsafe")
      ? { raw: options.rawStub ?? sampleRawStub() }
      : {}),
  };

  const emitDom = (selector: string, node: DomElement): void => {
    for (const entry of domObservers) {
      if (entry.selector !== selector || entry.disconnected) continue;
      try {
        invokeEventCallback(
          `dom.observe("${selector}") callback`,
          entry.callback,
          node,
        );
      } catch (e) {
        // Host parity (fail-closed): a violating callback is unregistered and
        // never re-invoked; the violation still propagates so the test sees it.
        entry.disconnected = true;
        throw e;
      }
    }
  };

  return {
    ctx,
    calls,
    domObservers,
    emitDom,
    storageEntries: () => [...storage.entries()],
    loggerMessages,
  };
}

/** Main harness: permission-aware `ctx`, call records, lifecycle emit tools. */
export interface TestingMainHarness {
  ctx: MainContext;
  calls: MainCalls;
  events: {
    onCreated: Array<(window: WindowHandle) => unknown>;
    onLoad: Array<() => unknown>;
    onRendererReady: Array<(window: WindowHandle) => unknown>;
    onUnload: Array<(window: WindowHandle) => unknown>;
  };
  /** Fire captured `window.onCreated` callbacks (contract-asserted). */
  emitCreated(window: WindowHandle): void;
  /** Fire captured `onLoad` callbacks (contract-asserted). */
  emitLoad(): void;
  /** Fire captured `onRendererReady` callbacks (contract-asserted). */
  emitRendererReady(window: WindowHandle): void;
  /** Fire captured `onUnload` callbacks (contract-asserted). */
  emitUnload(window: WindowHandle): void;
  loggerMessages: LoggerMessage[];
}

/**
 * Create a permission-aware main context. `window.*` and the lifecycle
 * events require `electron.window`; `network.request` requires
 * `network.access`; `ctx.raw` is absent without `runtime.unsafe`.
 */
export function createTestingMainContext(
  options: MainTestingOptions = {},
): TestingMainHarness {
  const granted = normalizeGrants(options.grants);
  void (options.pluginId ?? "test.plugin");
  const { ordered, record } = createRecorder();
  const calls: MainCalls = {
    windowOnCreated: [],
    windowSetOpacity: [],
    windowSetSize: [],
    windowSetPosition: [],
    windowSetVibrancy: [],
    windowSetMica: [],
    eventSubscriptions: [],
    networkRequest: [],
    ordered,
  };
  const loggerMessages: LoggerMessage[] = [];
  const configStore = new Map<string, unknown>();
  const events: TestingMainHarness["events"] = {
    onCreated: [],
    onLoad: [],
    onRendererReady: [],
    onUnload: [],
  };

  const ctx: MainContext = {
    logger: createRecordingLogger(loggerMessages),
    network: {
      request: async (req: NetworkRequest): Promise<NetworkResponse> => {
        const denied = !granted.has("network.access");
        const seq = record("network.request", [req], denied);
        if (denied) throw deniedError("network.access", "network.request");
        calls.networkRequest.push({
          seq,
          url: req.url,
          method: req.method,
        });
        if (options.network) return options.network(req);
        return { status: 200, headers: {}, body: "" };
      },
    },
    config: {
      get: (key: string): unknown => configStore.get(key),
      set: (key: string, value: unknown): void => {
        configStore.set(key, value);
      },
    },
    window: {
      // [authoring rule — unified WindowHandle] The host issues BrowserWindow.id
      // from all three lifecycle events when a live window is bound (onCreated
      // already did; onRendererReady/onUnload now match — issuedWindowHandle
      // in crates/runtime/js/src/index.js). Contents-only (no BrowserWindow)
      // still issues webContents.id. Window ops resolve via fromId then a
      // webContents-id scan on miss. Cross-namespace same-value collision
      // (A {id:100, webContents.id:1} vs B {id:1, webContents.id:2}) is
      // avoided by unified issuance — Electron's two counters are independent
      // and do collide. The mocks are pass-through + record, so any numeric
      // handle flows unchanged from emit* into the op records — the E2E proof
      // lives host-side ("unified WindowHandle" / collision in platform.test.js).
      onCreated: (cb: (window: WindowHandle) => undefined): void => {
        const denied = !granted.has("electron.window");
        const seq = record("window.onCreated", [], denied);
        if (denied) throw deniedError("electron.window", "window.onCreated");
        calls.windowOnCreated.push({ seq });
        events.onCreated.push(cb as (window: WindowHandle) => unknown);
      },
      setOpacity: (window: WindowHandle, opacity: number): void => {
        const denied = !granted.has("electron.window");
        const seq = record("window.setOpacity", [window, opacity], denied);
        if (denied)
          throw deniedError("electron.window", "window.setOpacity");
        calls.windowSetOpacity.push({ seq, window, opacity });
      },
      setSize: (
        window: WindowHandle,
        width: number,
        height: number,
      ): void => {
        const denied = !granted.has("electron.window");
        const seq = record(
          "window.setSize",
          [window, width, height],
          denied,
        );
        if (denied) throw deniedError("electron.window", "window.setSize");
        calls.windowSetSize.push({ seq, window, width, height });
      },
      setPosition: (window: WindowHandle, x: number, y: number): void => {
        const denied = !granted.has("electron.window");
        const seq = record("window.setPosition", [window, x, y], denied);
        if (denied)
          throw deniedError("electron.window", "window.setPosition");
        calls.windowSetPosition.push({ seq, window, x, y });
      },
      setVibrancy: (window: WindowHandle, material: string): void => {
        const denied = !granted.has("electron.window");
        const seq = record("window.setVibrancy", [window, material], denied);
        if (denied)
          throw deniedError("electron.window", "window.setVibrancy");
        calls.windowSetVibrancy.push({ seq, window, material });
      },
      setMica: (window: WindowHandle, enabled: boolean): void => {
        const denied = !granted.has("electron.window");
        const seq = record("window.setMica", [window, enabled], denied);
        if (denied) throw deniedError("electron.window", "window.setMica");
        calls.windowSetMica.push({ seq, window, enabled });
      },
    },
    onLoad: (cb: () => undefined): void => {
      const denied = !granted.has("electron.window");
      const seq = record("onLoad", [], denied);
      if (denied) throw deniedError("electron.window", "onLoad");
      calls.eventSubscriptions.push({ seq, event: "onLoad" });
      events.onLoad.push(cb as () => unknown);
    },
    onRendererReady: (cb: (window: WindowHandle) => undefined): void => {
      const denied = !granted.has("electron.window");
      const seq = record("onRendererReady", [], denied);
      if (denied)
        throw deniedError("electron.window", "onRendererReady");
      calls.eventSubscriptions.push({ seq, event: "onRendererReady" });
      events.onRendererReady.push(cb as (window: WindowHandle) => unknown);
    },
    onUnload: (cb: (window: WindowHandle) => undefined): void => {
      const denied = !granted.has("electron.window");
      const seq = record("onUnload", [], denied);
      if (denied) throw deniedError("electron.window", "onUnload");
      calls.eventSubscriptions.push({ seq, event: "onUnload" });
      events.onUnload.push(cb as (window: WindowHandle) => unknown);
    },
    ...(granted.has("runtime.unsafe")
      ? { raw: options.rawStub ?? sampleRawStub() }
      : {}),
  };

  return {
    ctx,
    calls,
    events,
    // Host parity (fail-closed): a violating callback is unregistered and never
    // re-invoked; the violation still propagates so the test sees it.
    emitCreated: (window: WindowHandle): void => {
      for (let i = 0; i < events.onCreated.length; i++) {
        try {
          invokeEventCallback("window.onCreated callback", events.onCreated[i], window);
        } catch (e) {
          events.onCreated.splice(i, 1);
          i--;
          throw e;
        }
      }
    },
    emitLoad: (): void => {
      for (let i = 0; i < events.onLoad.length; i++) {
        try {
          invokeEventCallback("onLoad callback", events.onLoad[i]);
        } catch (e) {
          events.onLoad.splice(i, 1);
          i--;
          throw e;
        }
      }
    },
    emitRendererReady: (window: WindowHandle): void => {
      for (let i = 0; i < events.onRendererReady.length; i++) {
        try {
          invokeEventCallback(
            "onRendererReady callback",
            events.onRendererReady[i],
            window,
          );
        } catch (e) {
          events.onRendererReady.splice(i, 1);
          i--;
          throw e;
        }
      }
    },
    emitUnload: (window: WindowHandle): void => {
      for (let i = 0; i < events.onUnload.length; i++) {
        try {
          invokeEventCallback("onUnload callback", events.onUnload[i], window);
        } catch (e) {
          events.onUnload.splice(i, 1);
          i--;
          throw e;
        }
      }
    },
    loggerMessages,
  };
}

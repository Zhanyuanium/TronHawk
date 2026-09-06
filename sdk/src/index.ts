// Public plugin API for TronHawk. This file is the stable public contract.
// See docs/PLUGIN-SDK.md. Any breaking change requires a doc update + version bump.

/** Opaque window handle assigned by the runtime. Plugins must treat it as opaque.
 *  Host parity: the runtime passes the numeric Electron webContents/window id
 *  straight through (`BrowserWindow.fromId` key), so handles are numbers. */
export type WindowHandle = number;

/** Present ONLY when `runtime.unsafe` is granted AND developer mode is enabled by the user.
 *  Deliberate exception: plugin code runs with the full Node/Electron environment of the
 *  injected app's main process (arbitrary code execution). Never exposed to a sandboxed plugin. */
export interface RawAPI {
  /** The real Electron module of the injected application. */
  electron: unknown;
  /** The real Node.js runtime of the injected app's main process. */
  node: { require(moduleName: string): unknown; process: unknown };
}

// --- Base context (cross-cutting services available in every execution context) ---

export interface Logger {
  /** Submit a string message attributed to this plugin by the host. */
  info(message: string): void;
  /** Submit a string message attributed to this plugin by the host. */
  warn(message: string): void;
  /** Submit a string message attributed to this plugin by the host. */
  error(message: string): void;
}

export interface NetworkRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Requires the `network.access` permission. `request` runs a Core-side, domain-whitelisted fetch —
 *  the plugin never opens a raw socket. The returned promise rejects with a catchable error when the
 *  URL is outside the whitelist or the fetch itself fails. */
export interface NetworkAPI {
  request(req: NetworkRequest): Promise<NetworkResponse>;
}

export interface ConfigAPI {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface PluginContext {
  logger: Logger;
  network: NetworkAPI;
  config: ConfigAPI;
  /** Present only when `runtime.unsafe` is granted AND developer mode is enabled. See `RawAPI`. */
  raw?: RawAPI;
}

// --- Renderer context (MVP) ---

export interface CssAPI {
  /** Insert a stylesheet; resolves to a unique id scoped to the owning plugin.
   *  Host parity: the runtime bridges `webContents.insertCSS`, so insertion is
   *  asynchronous — `insert` returns a Promise of the key. */
  insert(css: string): Promise<string>;
  /** Revoke a previously inserted stylesheet. Host parity: asynchronous — the
   *  runtime retries removal over a bounded window before settling. */
  remove(id: string): Promise<void>;
}

/** A serialized snapshot of a page element, captured host-side. This is NOT a live DOM node: a real
 *  `Element` cannot cross the QuickJS sandbox boundary, so the host copies the fields below at
 *  snapshot time. Later page mutations do not update an already-returned snapshot. */
export interface DomElement {
  /** Runtime-assigned ordinal identifying this node within the renderer's snapshot registry. */
  nodeId: number;
  /** Lowercased tag name, e.g. `"button"`. */
  tag: string;
  /** The element's `id` attribute (empty string when absent). */
  id: string;
  /** The element's `className` attribute (empty string when absent). */
  className: string;
  /** Other serialized attributes, e.g. `{ role: "dialog" }`. */
  attrs: Record<string, string>;
  /** The element's own text content (host-bounded length). */
  text: string;
  /** Layout rectangle relative to the viewport; present when the element is rendered. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Present for form fields: the current `value`. */
  value?: string;
  /** Present for checkbox/radio inputs: the current checked state. */
  checked?: boolean;
  /** Present for `<a>` elements: the resolved `href`. */
  href?: string;
  /** Present for `<img>` / `<script>` / `<iframe>` elements: the resolved `src`. */
  src?: string;
}

export interface DomAPI {
  /** Resolve the first element matching `selector` and return a host-serialized snapshot of it, or
   *  `null` when no element matches. Requires `renderer.dom`. The resolved object is a snapshot copy,
   *  not a live node; the promise rejects only on a query error (e.g. an invalid selector). */
  query(selector: string): Promise<DomElement | null>;
  /** Observe elements matching `selector`; `cb` is invoked with a serialized snapshot of each newly
   *  observed node. The bridge polls on a 500 ms cadence, so a snapshot lags live DOM by up to one
   *  poll interval. Returns a disconnect function that stops the observation. Requires
   *  `renderer.dom`. `cb` must complete synchronously and return `undefined`. */
  observe(selector: string, cb: (node: DomElement) => void): () => void;
}

export interface ScriptAPI {
  /** Set the page document title. Requires the `renderer.script` permission. */
  setDocumentTitle(title: string): void;
}

/** Renderer-only host storage (requires `renderer.storage`). Keys and values are strings. Every entry
 *  lives in the owning plugin's host-namespaced keyspace — the host stores it as
 *  `tronhawk:<pluginId>:<key>` — so one plugin can never read or overwrite another plugin's (or
 *  another app's view of the same plugin's) entries. Values are bounded by the host. */
export interface StorageAPI {
  /** Read the value stored under `key` in this plugin's namespace; resolves `null` when absent. */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key` in this plugin's namespace. */
  set(key: string, value: string): Promise<void>;
}

export interface RendererContext extends PluginContext {
  css: CssAPI;
  dom: DomAPI;
  script: ScriptAPI;
  /** Renderer-only host-namespaced string storage. Requires the `renderer.storage` permission. */
  storage: StorageAPI;
}

// --- Main context (MVP) ---

export interface WindowAPI {
  onCreated(cb: (window: WindowHandle) => undefined): void;
  setOpacity(window: WindowHandle, opacity: number): void;
  setSize(window: WindowHandle, width: number, height: number): void;
  setPosition(window: WindowHandle, x: number, y: number): void;
  /** macOS only; structured-log no-op on other platforms or when the Electron API is absent. */
  setVibrancy(window: WindowHandle, material: string): void;
  /** Windows 11 only; structured-log no-op on other platforms or when the Electron API is absent. */
  setMica(window: WindowHandle, enabled: boolean): void;
}

// Main-plugin lifecycle events (SPEC §9 MVP). These attach at the MAIN context ROOT — NOT under
// `ctx.window` — because they announce the host lifecycle (app loaded, renderer loaded, window
// unloaded) rather than mutate a window. They are main-context only; the renderer context does not
// expose them. Each registers a synchronous, `undefined`-returning callback that is invoked under
// the CPU-deadline contract and fails closed (a throwing, over-deadline, or non-void callback is
// unregistered by the runtime and never re-invoked). Each subscription is revoked when the plugin
// is deactivated or its plan revision is removed.

export interface MainContext extends PluginContext {
  window: WindowAPI;
  /** Fires exactly once per subscription — when the target app's main process has finished loading
   *  its original app (app ready). A subscription made after the app already loaded fires
   *  immediately, exactly once. No window argument. */
  onLoad(cb: () => undefined): void;
  /** Fires per window per renderer load (did-finish-load, i.e. per navigation), carrying the
   *  window's id. A subscription made after a window already loaded is replayed once for each such
   *  window. */
  onRendererReady(cb: (window: WindowHandle) => undefined): void;
  /** Fires when a window's webContents is destroyed (a quitting app destroys its windows, so this
   *  also covers app shutdown), carrying the destroyed window's id. */
  onUnload(cb: (window: WindowHandle) => undefined): void;
}

// --- Plugin module lifecycle ---

export type PluginModule<C extends PluginContext = PluginContext> = {
  /** Runs when the plugin is activated. May complete synchronously (returning nothing / `undefined`)
   *  or return a Promise; when it returns a Promise the runtime **drains** it before the plugin is
   *  considered active. A fulfilled Promise's resolve value is ignored — only a rejection fails
   *  the hook. */
  activate(ctx: C): void | Promise<unknown>;
  /** Runs when the plugin is deactivated (disable, plan revision, app teardown). May complete
   *  synchronously or return a Promise; the runtime drains a returned Promise before disposing the VM.
   *  A fulfilled Promise's resolve value is ignored — only a rejection fails the hook. */
  deactivate(ctx: C): void | Promise<unknown>;
};

// --- Utilities ---

/** Dev/testing helper. The runtime injects a host-attributed logger via `ctx.logger`. */
export function createLogger(pluginId: string): Logger {
  const log = (level: string) => (message: string): void => {
    if (typeof message === "string") console.log(`[${pluginId}][${level}] ${message}`);
  };
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

/** Convenience wrapper that delegates to the permission-checked `ctx.css.insert`. */
export function injectCSS(ctx: RendererContext, css: string): Promise<string> {
  return ctx.css.insert(css);
}

export function createMockRendererContext(
  overrides: Partial<RendererContext> = {},
): RendererContext {
  return {
    logger: createLogger("mock"),
    network: {
      request: async () => ({ status: 200, headers: {}, body: "" }),
    },
    config: { get: () => undefined, set: () => {} },
    css: { insert: async () => "mock-style", remove: async () => {} },
    dom: { query: async () => null, observe: () => () => {} },
    script: { setDocumentTitle: () => {} },
    storage: { get: async () => null, set: async () => {} },
    ...overrides,
  };
}

export function createMockMainContext(
  overrides: Partial<MainContext> = {},
): MainContext {
  return {
    logger: createLogger("mock"),
    network: {
      request: async () => ({ status: 200, headers: {}, body: "" }),
    },
    config: { get: () => undefined, set: () => {} },
    window: {
      onCreated: () => {},
      setOpacity: () => {},
      setSize: () => {},
      setPosition: () => {},
      setVibrancy: () => {},
      setMica: () => {},
    },
    onLoad: () => {},
    onRendererReady: () => {},
    onUnload: () => {},
    ...overrides,
  };
}

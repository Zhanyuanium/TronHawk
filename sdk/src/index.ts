// Public plugin API for TronHawk. This file is the stable public contract.
// See docs/PLUGIN-SDK.md. Any breaking change requires a doc update + version bump.

/** Opaque window handle assigned by the runtime. Plugins must treat it as opaque. */
export type WindowHandle = string;

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

/** Requires the `network.access` permission (and `network.proxy` for interception). */
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
  /** Insert a stylesheet; returns a unique id scoped to the owning plugin. */
  insert(css: string): string;
  remove(id: string): void;
}

export interface DomAPI {
  query(selector: string): Element | null;
  /** Observe dynamic DOM (MutationObserver abstraction); returns a disconnect function. */
  observe(selector: string, cb: (node: Element) => void): () => void;
}

export interface ScriptAPI {
  /** Set the page document title. Requires the `renderer.script` permission. */
  setDocumentTitle(title: string): void;
}

export interface RendererContext extends PluginContext {
  css: CssAPI;
  dom: DomAPI;
  script: ScriptAPI;
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

export interface WebContentsAPI {
  openDevTools(window: WindowHandle): void;
  reload(window: WindowHandle): void;
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
  webContents: WebContentsAPI;
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
  activate(ctx: C): undefined;
  deactivate(ctx: C): undefined;
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
export function injectCSS(ctx: RendererContext, css: string): string {
  return ctx.css.insert(css);
}

export function createMockRendererContext(
  overrides: Partial<RendererContext> = {},
): RendererContext {
  return {
    logger: createLogger("mock"),
    network: {
      request: async () => {
        throw new Error("not implemented");
      },
    },
    config: { get: () => undefined, set: () => {} },
    css: { insert: () => "mock-style", remove: () => {} },
    dom: { query: () => null, observe: () => () => {} },
    script: { setDocumentTitle: () => {} },
    ...overrides,
  };
}

export function createMockMainContext(
  overrides: Partial<MainContext> = {},
): MainContext {
  return {
    logger: createLogger("mock"),
    network: {
      request: async () => {
        throw new Error("not implemented");
      },
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
    webContents: {
      openDevTools: () => {},
      reload: () => {},
    },
    onLoad: () => {},
    onRendererReady: () => {},
    onUnload: () => {},
    ...overrides,
  };
}

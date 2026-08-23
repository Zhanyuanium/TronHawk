// Public plugin API for TronHawk. This file is the stable public contract.
// See docs/PLUGIN-SDK.md. Any breaking change requires a doc update + version bump.

/** Opaque window handle assigned by the runtime. Plugins must treat it as opaque. */
export type WindowHandle = string;

// --- Base context (cross-cutting services available in every execution context) ---

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
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
  /** Requires the `renderer.script` permission. */
  execute(code: string): unknown;
}

export interface RendererContext extends PluginContext {
  css: CssAPI;
  dom: DomAPI;
  script: ScriptAPI;
}

// --- Main context (MVP) ---

export interface WindowAPI {
  onCreated(cb: (window: WindowHandle) => void): void;
  setOpacity(window: WindowHandle, opacity: number): void;
  setSize(window: WindowHandle, width: number, height: number): void;
  setPosition(window: WindowHandle, x: number, y: number): void;
  /** macOS only; returns a structured error on unsupported platforms. */
  setVibrancy(window: WindowHandle, material: string): void;
  /** Windows 11 only; returns a structured error on unsupported platforms. */
  setMica(window: WindowHandle, enabled: boolean): void;
}

export interface WebContentsAPI {
  openDevTools(window: WindowHandle): void;
  reload(window: WindowHandle): void;
  executeJavaScript(window: WindowHandle, code: string): Promise<unknown>;
}

export interface MainContext extends PluginContext {
  window: WindowAPI;
  webContents: WebContentsAPI;
}

// --- Plugin module lifecycle ---

export type PluginModule<C extends PluginContext = PluginContext> = {
  activate(ctx: C): void | Promise<void>;
  deactivate(ctx: C): void | Promise<void>;
};

// --- Utilities ---

/** Dev/testing helper. The runtime injects the real logger via `ctx.logger`. */
export function createLogger(pluginId: string): Logger {
  const log = (level: string) => (message: string): void =>
    console.log(`[${pluginId}][${level}] ${message}`);
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
    script: { execute: () => undefined },
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
      executeJavaScript: async () => undefined,
    },
    ...overrides,
  };
}

export interface CssAPI {
  insert(css: string): string;
  remove(id: string): void;
}

export interface DomAPI {
  query(selector: string): unknown;
  observe(selector: string, cb: (node: unknown) => void): () => void;
}

export interface ScriptAPI {
  execute(code: string): unknown;
}

export interface StorageAPI {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface EventsAPI {
  on(event: string, cb: (...args: unknown[]) => void): void;
}

export interface WindowAPI {
  onCreated(cb: (win: unknown) => void): void;
  setOpacity(n: number): void;
  setSize(w: number, h: number): void;
  setPosition(x: number, y: number): void;
}

export interface WebContentsAPI {
  openDevTools(): void;
  reload(): void;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface SessionAPI {
  modify(opts: Record<string, unknown>): void;
}

export interface IpcAPI {
  on(channel: string, cb: (...args: unknown[]) => void): void;
  send(channel: string, ...args: unknown[]): void;
  intercept(...args: unknown[]): void;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface NetworkAPI {
  request(req: { url: string; method?: string }): Promise<unknown>;
}

export interface ConfigAPI {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface PluginContext {
  logger: Logger;
  network: NetworkAPI;
  config: ConfigAPI;
}

export interface RendererContext extends PluginContext {
  css: CssAPI;
  dom: DomAPI;
  script: ScriptAPI;
  storage: StorageAPI;
  events: EventsAPI;
}

export interface MainContext extends PluginContext {
  window: WindowAPI;
  webContents: WebContentsAPI;
  session: SessionAPI;
  ipc: IpcAPI;
}

export type PluginModule<C extends PluginContext = PluginContext> = {
  activate(ctx: C): void;
  deactivate(ctx: C): void;
};

export function injectCSS(_css: string): string {
  return "tronhawk-style-placeholder";
}

export function createLogger(pluginId: string): Logger {
  const log = (msg: string): void => console.log(`[${pluginId}] ${msg}`);

  return {
    info: log,
    warn: log,
    error: log,
  };
}

export async function requestNetwork(_req: {
  url: string;
  method?: string;
}): Promise<unknown> {
  throw new Error("not implemented");
}

export function mockElectron(): Record<string, unknown> {
  return {};
}

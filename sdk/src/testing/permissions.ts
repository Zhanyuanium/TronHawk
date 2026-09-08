// Permission identifiers for the SDK testing surface.
//
// Known set mirrors `KNOWN_PERMISSIONS` in `crates/package` (the pack-time
// authority) and the permissions tables in `docs/PLUGIN-SDK.md` / `SPEC.md` /
// `THX-FORMAT.md`. Implemented subset (wired to a host API today):
// `renderer.css` / `renderer.script` / `renderer.dom` / `renderer.storage` /
// `electron.window` / `electron.windowControls` / `network.access` /
// `runtime.unsafe`. Future (declared, no host surface yet): `electron.webContents`
// / `electron.session` / `electron.ipc` / `network.proxy`. The testing mocks
// fail closed on unknown ids: only the permissions listed in a harness's
// `grants` are allowed, everything else is denied.

/** Every known plugin permission id (pack-time authority: `tronhawk-package`). */
export type PluginPermission =
  | "renderer.css"
  | "renderer.script"
  | "renderer.dom"
  | "renderer.storage"
  | "electron.window"
  | "electron.windowControls"
  | "electron.webContents"
  | "electron.session"
  | "electron.ipc"
  | "network.access"
  | "network.proxy"
  | "runtime.unsafe";

/** Permissions wired to a host API today (see `docs/PLUGIN-SDK.md`). */
export const IMPLEMENTED_PERMISSIONS: readonly PluginPermission[] = [
  "renderer.css",
  "renderer.script",
  "renderer.dom",
  "renderer.storage",
  "electron.window",
  "electron.windowControls",
  "network.access",
  "runtime.unsafe",
];

/** Every known permission id. Useful for harnesses that need full grants. */
export const ALL_PERMISSIONS: readonly PluginPermission[] = [
  "renderer.css",
  "renderer.script",
  "renderer.dom",
  "renderer.storage",
  "electron.window",
  "electron.windowControls",
  "electron.webContents",
  "electron.session",
  "electron.ipc",
  "network.access",
  "network.proxy",
  "runtime.unsafe",
];

/** Normalize a grants list into a set. `undefined` means no grants (deny all). */
export function normalizeGrants(
  grants?: readonly PluginPermission[],
): ReadonlySet<PluginPermission> {
  return new Set(grants ?? []);
}

/** Check whether a grant set (or raw list) contains a permission. */
export function hasGrant(
  grants: ReadonlySet<PluginPermission> | readonly PluginPermission[],
  permission: PluginPermission,
): boolean {
  if ("has" in grants) return grants.has(permission);
  return grants.includes(permission);
}

/** Build the fail-closed error used when an API is called without its grant. */
export function deniedError(
  permission: PluginPermission,
  api: string,
): Error {
  return new Error(
    `${permission} not granted: ${api} is unavailable without the "${permission}" permission`,
  );
}

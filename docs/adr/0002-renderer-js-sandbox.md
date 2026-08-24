# ADR 0002 — Renderer JS sandbox (and main-runtime JS engine)

Status: **Accepted** (implementation deferred to Phase 3)

## Context

Plugins may declare `renderer.script` (execute page JS) and `renderer.dom` (DOM manipulation).
Open question #1 asked: isolated world vs page world. The Phase 1 review established that running
plugin JS in the page main world (`executeJavaScript`) is not a capability boundary — even a
CSS-only plugin could reach `document` / `fetch` / the page preload bridge. Phase 2 made CSS
data-only (injected via `insertCSS`, never evaluated), which closes the CSS path; this ADR decides
the remaining renderer-JS path.

## Options evaluated

| Option | Isolates DOM | Isolates network | Isolates Node/Electron | Complexity |
|---|---|---|---|---|
| Isolated world (`executeJavaScriptInIsolatedWorld`) | ❌ (has `document`) | ❌ (has `fetch`) | ✅ | Low |
| Sandboxed iframe (`sandbox`, no `allow-same-origin`) | ✅ | ✅ | ✅ | Medium |
| Node `vm` | ✅* | ✅ | ⚠️ (escape-prone) | Medium |
| QuickJS (embedded engine) | ✅ | ✅ | ✅ | Medium |
| Web Worker | ✅ | ⚠️ (`fetch` available) | ✅ | Low–Medium |

\* Node's own docs warn that `vm` is **not a security mechanism** (well-known escapes).

## Decision

1. **CSS-only plugins get zero JS execution** (implemented in Phase 2). CSS is data, injected via
   `webContents.insertCSS`; a plugin with only `renderer.css` never has its JS evaluated. This is
   a host-level rule, not a runtime check.

2. **`renderer.script` / `renderer.dom` plugins run in an embedded QuickJS engine**
   (`rquickjs` on the Rust side, or `quickjs-emscripten`), hosted in a worker/utility process. The
   QuickJS context has no `document` / `fetch` / `require` / `process`. Every granted capability
   (`ctx.dom.query`, `ctx.script.execute`, …) is a **host function** that performs the allow-listed
   operation on the real page via `webContents.executeJavaScript` (a privileged bridge). A plugin
   therefore reaches the page only through its granted host functions — never raw DOM/network/Node.

3. This also resolves open question #2 (main-runtime JS loading): use the same QuickJS engine for
   main-process plugins (`MainContext`) instead of Node `vm` or V8 context isolation.

## Why not the alternatives

- **Isolated world** is a JS-globals separator, not a capability gate — it still has `document`
  and `fetch`, so it cannot satisfy "script without raw DOM/network".
- **Node `vm`** is explicitly documented as not a security boundary.
- **Sandboxed iframe / Web Worker** isolate DOM but force every DOM operation through an async
  serialized round-trip; QuickJS host functions provide the same bridge with a leaner engine and
  no full browser context.

## Consequences

- Phase 3 adds an embedded JS engine (`rquickjs` / `quickjs-emscripten`) + host-function bindings
  for the granted `ctx` APIs. Until then, `renderer.script` / `renderer.dom` are not exposed.
- `renderer.script` / `renderer.dom` permission semantics: the plugin runs in the sandbox and
  reaches the page only through its granted host functions.
- `runtime.unsafe` remains the only path to raw Electron/Node (developer mode, off by default).

## References

- Electron `webContents` / `contextBridge` / context-isolation / process-sandbox docs; Chrome
  content-script (isolated-world) model; Node `vm` docs ("not a security mechanism"); QuickJS
  sandboxing precedents (Vercel AI `code-mode`, Bruno, Warp, Figma).

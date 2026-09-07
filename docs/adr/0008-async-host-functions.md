# ADR 0008 — Async host functions (Option B): host-driven pending-job pump

Status: **Accepted** (SDK 0.5.0 types + docs; the runtime pending-job pump and the Core `network`
dom/storage lanes land in parallel)

## Context

ADR 0002 runs sandboxed plugin JS in a **synchronous QuickJS** VM. Its host-function model is
inherently synchronous: a host function call runs to completion inside the plugin's turn and the
runtime enforces a one-second CPU deadline per operation. That model cannot host **async** host APIs:
when plugin code does `await ctx.network.request(...)`, the operation completes in the host *after*
the plugin's call frame has returned, and resuming the plugin requires QuickJS to run its pending
promise jobs — which the sync variant never does today.

The SDK therefore typed `ctx.dom`, `ctx.network`, `ctx.storage`, and async lifecycle as *future*:
`ctx.dom.query` was even typed with a stale synchronous `Element | null` that is unsatisfiable — a
real DOM `Element` cannot cross the QuickJS boundary, so the honest result is a serialized snapshot,
which is inherently produced asynchronously by the host. BACKLOG listed three possible exits:
the `asyncify` WASM variant, a `worker_thread`/`utilityProcess` bridge, or a decision on the sync VM.
This ADR decides.

## Options evaluated

| Option | Promise semantics for plugin JS | Per-window model | Cost / fit |
|---|---|---|---|
| **A — `asyncify` WASM variant** | single suspended async op per WASM module | ❌ breaks it — the shared module cannot interleave one suspended op per plugin/window context | size/speed cost; rewrites the engine choice of ADR 0002 |
| **B — sync QuickJS + host-driven pending-job pump** | ✅ real `Promise`; host functions resolve a `vm.newPromise()` and the runtime drains with `executePendingJobs()` | ✅ one VM per plugin context stays untouched | a bounded pending-op registry + drain points (the chosen option) |
| **C — `worker_thread` / `utilityProcess` + IPC bridge** | ✅ real `Promise` (over RPC) | ✅ | full RPC + codec + watchdog rebuild — for a synchronous `dom.query` contract nobody uses and that cannot even be typed as a real `Element` |

## Decision

Adopt **Option B**: keep the in-process synchronous QuickJS VM and add a **host-driven pending-job
pump**.

1. **Host-async APIs resolve host promises.** A host function that cannot answer synchronously
   (network, DOM snapshot, storage) creates a host promise with `vm.newPromise()`, registers the
   pending operation in a `pendingOps` registry, and returns. The plugin's `await` suspends that
   plugin turn.
2. **The host drains.** When the underlying operation completes (Core fetch response, DOM snapshot,
   storage read), the runtime resolves the `newPromise` handle and calls
   `vm.executePendingJobs()` so the plugin continuation runs — under the same per-operation CPU
   deadline as any other plugin turn.
3. **Promise lifecycle drain.** `activate`/`deactivate` may return a Promise; the runtime drains it
   (executing pending jobs until the hook settles, bounded by the per-op timeout) before the plugin
   is considered activated or deactivated and before the VM is disposed.
4. **Sync-only callbacks stay sync.** Lifecycle-**event** callbacks (`onCreated`/`onLoad`/
   `onRendererReady`/`onUnload`) and `ctx.dom.observe` callbacks are host announcements, not
   operations the plugin awaits. They keep the synchronous `undefined`-returning contract: the
   runtime never drains their return value, and a Promise/thenable result is rejected under the
   fail-closed rule (ADR 0002).

## Design (the SDK surface and the host contract)

- **DOM snapshots, not live nodes.** A real DOM `Element` cannot cross the QuickJS boundary. The
  host serializes matching elements into a `DomElement` snapshot (`nodeId`, `tag`, `id`, `className`,
  `attrs`, `text`, optional `rect`/`value`/`checked`/`href`/`src`) and the stale synchronous
  `Element | null` query is **re-specified**:
  - `ctx.dom.query(selector): Promise<DomElement | null>` — first match or `null`.
  - `ctx.dom.observe(selector, cb: (node: DomElement) => void): () => void` — a **polling** bridge
     (500 ms cadence) delivering a snapshot of each newly observed node to a synchronous callback;
    returns a disconnect function. There is deliberately **no synchronous `dom.query`**.
- **Network.** `ctx.network.request(req): Promise<NetworkResponse>` (unchanged shape, both contexts,
  requires `network.access`) runs a **Core-side, domain-whitelisted fetch** — the plugin never opens
  a raw socket. A non-whitelisted URL or a fetch failure **rejects** the promise with a catchable
  error.
- **Storage.** `ctx.storage` is renderer-only (requires `renderer.storage`):
  `get(key): Promise<string | null>` / `set(key, value): Promise<void>`. The host namespaces every
  entry as `tronhawk:<pluginId>:<key>`, so each plugin reads and writes only its own keyspace; values
  are strings and host-bounded.
- **Lifecycle types.** `PluginModule.activate`/`deactivate` become
  `(ctx: C) => void | Promise<unknown>` — the TypeScript spelling of the runtime contract "return
  `undefined` synchronously, or a Promise the runtime drains". A fulfilled Promise's resolve value
  is ignored; only a rejection fails the hook. (The literal union
  `undefined | Promise<undefined>` would statically reject ordinary async hooks — `async fn` has type
  `Promise<void>` — and would also break existing synchronous no-return `activate(ctx) { … }` plugin
  bodies, which TS infers as returning `void`; `void | Promise<unknown>` accepts both authoring forms
  and does not reject a Promise of a concrete value.)
- **Lifecycle-event and observe callback types are unchanged** — strictly synchronous
  `undefined`-returning, asserted in `sdk/src/lifecycle-contract.typecheck.ts`.

## Residual (accepted)

- **No synchronous `dom.query`.** The SDK surface is honest about it: reading the DOM is a host
  operation, so it is a Promise of a snapshot. Nothing in the runtime pretends otherwise.
- **Plugin-event callbacks stay synchronous.** Only `activate`/`deactivate` (module lifecycle) are
  drained; host-announced event callbacks cannot suspend a plugin turn.
- **A parked VM is bounded.** While a plugin awaits a pending op its VM is parked, not spinning. It
  is bounded by the per-operation CPU deadline, the 64 MB VM memory limit, and the plan-reload path
  (a config-edit/plan revision reload disposes the VM) — the same bounds that already apply to
  sandboxed plugins.

## Future (not this ADR)

A later move of the synchronous VM into an Electron `utilityProcess` (off-thread) is a
**protocol-compatible upgrade**: the host-function request/response protocol and the SDK surface are
unchanged, and it requires **no SAB and no SDK change** — the pendingOps pump simply travels over the
process boundary instead of an in-process call.

## Consequences

- SDK 0.5.0 adds the `DomElement` snapshot type, re-specifies `DomAPI` (`query` →
  `Promise<DomElement | null>`, `observe` → snapshot callback), adds `StorageAPI`/`ctx.storage` on
  `RendererContext`, and broadens `activate`/`deactivate` to `void | Promise<unknown>`
  (a fulfilled Promise's resolve value is ignored; only a rejection fails the hook).
  `sdk/src/lifecycle-contract.typecheck.ts` asserts the new lifecycle contract and keeps the
  sync-only assertions on event callbacks.
- `PLUGIN-SDK.md` and SPEC §9/§10 flip `ctx.dom`, `ctx.network`, `ctx.storage`, and async lifecycle
  from future to implemented; `renderer.storage` (low risk) joins the permissions tables; the
  `network.access` row notes the Core-side domain-whitelisted fetch.
- BACKLOG: the async-host-functions, guide-plugins-back-to-sandbox, and pending-job-draining items
  are resolved via this ADR.
- Remaining runtime/Core work (parallel lanes): the `pendingOps` pump + drain points in the runtime,
  the Core-side whitelisted network request, the renderer DOM snapshot/poll bridge, and the
  host-namespaced storage backend.

## References

- ADR 0002 (QuickJS sandbox, CPU-deadline, sync host-function model) — the boundary this ADR extends.
- ADR 0007 (developer mode / `runtime.unsafe`) — the interim whose "guide normal plugins back to
  sandboxed APIs" residual this ADR resolves.
- SPEC §9 (execution contexts), §10 (permissions); `PLUGIN-SDK.md` ("Renderer API", "Lifecycle",
  "Storage", permissions table); `sdk/src/index.ts`, `sdk/src/lifecycle-contract.typecheck.ts`,
  `sdk/package.json`.
- QuickJS pending-promise model (`JS_NewPromiseCapability` + `js_execute_pending_job`); BACKLOG
  "Phase 3 — QuickJS sandbox".

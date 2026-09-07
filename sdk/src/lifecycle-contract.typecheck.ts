// Static contract checks for the SDK lifecycle and callback types (see docs/PLUGIN-SDK.md,
// "Lifecycle" and docs/adr/0008-async-host-functions.md). Compiled by `bun run typecheck`: an
// assertion that evaluates to `false` is a type error, so this file fails the build whenever the
// types drift from the runtime contract they declare.

import type { MainContext, PluginModule, WindowHandle } from "./index";

type Assert<T extends true> = T;
type IsAssignable<From, To> = From extends To ? true : false;

type MainActivate = PluginModule<MainContext>["activate"];
type MainDeactivate = PluginModule<MainContext>["deactivate"];

type OnCreatedCallback = Parameters<MainContext["window"]["onCreated"]>[0];
type OnLoadCallback = Parameters<MainContext["onLoad"]>[0];
type OnRendererReadyCallback = Parameters<MainContext["onRendererReady"]>[0];
type OnUnloadCallback = Parameters<MainContext["onUnload"]>[0];

// --- Async lifecycle (ADR 0008) ---
// The runtime drains a Promise returned by `activate`/`deactivate` (via `executePendingJobs()`)
// before the plugin is considered activated/deactivated, so both a synchronous `undefined`-returning
// hook and an async (Promise-returning) hook are accepted. A fulfilled Promise's resolve value is ignored —
// only a rejection fails the hook.

// Synchronous (`undefined`-returning) lifecycle hooks stay valid — no-return `activate(ctx) {}`
// bodies are the common authoring form and must keep compiling.
type _SyncActivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => undefined, MainActivate> extends true ? true : false
>;
// Async hooks (`async activate(ctx) {}` ⇒ `Promise<void>`) are now accepted.
type _AsyncActivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => Promise<void>, MainActivate> extends true ? true : false
>;
type _PromiseUndefinedActivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => Promise<undefined>, MainActivate> extends true ? true : false
>;
// `deactivate` follows the same contract as `activate`.
type _SyncDeactivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => undefined, MainDeactivate> extends true ? true : false
>;
type _AsyncDeactivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => Promise<void>, MainDeactivate> extends true ? true : false
>;
// Host ignores the fulfillment value; a Promise of a concrete value is a valid hook result.
type _ValuePromiseActivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => Promise<string>, MainActivate> extends true ? true : false
>;
type _ValuePromiseDeactivateAccepted = Assert<
  IsAssignable<(ctx: MainContext) => Promise<string>, MainDeactivate> extends true ? true : false
>;

// --- Sync-only callbacks (unchanged; ADR 0008 keeps them synchronous) ---
// Lifecycle-EVENT callbacks (`onCreated`, `onLoad`, `onRendererReady`, `onUnload`) are announced by
// the host and never drained. They remain strictly synchronous `undefined`-returning: a normal
// synchronous callback stays assignable and a Promise-returning callback stays statically
// unassignable.

type _SyncOnCreatedAccepted = Assert<
  IsAssignable<(window: WindowHandle) => undefined, OnCreatedCallback> extends true ? true : false
>;
type _AsyncOnCreatedRejected = Assert<
  IsAssignable<(window: string) => Promise<void>, OnCreatedCallback> extends false ? true : false
>;
type _AsyncOnLoadRejected = Assert<
  IsAssignable<() => Promise<void>, OnLoadCallback> extends false ? true : false
>;
type _AsyncOnRendererReadyRejected = Assert<
  IsAssignable<(window: string) => Promise<void>, OnRendererReadyCallback> extends false ? true : false
>;
type _AsyncOnUnloadRejected = Assert<
  IsAssignable<(window: string) => Promise<void>, OnUnloadCallback> extends false ? true : false
>;

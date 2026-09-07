// Lifecycle test tools: Promise-drain semantics for `activate`/`deactivate`
// and the synchronous-`undefined` contract for event callbacks.
//
// Contract (host parity — crates/runtime/js/src/index.js `runLifecycleHook` +
// `watchAsyncActivate`/`drainThenableResult`, which never inspect the fulfilled
// value; the canonical harness `contract-harness.js` `pumpUntilSettled` agrees):
// - `activate`/`deactivate` may return `undefined` synchronously or a Promise;
//   the runtime DRAINS a returned Promise before the plugin counts as
//   activated/deactivated, and IGNORES its resolved value (fulfillment of any
//   value accepts; only rejection fails). Only a synchronous non-`undefined`
//   return fails the void contract.
// - Event callbacks (`dom.observe`, `window.onCreated`, `onLoad`,
//   `onRendererReady`, `onUnload`) must complete synchronously and return
//   `undefined`. They are never drained; a throwing, over-deadline, or
//   non-`undefined` callback is unregistered and never re-invoked.

import type { PluginContext, PluginModule } from "../index";

/** Thrown when a lifecycle hook or event callback breaks its contract. */
export class ContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractViolationError";
  }
}

/** Narrow check for a Promise/thenable return value. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeValue(value: unknown): string {
  if (isThenable(value)) {
    return "a Promise/thenable (event callbacks are never drained)";
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Assert that an event-callback return value honors the synchronous
 * `undefined` contract. Throws {@link ContractViolationError} for any other
 * value — including a Promise/thenable.
 */
export function assertSyncUndefined(
  returnValue: unknown,
  label: string,
): void {
  if (returnValue !== undefined) {
    throw new ContractViolationError(
      `${label} must return undefined synchronously but returned ${describeValue(returnValue)}. ` +
        "Event callbacks are invoked under the CPU-deadline contract and never drained: " +
        "a throwing, over-deadline, or non-undefined callback is unregistered and never re-invoked.",
    );
  }
}

async function drainHook(label: string, invoke: () => unknown): Promise<void> {
  const returned = invoke();
  if (isThenable(returned)) {
    // Host parity: the production host drains the promise and ignores what it
    // resolves to (fulfillment of any value accepts); only rejection fails.
    // A rejection propagates as the rejection reason (not wrapped).
    await returned;
    return;
  }
  if (returned !== undefined) {
    throw new ContractViolationError(
      `${label} must return undefined or a Promise (a Promise resolving to any value is accepted, host parity) but returned ${describeValue(returned)}.`,
    );
  }
}

/**
 * Run `plugin.activate(ctx)` with runtime drain semantics: await a returned
 * Promise (its resolved value is ignored — host parity) and throw
 * {@link ContractViolationError} for a synchronous non-`undefined` return.
 * A rejected Promise propagates its rejection reason.
 */
export function drainActivate<C extends PluginContext>(
  plugin: PluginModule<C>,
  ctx: C,
): Promise<void> {
  return drainHook("activate", () => plugin.activate(ctx));
}

/**
 * Run `plugin.deactivate(ctx)` with runtime drain semantics (see
 * {@link drainActivate}).
 */
export function drainDeactivate<C extends PluginContext>(
  plugin: PluginModule<C>,
  ctx: C,
): Promise<void> {
  return drainHook("deactivate", () => plugin.deactivate(ctx));
}

/**
 * Invoke an event callback and assert the synchronous-`undefined` contract.
 * A callback that throws propagates its error; a callback returning a
 * non-`undefined` value (including a Promise) throws
 * {@link ContractViolationError}.
 */
export function invokeEventCallback<Args extends unknown[]>(
  label: string,
  cb: (...args: Args) => unknown,
  ...args: Args
): void {
  assertSyncUndefined(cb(...args), label);
}

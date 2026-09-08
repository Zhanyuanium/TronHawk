// Testing surface for TronHawk plugins — permission-aware mocks, call
// records, and lifecycle-contract helpers. No host required.
//
// Import via `@tronhawk/sdk/testing`. This entry is intentionally separate
// from the package root (`@tronhawk/sdk`), which stays a side-effect-free
// public contract of types and pure helpers.

export type { PluginPermission } from "./permissions";
export {
  ALL_PERMISSIONS,
  IMPLEMENTED_PERMISSIONS,
  deniedError,
  hasGrant,
  normalizeGrants,
} from "./permissions";
export {
  ContractViolationError,
  assertSyncUndefined,
  drainActivate,
  drainDeactivate,
  invokeEventCallback,
  isThenable,
} from "./lifecycle";
export type {
  CssInsertRecord,
  CssRemoveRecord,
  DomObserveRecord,
  DomObserverEntry,
  DomQueryRecord,
  LoggerMessage,
  MainCalls,
  MainTestingOptions,
  NetworkRequestRecord,
  OrderedCall,
  RendererCalls,
  RendererTestingOptions,
  ScriptTitleRecord,
  StorageGetRecord,
  StorageSetRecord,
  TestingApiName,
  TestingMainHarness,
  TestingRendererHarness,
  WindowControlsMountRecord,
  WindowControlsUnmountRecord,
} from "./mocks";
export {
  createTestingMainContext,
  createTestingRendererContext,
} from "./mocks";

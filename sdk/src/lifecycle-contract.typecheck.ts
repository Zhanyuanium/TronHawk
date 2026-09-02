import type { MainContext, PluginModule } from "./index";

type Assert<T extends true> = T;
type IsAssignable<From, To> = From extends To ? true : false;

type Activate = PluginModule["activate"];
type OnCreatedCallback = Parameters<MainContext["window"]["onCreated"]>[0];

// Keep Promise-returning lifecycle functions statically unassignable. Runtime callbacks return
// JavaScript `undefined` when they complete normally.
type _ActivateReturnsUndefined = Assert<ReturnType<Activate> extends undefined ? true : false>;
type _AsyncActivateRejected = Assert<
  IsAssignable<(ctx: MainContext) => Promise<void>, Activate> extends false ? true : false
>;
type _AsyncOnCreatedRejected = Assert<
  IsAssignable<(window: string) => Promise<void>, OnCreatedCallback> extends false ? true : false
>;

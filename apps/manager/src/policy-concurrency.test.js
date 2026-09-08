import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Execute the production state transitions without booting the DOM or Tauri.
// Explicit boundaries fail loudly if the functions move; no copied queue implementation.
const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing production boundary: ${start}`);
  return source.slice(from, to);
}
const transitions = [
  section("let policyRevision =", "async function load()"),
  section("const pendingPolicyChanges =", "function patchPolicyControl("),
  section("async function togglePolicyControl(", "async function loadCoreAutostart("),
].join("\n");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(grants = [], extra = {}) {
  return {
    applications: [{ id: "app", enabledPluginCount: 0 }],
    plugins: [{ id: "plugin", applicationPolicies: [{ applicationId: "app", enabled: false, grants }] }],
    developerMode: false,
    ...extra,
  };
}
function harness() {
  const state = { ...snapshot(), selectedApplicationId: "app", selectedPluginId: "plugin" };
  const reads = [], writes = [];
  const service = {
    getSnapshot() { const read = deferred(); reads.push(read); return read.promise; },
    setApplicationPluginPolicy(applicationId, pluginId, policy) {
      const write = { ...deferred(), applicationId, pluginId, policy };
      writes.push(write);
      return write.promise;
    },
  };
  const policyFor = (plugin, applicationId) => plugin.applicationPolicies.find((p) => p.applicationId === applicationId)
    ?? { enabled: false, grants: [] };
  const noop = () => {};
  const api = new Function("state", "service", "policyFor", "render", "patchPolicyControl", "patchPolicyFeedback", "t", "errorMessage",
    `${transitions}\nreturn { refreshSnapshot, togglePolicyControl, policyWriteQueues, get state() { return state; } };`
  )(state, service, policyFor, noop, noop, noop, (key) => key, (error) => error.message);
  return {
    ...api, get state() { return api.state; }, reads, writes,
    toggle: (grant) => api.togglePolicyControl({ dataset: { pluginId: "plugin", toggleGrant: grant }, checked: true }),
    grants: () => api.state.plugins.find((p) => p.id === "plugin").applicationPolicies[0].grants,
  };
}

test("old snapshot arriving after a confirmed write cannot restore old grants", async () => {
  const h = harness();
  const read = h.refreshSnapshot();
  const write = h.toggle("renderer.css");
  await Promise.resolve();
  h.writes[0].resolve({ enabled: true, grants: ["renderer.css"] });
  await write;
  h.reads[0].resolve(snapshot());
  await read;
  expect(h.grants()).toEqual(["renderer.css"]);
});

test.each(["remove", "install"])("%s snapshot applies non-policy data despite concurrent settlement", async (operation) => {
  const h = harness();
  h.state.plugins.push({ id: "removed", applicationPolicies: [] });
  const write = h.toggle("renderer.css");
  await Promise.resolve();
  const read = h.refreshSnapshot();
  h.writes[0].resolve({ enabled: true, grants: ["renderer.css"] });
  await write;
  const result = snapshot([], { developerMode: true, snapshotMetadata: { operation } });
  if (operation === "install") result.plugins.push({ id: "installed", applicationPolicies: [] });
  h.reads[0].resolve(result);
  await read;
  expect(h.state.plugins.map((p) => p.id)).toEqual(operation === "install" ? ["plugin", "installed"] : ["plugin"]);
  expect(h.state.developerMode).toBe(true);
  expect(h.state.snapshotMetadata).toEqual({ operation });
  expect(h.state.selectedApplicationId).toBe("app");
  expect(h.state.applications[0].enabledPluginCount).toBe(1);
  expect(h.grants()).toEqual(["renderer.css"]);
});

test("failed first intent is removed but its queued successor succeeds", async () => {
  const h = harness();
  const first = h.toggle("renderer.css");
  const second = h.toggle("renderer.storage");
  await Promise.resolve();
  h.writes[0].reject(new Error("denied"));
  await first;
  await Promise.resolve();
  expect(h.writes[1].policy).toEqual({ enabled: false, grants: ["renderer.storage"] });
  h.writes[1].resolve(h.writes[1].policy);
  await second;
  expect(h.grants()).toEqual(["renderer.storage"]);
  expect([...h.policyWriteQueues.values()][0].desired.grants).toEqual(["renderer.storage"]);
  expect(h.state.operationError).toBe("denied");
});

test("rapid consecutive writes derive from Core canonical response, not submitted or display state", async () => {
  const h = harness();
  const first = h.toggle("renderer.css");
  const second = h.toggle("renderer.storage");
  await Promise.resolve();
  expect(h.writes).toHaveLength(1);
  h.writes[0].resolve({ enabled: true, grants: ["renderer.css", "renderer.dom"] });
  await first;
  await Promise.resolve();
  expect(h.writes[1].policy).toEqual({ enabled: true, grants: ["renderer.css", "renderer.dom", "renderer.storage"] });
  h.writes[1].resolve(h.writes[1].policy);
  await second;
  expect(h.grants()).toEqual(["renderer.css", "renderer.dom", "renderer.storage"]);
});

test("snapshot errors surface even when a policy settles while the read is pending", async () => {
  const h = harness();
  // NOTE: bun 1.4.2 `expect().rejects.toThrow(string)` never returns on a
  // pending promise (and returns undefined on a settled one), so capture the
  // rejection manually instead of using the rejects matchers.
  let readError = null;
  const read = h.refreshSnapshot().catch((error) => { readError = error; });
  const write = h.toggle("renderer.css");
  await Promise.resolve();
  h.writes[0].resolve(h.writes[0].policy);
  await write;
  h.reads[0].reject(new Error("snapshot unavailable"));
  await read;
  expect(String(readError && readError.message)).toContain("snapshot unavailable");
});

test("unchanged idle scopes rebase from a fresh snapshot and leave the queue map", async () => {
  const h = harness();
  const write = h.toggle("renderer.css");
  await Promise.resolve();
  h.writes[0].resolve(h.writes[0].policy);
  await write;
  const read = h.refreshSnapshot();
  h.reads[0].resolve(snapshot(["renderer.dom"]));
  await read;
  expect(h.grants()).toEqual(["renderer.dom"]);
  expect(h.policyWriteQueues.size).toBe(0);
});

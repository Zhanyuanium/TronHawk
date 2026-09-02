import { createManagerService } from "./manager-service.js";

const service = createManagerService();
const appRoot = document.querySelector("#app");
const removeDialog = document.querySelector("#remove-dialog");
const removeForm = document.querySelector("#remove-form");
const applicationDialog = document.querySelector("#application-dialog");
const applicationForm = document.querySelector("#application-form");
const supportLevelInput = document.querySelector("#support-level");

const state = {
  view: "applications", status: "loading", applications: [], plugins: [], filter: "all",
  selectedPluginId: undefined, selectedApplicationId: undefined, removePluginId: null,
  error: "", operationError: "", notice: "", busy: false,
  logs: { events: [], nextBeforeSequence: null, scope: "all", stream: "all", loaded: false, loading: false, loadingOlder: false, error: "" },
};
const navItems = [{ id: "applications", symbol: "⌂", label: "Applications" }, { id: "plugins", symbol: "◈", label: "Plugins" }, { id: "permissions", symbol: "◇", label: "Permissions" }, { id: "logs", symbol: "≡", label: "Logs" }];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const levelLabel = (level) => level === 2 ? "Level 2 · Electron" : level === 1 ? "Level 1 · Renderer" : "Level 0 · Unsupported";
const initials = (name) => (name || "?").split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
const selectedApplication = () => state.applications.find((application) => application.id === state.selectedApplicationId) || state.applications[0];
const policyFor = (plugin, applicationId = state.selectedApplicationId) => plugin.applicationPolicies.find((policy) => policy.applicationId === applicationId) || { applicationId, enabled: false, grants: [] };
const grantsAvailableFor = (application) => application?.supportLevel === 2 ? ["renderer.css", "renderer.script", "electron.window"] : application?.supportLevel === 1 ? ["renderer.css", "renderer.script"] : [];
const errorMessage = (error) => error instanceof Error ? error.message : typeof error === "string" ? error : "Core did not complete the request.";
const validLogLevel = (level) => ["info", "warn", "error"].includes(level) ? level : "info";
const validLogStream = (stream) => ["core", "runtime", "plugin"].includes(stream) ? stream : "core";

function layout(content) {
  return `<aside class="sidebar"><div class="brand"><span class="brand-mark">T</span><span>Tron<em>Hawk</em></span></div><nav class="nav" aria-label="Manager sections">${navItems.map((item) => `<button class="nav-button" data-view="${item.id}" ${state.view === item.id ? 'aria-current="page"' : ""}><span class="nav-symbol" aria-hidden="true">${item.symbol}</span><span>${item.label}</span></button>`).join("")}</nav><div class="side-footer"><strong>Core control plane</strong>Policies are scoped to the selected application and saved through Core.</div></aside><main class="content"><div class="connection-notice" role="status"><span class="connection-notice-mark" aria-hidden="true">◆</span><span><strong>Connected to Core.</strong> Application policies shown here reflect the latest Manager snapshot.</span></div><div class="page">${feedback()}${content}</div></main>`;
}

function feedback() {
  if (state.operationError) return `<div class="error-banner" role="alert"><span>${escapeHtml(state.operationError)}</span><button class="text-link" data-dismiss-feedback>Dismiss</button></div>`;
  if (state.notice) return `<div class="success-banner" role="status"><span>${escapeHtml(state.notice)}</span><button class="text-link" data-dismiss-feedback>Dismiss</button></div>`;
  return "";
}
function pageHeader(eyebrow, title, description, action = "") { return `<header class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">${description}</p></div>${action}</header>`; }
function loading() { return `<section class="state"><div><div class="loader" aria-label="Loading"></div><h2>Loading Core snapshot</h2><p class="muted">Reading registered applications and installed plugin policies.</p></div></section>`; }
function failure() { return `<section class="state"><div><div class="state-icon">!</div><h2>Couldn’t reach Core</h2><p class="muted">${escapeHtml(state.error || "The Manager snapshot could not be loaded.")}</p><button class="button button-primary" data-retry>Try again</button></div></section>`; }

function applicationContext() {
  const application = selectedApplication();
  if (!application) return "";
  return `<section class="application-context" aria-label="Selected application policy"><div class="context-mark"><span class="app-icon" data-tone="${applicationTone(application.id)}">${initials(application.name)}</span><div><span class="context-label">Policy scope</span><strong>${escapeHtml(application.name)}</strong><small>Registered local executable · ${levelLabel(application.supportLevel)}</small></div></div><label class="application-select"><span>Current application</span><select data-application-select aria-label="Current application policy">${state.applications.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === application.id ? "selected" : ""}>${escapeHtml(entry.name)}</option>`).join("")}</select></label></section>`;
}
function applicationTone(id) { return ["violet", "mint", "orange"][[...id].reduce((total, character) => total + character.charCodeAt(0), 0) % 3]; }
function installAction() { return `<button class="button button-primary" data-install ${state.busy ? "disabled" : ""}>＋ Install plugin</button>`; }
function addApplicationAction() { return `<button class="button button-primary" data-add-application ${state.busy ? "disabled" : ""}>＋ Add application</button>`; }

function renderApplications() {
  const application = selectedApplication();
  const active = state.plugins.filter((plugin) => policyFor(plugin).enabled).length;
  return `${pageHeader("Overview", "Your extension workspace", "Manage installed plugins and application-scoped Core policies.", addApplicationAction())}${applicationContext()}<section class="summary-grid"><article class="summary-card featured"><span class="summary-label">Connection state</span><span class="summary-value">Core connected</span><span class="summary-detail">${application ? `Policies shown for ${escapeHtml(application.name)}.` : "Add an application to begin setting plugin policies."}</span></article><article class="summary-card"><span class="summary-label">Applications</span><strong class="summary-value">${state.applications.length}</strong><span class="summary-detail">Registered with Core</span></article><article class="summary-card"><span class="summary-label">Enabled here</span><strong class="summary-value">${active}</strong><span class="summary-detail">${application ? "Policies for this application" : "Choose an application to review policies"}</span></article></section><section class="dashboard-grid"><article class="panel"><header class="panel-header"><h2>Applications</h2><span class="summary-detail">${state.applications.length ? "Choose a policy scope" : "Start with a registered executable"}</span></header><div class="application-list">${state.applications.length ? state.applications.map(appCard).join("") : emptyApplications()}</div></article><aside class="panel"><header class="panel-header"><h2>Core activity</h2><button class="text-link" data-view="logs">View log status</button></header><div class="activity-pending"><i class="activity-dot"></i><div><strong>Awaiting Core ingestion</strong><span>Activity is not included in the Manager snapshot.</span></div></div></aside></section>`;
}
function emptyApplications() { return `<section class="empty-application-state"><div class="state-icon">＋</div><h3>Add your first application</h3><p>Choose a support level, then select an executable in the native picker. Core will register it as a policy scope.</p><button class="button button-primary" data-add-application ${state.busy ? "disabled" : ""}>Add application</button></section>`; }
function appCard(application) { return `<button class="app-card ${application.id === state.selectedApplicationId ? "is-selected" : ""}" data-select-application="${escapeHtml(application.id)}" aria-pressed="${application.id === state.selectedApplicationId}"><span class="app-icon" data-tone="${applicationTone(application.id)}">${initials(application.name)}</span><div><h3>${escapeHtml(application.name)}</h3><span class="app-meta">Registered local executable</span><span class="support-badge level-${application.supportLevel}">${levelLabel(application.supportLevel)}</span></div><span class="app-plugin-count">${application.enabledPluginCount} enabled</span></button>`; }

function renderPlugins() {
  const application = selectedApplication();
  if (!application) return `${pageHeader("Installed packages", "Plugins", "Add an application before setting plugin policies.", addApplicationAction())}<section class="state"><div><div class="state-icon">＋</div><h2>Add an application first</h2><p class="muted">Choose a support level, then select an executable in the native picker to create a Core policy scope.</p><button class="button button-primary" data-add-application ${state.busy ? "disabled" : ""}>Add application</button></div></section>`;
  const shown = state.plugins.filter((plugin) => state.filter === "all" || (state.filter === "enabled" ? policyFor(plugin).enabled : !policyFor(plugin).enabled));
  return `${pageHeader("Installed packages", "Plugins", "Each switch updates the full policy for the current application in Core.", installAction())}${applicationContext()}<div class="toolbar"><div class="filter-group" role="group" aria-label="Filter plugins">${["all", "enabled", "disabled"].map((filter) => `<button class="filter-button ${filter === state.filter ? "is-active" : ""}" data-filter="${filter}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join("")}</div><span class="summary-detail">${shown.length} of ${state.plugins.length} packages · ${escapeHtml(application?.name || "No application selected")}</span></div>${shown.length ? `<section class="plugin-grid">${shown.map(pluginCard).join("")}</section>` : `<section class="state"><div><div class="state-icon">◇</div><h2>No ${state.filter} plugins for this application</h2><p class="muted">Install a .thx package or choose another policy scope.</p></div></section>`}`;
}
function pluginCard(plugin) { const policy = policyFor(plugin); const scopedCount = plugin.applicationPolicies.length; const canEnable = selectedApplication()?.supportLevel > 0; return `<article class="plugin-card"><div class="plugin-top"><div class="plugin-icon">${initials(plugin.name)}</div><div class="plugin-title"><h3>${escapeHtml(plugin.name)}</h3><span class="version">v${escapeHtml(plugin.version)}</span></div><label class="switch" title="${canEnable ? `${policy.enabled ? "Disable" : "Enable"} ${escapeHtml(plugin.name)} for the selected application` : "Level 0 applications cannot enable plugins"}"><input type="checkbox" data-toggle-policy="${escapeHtml(plugin.id)}" ${policy.enabled ? "checked" : ""} ${state.busy || !canEnable ? "disabled" : ""} aria-label="${policy.enabled ? "Disable" : "Enable"} ${escapeHtml(plugin.name)} for the selected application"><span class="slider"></span></label></div><p class="plugin-description">Author: ${escapeHtml(plugin.author)} · Requires TronHawk ${escapeHtml(plugin.tronhawk)}</p><footer class="plugin-footer"><span class="plugin-target">${scopedCount} app ${scopedCount === 1 ? "policy" : "policies"}</span><div class="plugin-actions"><button class="detail-link" data-permissions="${escapeHtml(plugin.id)}">Permissions</button><button class="button button-icon" data-remove="${escapeHtml(plugin.id)}" ${state.busy ? "disabled" : ""} aria-label="Remove ${escapeHtml(plugin.name)}">×</button></div></footer></article>`; }

function renderPermissions() {
  const selected = state.plugins.find((plugin) => plugin.id === state.selectedPluginId) || state.plugins[0];
  const application = selectedApplication();
  if (!application) return `${pageHeader("Safety review", "Permissions", "Add an application before reviewing application-scoped grants.", addApplicationAction())}<section class="state"><div><div class="state-icon">＋</div><h2>Add an application first</h2><p class="muted">The native picker will register an executable in Core and create a policy scope for its plugin grants.</p><button class="button button-primary" data-add-application ${state.busy ? "disabled" : ""}>Add application</button></div></section>`;
  if (!selected) return `${pageHeader("Safety review", "Permissions", "Review the capabilities requested by each installed package.")}${applicationContext()}<section class="state"><div><div class="state-icon">◇</div><h2>No plugins to review</h2><p class="muted">Installed packages will appear here.</p></div></section>`;
  const policy = policyFor(selected);
  const requested = selected.requested.map((permission) => permissionRow(permission, policy.grants.includes(permission), selected.id, grantsAvailableFor(application).includes(permission))).join("");
  return `${pageHeader("Safety review", "Permissions", "Grants belong to the selected application policy and are saved through Core.")}${applicationContext()}<section class="permission-layout"><aside class="plugin-picker"><span class="picker-label">Installed plugins</span>${state.plugins.map((plugin) => `<button class="picker-button ${plugin.id === selected.id ? "is-selected" : ""}" data-select-plugin="${escapeHtml(plugin.id)}">${escapeHtml(plugin.name)}<small>${policyFor(plugin).enabled ? "Enabled" : "Disabled"} for ${escapeHtml(application.name)}</small></button>`).join("")}</aside><article class="panel permission-panel"><header class="permission-plugin-head"><div class="plugin-icon">${initials(selected.name)}</div><div><h2>${escapeHtml(selected.name)}</h2><span class="version">${escapeHtml(application.name)} policy · v${escapeHtml(selected.version)}</span></div></header><section class="permission-section"><div class="section-title">Requested capabilities <span class="section-count">${selected.requested.length}</span></div><div class="permission-list">${requested || '<p class="empty-inline">This package did not request any capabilities.</p>'}</div></section><p class="permission-note">Only capabilities available at ${escapeHtml(levelLabel(application.supportLevel))} can be granted. Grant changes preserve the rest of this plugin’s policy.</p></article></section>`;
}
function permissionRow(permission, granted, pluginId, available) { const [description, risk] = service.getPermissionDetails(permission); const label = available ? (granted ? "Granted" : "Withheld") : "Unavailable here"; return `<div class="permission-row"><div><code>${escapeHtml(permission)}</code><span>${escapeHtml(description)} <i class="risk-badge risk-${risk}">${escapeHtml(risk)} risk</i></span></div><label class="permission-control"><input type="checkbox" data-toggle-grant="${escapeHtml(permission)}" data-plugin-id="${escapeHtml(pluginId)}" ${granted ? "checked" : ""} ${state.busy || !available ? "disabled" : ""} aria-label="${granted ? "Revoke" : "Grant"} ${escapeHtml(permission)} for the selected application"><span>${label}</span></label></div>`; }

function renderLogs() {
  const application = selectedApplication();
  const logs = state.logs;
  const scopeLabel = logs.scope === "selected" && application ? application.name : "All applications";
  const action = `<button class="button button-quiet" data-refresh-logs ${logs.loading || logs.loadingOlder ? "disabled" : ""}>↻ Refresh</button>`;
  let content;
  if (logs.loading) content = `<section class="log-state"><div class="loader" aria-label="Loading logs"></div><h2>Querying latest events</h2><p>Fetching the newest 20 ${escapeHtml(scopeLabel.toLowerCase())} events from Core.</p></section>`;
  else if (logs.error && !logs.events.length) content = `<section class="log-state" role="alert"><div class="state-icon">!</div><h2>Couldn’t query logs</h2><p>${escapeHtml(logs.error)}</p><button class="button button-primary" data-refresh-logs>Try again</button></section>`;
  else if (!logs.events.length) content = `<section class="log-state"><div class="state-icon">≡</div><h2>No matching events</h2><p>Core returned no ${escapeHtml(scopeLabel.toLowerCase())} events for this query.</p></section>`;
  else content = `<ol class="log-list" aria-label="Log events, newest first">${logs.events.map(logRow).join("")}</ol>`;
  const pagination = logs.events.length ? (logs.loadingOlder ? `<p class="log-pagination-status" role="status">Loading older events…</p>` : logs.nextBeforeSequence !== null ? `<button class="button button-quiet" data-load-older>Load older</button>` : `<p class="log-pagination-status">You’ve reached the oldest event in this query.</p>`) : "";
  const queryError = logs.error && logs.events.length ? `<div class="log-query-error" role="alert"><span>${escapeHtml(logs.error)}</span><button class="text-link" data-refresh-logs>Try again</button></div>` : "";
  return `${pageHeader("Audit trail", "Logs", "Query recorded Core, runtime, and plugin events. Results do not update automatically.", action)}${applicationContext()}<section class="log-layout"><article class="panel log-panel"><div class="log-query-toolbar"><div class="log-filter-group"><label><span>Scope</span><select data-log-scope aria-label="Log application scope"><option value="all" ${logs.scope === "all" ? "selected" : ""}>All applications</option><option value="selected" ${logs.scope === "selected" ? "selected" : ""} ${application ? "" : "disabled"}>Selected application</option></select></label><label><span>Stream</span><select data-log-stream aria-label="Log stream"><option value="all" ${logs.stream === "all" ? "selected" : ""}>All streams</option><option value="core" ${logs.stream === "core" ? "selected" : ""}>Core</option><option value="runtime" ${logs.stream === "runtime" ? "selected" : ""}>Runtime</option><option value="plugin" ${logs.stream === "plugin" ? "selected" : ""}>Plugin</option></select></label></div><p class="log-results-summary" role="status">${logs.loaded ? `${logs.events.length} event${logs.events.length === 1 ? "" : "s"} · ${escapeHtml(scopeLabel)}` : "Ready to query"}</p></div>${queryError}${content}<div class="log-pagination">${pagination}</div></article><aside class="panel log-side"><p class="eyebrow">Query details</p><h2>Read-only history</h2><div class="stream-guide"><div><strong>Latest first</strong><span>Each refresh asks Core for the newest 20 matching events.</span></div><div><strong>Scoped results</strong><span>Filter to the selected application or keep the query across all applications.</span></div><div><strong>No live feed</strong><span>New activity appears after an explicit refresh.</span></div></div></aside></section>`;
}
function displayApplicationName(applicationId) { return state.applications.find((application) => application.id === applicationId)?.name ?? applicationId; }
function displayPluginName(pluginId) { return state.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId; }
function formatLogTimestamp(timestampMs) {
  const timestamp = new Date(timestampMs);
  if (Number.isNaN(timestamp.getTime())) return escapeHtml(timestampMs);
  return `<time datetime="${timestamp.toISOString()}">${escapeHtml(timestamp.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }))}</time>`;
}
function logRow(event) {
  const level = validLogLevel(event.level);
  const stream = validLogStream(event.stream);
  const applicationName = displayApplicationName(event.applicationId);
  const plugin = event.pluginId ? `<span class="log-context-item">Plugin · ${escapeHtml(displayPluginName(event.pluginId))}</span>` : "";
  return `<li class="log-row"><div class="log-event-meta"><div><span class="log-time">${formatLogTimestamp(event.timestampMs)}</span><span class="log-level ${level}">${escapeHtml(event.level)}</span></div><div class="log-context"><span class="log-stream stream-${stream}">${escapeHtml(event.stream)}</span><span class="log-context-item">App · ${escapeHtml(applicationName)}</span>${plugin}</div></div><div class="log-event-body"><code>${escapeHtml(event.code)}</code><p>${escapeHtml(event.message)}</p></div></li>`;
}

function render() {
  const body = state.status === "loading" ? loading() : state.status === "error" ? failure() : state.view === "applications" ? renderApplications() : state.view === "plugins" ? renderPlugins() : state.view === "permissions" ? renderPermissions() : renderLogs();
  appRoot.innerHTML = state.status === "ready" ? layout(body) : `<main class="content"><div class="page">${body}</div></main>`;
}

async function refreshSnapshot(initial = false) {
  if (initial) { state.status = "loading"; render(); }
  const snapshot = await service.getSnapshot();
  state.applications = snapshot.applications;
  state.plugins = snapshot.plugins;
  if (!state.applications.some((application) => application.id === state.selectedApplicationId)) state.selectedApplicationId = state.applications[0]?.id;
  if (!state.plugins.some((plugin) => plugin.id === state.selectedPluginId)) state.selectedPluginId = state.plugins[0]?.id;
  state.status = "ready";
}

async function load() {
  try { await refreshSnapshot(true); state.error = ""; } catch (error) { state.error = errorMessage(error); state.status = "error"; }
  render();
}
function sortLogEvents(events) {
  return [...events].sort((left, right) => Number(right.timestampMs) - Number(left.timestampMs) || Number(right.sequence) - Number(left.sequence));
}
function mergeLogEvents(current, incoming) {
  const events = new Map(current.map((event) => [String(event.sequence), event]));
  incoming.forEach((event) => events.set(String(event.sequence), event));
  return sortLogEvents([...events.values()]);
}
async function queryLogs({ older = false } = {}) {
  const logs = state.logs;
  if (logs.loading || logs.loadingOlder || (older && logs.nextBeforeSequence === null)) return;
  const selected = selectedApplication();
  if (logs.scope === "selected" && !selected) logs.scope = "all";
  if (older) logs.loadingOlder = true;
  else {
    logs.loading = true;
    logs.events = [];
    logs.nextBeforeSequence = null;
    logs.loaded = false;
  }
  logs.error = "";
  render();
  try {
    const result = await service.queryLogs({
      applicationId: logs.scope === "selected" ? selectedApplication()?.id : undefined,
      stream: logs.stream === "all" ? undefined : logs.stream,
      beforeSequence: older ? logs.nextBeforeSequence : undefined,
      limit: 20,
    });
    if (!result || !Array.isArray(result.events)) throw new Error("Core returned an invalid log query result.");
    logs.events = older ? mergeLogEvents(logs.events, result.events) : sortLogEvents(result.events);
    logs.nextBeforeSequence = result.nextBeforeSequence ?? null;
    logs.loaded = true;
  } catch (error) {
    logs.error = errorMessage(error);
  } finally {
    logs.loading = false;
    logs.loadingOlder = false;
    render();
  }
}
async function perform(action, successMessage, canceledMessage = null) {
  let completed = false;
  state.busy = true; state.operationError = ""; state.notice = ""; render();
  try {
    const result = await action();
    await refreshSnapshot();
    if (result == null && canceledMessage) state.notice = canceledMessage;
    else { state.notice = successMessage; completed = true; }
  } catch (error) {
    state.operationError = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
  return completed;
}

appRoot.addEventListener("click", async (event) => {
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  if (button.dataset.dismissFeedback !== undefined) { state.notice = ""; state.operationError = ""; render(); return; }
  if (button.dataset.view) { state.view = button.dataset.view; render(); if (state.view === "logs") queryLogs(); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; render(); return; }
  if (button.dataset.selectApplication) { state.selectedApplicationId = button.dataset.selectApplication; render(); return; }
  if (button.dataset.permissions) { state.selectedPluginId = button.dataset.permissions; state.view = "permissions"; render(); return; }
  if (button.dataset.selectPlugin) { state.selectedPluginId = button.dataset.selectPlugin; render(); return; }
  if (button.dataset.refreshLogs !== undefined) { queryLogs(); return; }
  if (button.dataset.loadOlder !== undefined) { queryLogs({ older: true }); return; }
  if (button.dataset.addApplication !== undefined) { applicationDialog.showModal(); return; }
  if (button.dataset.install !== undefined) { if (await perform(() => service.installPlugin(), "Plugin installed. Review its requested capabilities before enabling it.", "No plugin was selected. Installation was canceled.")) state.view = "plugins"; render(); return; }
  if (button.dataset.remove) { const plugin = state.plugins.find((entry) => entry.id === button.dataset.remove); state.removePluginId = plugin?.id ?? null; document.querySelector("#remove-title").textContent = `Remove ${plugin?.name ?? "plugin"}?`; removeDialog.showModal(); return; }
  if (button.dataset.retry !== undefined) load();
});

appRoot.addEventListener("change", async (event) => {
  if (event.target.matches("[data-application-select]")) {
    state.selectedApplicationId = event.target.value;
    render();
    if (state.view === "logs" && state.logs.scope === "selected") queryLogs();
    return;
  }
  if (event.target.matches("[data-log-scope]")) { state.logs.scope = event.target.value; queryLogs(); return; }
  if (event.target.matches("[data-log-stream]")) { state.logs.stream = event.target.value; queryLogs(); return; }
  if (event.target.matches("[data-toggle-policy]")) {
    const plugin = state.plugins.find((entry) => entry.id === event.target.dataset.togglePolicy);
    const policy = plugin && policyFor(plugin);
    if (plugin && policy) await perform(() => service.setApplicationPluginPolicy(state.selectedApplicationId, plugin.id, { enabled: event.target.checked, grants: policy.grants }), "Plugin policy updated.");
  }
  if (event.target.matches("[data-toggle-grant]")) {
    const plugin = state.plugins.find((entry) => entry.id === event.target.dataset.pluginId);
    const policy = plugin && policyFor(plugin);
    if (plugin && policy) {
      const grant = event.target.dataset.toggleGrant;
      const grants = event.target.checked ? [...new Set([...policy.grants, grant])] : policy.grants.filter((entry) => entry !== grant);
      await perform(() => service.setApplicationPluginPolicy(state.selectedApplicationId, plugin.id, { enabled: policy.enabled, grants }), "Plugin policy updated.");
    }
  }
});

removeForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "default" || !state.removePluginId) return;
  event.preventDefault();
  const pluginId = state.removePluginId;
  removeDialog.close(); state.removePluginId = null;
  await perform(() => service.removePlugin(pluginId), "Plugin removed from Core.");
});

applicationForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  const supportLevel = Number(supportLevelInput.value);
  if (![0, 1, 2].includes(supportLevel)) return;
  applicationDialog.close();
  await perform(
    () => service.registerApplication(supportLevel),
    "Application registered. Its policy scope is ready to review.",
    "No executable was selected. Application registration was canceled.",
  );
});

load();

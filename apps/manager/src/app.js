import { createManagerService } from "./manager-service.js";
import { t, setLanguage, getLanguage } from "./i18n.js";

const service = createManagerService();
const appRoot = document.querySelector("#app");
const removeDialog = document.querySelector("#remove-dialog");
const removeForm = document.querySelector("#remove-form");
const applicationDialog = document.querySelector("#application-dialog");
const applicationForm = document.querySelector("#application-form");
const supportLevelInput = document.querySelector("#support-level");
const removeApplicationDialog = document.querySelector("#remove-application-dialog");
const removeApplicationForm = document.querySelector("#remove-application-form");

const state = {
  view: "applications", status: "loading", applications: [], plugins: [], filter: "all",
  selectedPluginId: undefined, selectedApplicationId: undefined, removePluginId: null,
  removeApplicationId: null,
  developerMode: false,
  // Effective per-plugin config values for the selected application × plugin ("applicationId|pluginId").
  // `configValues` is null until the scope's stored values have been read (or the scope declares none).
  configScope: "", configValues: null, configGeneration: 0,
  // Core boot autostart preference; undefined until the first load (drives the switch's disabled state).
  coreAutostart: undefined, coreAutostartLoading: false,
  // Transparent launch (IFEO) registration for the currently selected application. `id` is the
  // application the loaded state belongs to; `loading` guards the initial read; `owned === false`
  // means the registration is owned by another program, so the switch is disabled.
  iefo: { id: null, loading: false, registered: false, owned: true, error: "" },
  error: "", operationError: "", notice: "", busy: false,
  logs: { events: [], nextBeforeSequence: null, scope: "all", stream: "all", loaded: false, loading: false, loadingOlder: false, error: "" },
};
// Navigation is grouped: the application-scoped views live under Workspace, and the global
// control-plane views live under System. Each label is an i18n key resolved at render time.
const navGroups = [
  { title: "nav.group.workspace", items: [
    { id: "applications", symbol: "⌂", label: "nav.applications" },
    { id: "plugins", symbol: "◈", label: "nav.plugins" },
    { id: "permissions", symbol: "◇", label: "nav.permissions" },
  ] },
  { title: "nav.group.system", items: [
    { id: "logs", symbol: "≡", label: "nav.logs" },
    { id: "settings", symbol: "⚙︎", label: "nav.settings" },
  ] },
];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const levelLabel = (level) => level === 2 ? t("level.2") : level === 1 ? t("level.1") : t("level.0");
const initials = (name) => (name || "?").split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
const selectedApplication = () => state.applications.find((application) => application.id === state.selectedApplicationId) || state.applications[0];
const policyFor = (plugin, applicationId = state.selectedApplicationId) => plugin.applicationPolicies.find((policy) => policy.applicationId === applicationId) || { applicationId, enabled: false, grants: [] };
const grantsAvailableFor = (application) => {
  if (application?.supportLevel === 2) return ["renderer.css", "renderer.script", "electron.window", "electron.windowControls", ...(state.developerMode ? ["runtime.unsafe"] : [])];
  if (application?.supportLevel === 1) return ["renderer.css", "renderer.script"];
  return [];
};
const errorMessage = (error) => error instanceof Error ? error.message : typeof error === "string" ? error : t("error.generic");
const validLogLevel = (level) => ["info", "warn", "error"].includes(level) ? level : "info";
const validLogStream = (stream) => ["core", "runtime", "plugin"].includes(stream) ? stream : "core";

function layout(content) {
  const context = applicationContext();
  return `<aside class="sidebar"><div class="brand"><span class="brand-mark">T</span><span>Tron<em>Hawk</em></span></div><nav class="nav" aria-label="${t("nav.aria")}">${navGroups.map((group) => `<div class="nav-section"><div class="nav-section-title">${t(group.title)}</div>${group.items.map(navButton).join("")}</div>`).join("")}</nav><div class="side-footer"><strong>${t("sidebar.footer.title")}</strong>${t("sidebar.footer.desc")}</div></aside><main class="content">${connectionNotice()}${context}<div class="page">${feedback()}${content}</div></main>`;
}
function navButton(item) {
  return `<button class="nav-button" data-view="${item.id}" ${state.view === item.id ? 'aria-current="page"' : ""}><span class="nav-symbol" aria-hidden="true">${item.symbol}</span><span>${t(item.label)}</span></button>`;
}
function connectionNotice() {
  return `<div class="connection-notice" role="status"><span class="connection-notice-mark" aria-hidden="true">◆</span><span><strong>${t("notice.connected.title")}</strong> ${t("notice.connected.desc")}</span></div>`;
}

function feedback() {
  if (state.operationError) return `<div class="error-banner" role="alert"><span>${escapeHtml(state.operationError)}</span><button class="text-link" data-dismiss-feedback>${t("common.dismiss")}</button></div>`;
  if (state.notice) return `<div class="success-banner" role="status"><span>${escapeHtml(state.notice)}</span><button class="text-link" data-dismiss-feedback>${t("common.dismiss")}</button></div>`;
  return "";
}
function pageHeader(eyebrow, title, description, action = "") { return `<header class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">${description}</p></div>${action}</header>`; }
function loading() { return `<section class="state"><div><div class="loader" aria-label="${t("loading.aria")}"></div><h2>${t("loading.title")}</h2><p class="muted">${t("loading.desc")}</p></div></section>`; }
function failure() { return `<section class="state"><div><div class="state-icon">!</div><h2>${t("failure.title")}</h2><p class="muted">${escapeHtml(state.error || t("failure.desc"))}</p><button class="button button-primary" data-retry>${t("common.tryAgain")}</button></div></section>`; }

// The application scope selector is rendered once by the global shell, not per page. It always
// writes to `state.selectedApplicationId` and re-renders, so every view stays in sync.
function applicationContext() {
  const application = selectedApplication();
  if (!application) return "";
  return `<section class="application-context" aria-label="${t("context.aria")}"><div class="context-mark"><span class="app-icon" data-tone="${applicationTone(application.id)}">${initials(application.name)}</span><div><span class="context-label">${t("context.label")}</span><strong>${escapeHtml(application.name)}</strong><small>${t("context.registeredExecutable")} · ${levelLabel(application.supportLevel)}</small></div></div><label class="application-select"><span>${t("context.currentApplication")}</span><select data-application-select aria-label="${t("context.selectAria")}">${state.applications.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === application.id ? "selected" : ""}>${escapeHtml(entry.name)}</option>`).join("")}</select></label></section>`;
}
function applicationTone(id) { return ["violet", "mint", "orange"][[...id].reduce((total, character) => total + character.charCodeAt(0), 0) % 3]; }
function installAction() { return `<button class="button button-primary" data-install ${state.busy ? "disabled" : ""}>${t("action.install")}</button>`; }
function addApplicationAction() { return `<button class="button button-primary" data-add-application ${state.busy ? "disabled" : ""}>${t("action.addApplication")}</button>`; }
// Single, parameterized empty-state gate. The `application` variant keeps the compact inline look
// used inside the Applications panel; the default variant is the bordered, centered state card.
function emptyState({ variant = "section", icon = "＋", title, description, actionLabel = "", actionData = "", busy = false }) {
  const button = actionLabel ? `<button class="button button-primary" ${actionData} ${busy ? "disabled" : ""}>${actionLabel}</button>` : "";
  if (variant === "application") {
    return `<section class="empty-application-state"><div class="state-icon">${icon}</div><h3>${title}</h3><p>${description}</p>${button}</section>`;
  }
  return `<section class="state"><div><div class="state-icon">${icon}</div><h2>${title}</h2><p class="muted">${description}</p>${button}</div></section>`;
}

function renderApplications() {
  loadIefo();
  const application = selectedApplication();
  const active = state.plugins.filter((plugin) => policyFor(plugin).enabled).length;
  return `${pageHeader(t("applications.eyebrow"), t("applications.title"), t("applications.desc"), addApplicationAction())}<section class="summary-grid"><article class="summary-card featured"><span class="summary-label">${t("summary.connection")}</span><span class="summary-value">${t("summary.connectedValue")}</span><span class="summary-detail">${application ? t("summary.connectedFor", { name: escapeHtml(application.name) }) : t("summary.connectedEmpty")}</span></article><article class="summary-card"><span class="summary-label">${t("summary.applications")}</span><strong class="summary-value">${state.applications.length}</strong><span class="summary-detail">${t("summary.applicationsDetail")}</span></article><article class="summary-card"><span class="summary-label">${t("summary.enabledHere")}</span><strong class="summary-value">${active}</strong><span class="summary-detail">${application ? t("summary.enabledFor") : t("summary.enabledChoose")}</span></article></section><section class="dashboard-grid"><article class="panel"><header class="panel-header"><h2>${t("applications.panelTitle")}</h2><span class="summary-detail">${state.applications.length ? t("applications.chooseScope") : t("applications.startWithExecutable")}</span></header><div class="application-list">${state.applications.length ? state.applications.map(appCard).join("") : emptyApplications()}</div></article><aside class="panel"><header class="panel-header"><h2>${t("applications.coreActivity")}</h2><button class="text-link" data-view="logs">${t("action.viewLogs")}</button></header><div class="activity-pending"><i class="activity-dot"></i><div><strong>${t("applications.activityTitle")}</strong><span>${t("applications.activityDesc")}</span></div></div></aside></section>${iefoSection()}`;
}
function iefoSection() {
  const application = selectedApplication();
  if (!application) return "";
  const id = application.id;
  const current = state.iefo.id === id;
  const loading = state.iefo.loading || !current;
  const registered = current && state.iefo.registered;
  const owned = current ? state.iefo.owned : true;
  const error = current ? state.iefo.error : "";
  // `owned` is only meaningful once a registration exists: a Debugger present but not
  // TronHawk-owned (registered && !owned) means another program manages it, so the
  // switch is disabled. An unregistered target (registered=false) is still switchable.
  const foreign = registered && !owned;
  const toggleLabel = registered ? t("iefo.toggleOn", { name: application.name }) : t("iefo.toggleOff", { name: application.name });
  const toggleTitle = foreign ? t("iefo.ownedNote") : loading ? t("iefo.loading") : toggleLabel;
  const disabled = state.busy || loading || foreign || Boolean(error);
  const status = loading ? t("iefo.loading") : registered ? t("iefo.on") : t("iefo.off");
  const switchHtml = `<label class="switch" title="${escapeHtml(toggleTitle)}"><input type="checkbox" data-toggle-iefo="${escapeHtml(id)}" ${registered ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="${escapeHtml(toggleLabel)}"><span class="slider"></span></label>`;
  const errorBanner = error ? `<div class="error-banner" role="alert" style="margin:0;"><span>${escapeHtml(error)}</span></div>` : "";
  const ownedNote = foreign ? `<p class="permission-note is-warning" style="margin-top:0;">${escapeHtml(t("iefo.ownedNote"))}</p>` : "";
  return `<section class="panel iefo-panel" aria-label="${escapeHtml(t("iefo.title"))}"><header class="panel-header"><div><h2>${t("iefo.title")}</h2><p class="muted" style="margin:3px 0 0;font-size:12px;">${escapeHtml(t("iefo.detail"))}</p></div>${switchHtml}</header><div class="iefo-body"><p class="iefo-status" role="status">${escapeHtml(status)}</p>${errorBanner}${ownedNote}</div></section>`;
}
function emptyApplications() {
  return emptyState({ variant: "application", icon: "＋", title: t("empty.addFirst.title"), description: t("empty.addFirst.desc"), actionLabel: t("action.addApplicationPlain"), actionData: "data-add-application", busy: state.busy });
}
function appCard(application) {
  const selected = application.id === state.selectedApplicationId;
  const canLaunch = application.supportLevel > 0;
  const launchLabel = t("action.launch.withExtensions", { name: application.name });
  const launchHelp = canLaunch ? launchLabel : t("appcard.launchHelp.disabled");
  const removeTitle = t("appcard.remove", { name: application.name });
  const removeAria = t("appcard.removeAria", { name: application.name });
  return `<article class="app-card ${selected ? "is-selected" : ""}" data-select-application="${escapeHtml(application.id)}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="${escapeHtml(t("appcard.selectAria", { name: application.name }))}" style="cursor:pointer;"><span class="app-icon" data-tone="${applicationTone(application.id)}">${initials(application.name)}</span><div><h3>${escapeHtml(application.name)}</h3><span class="app-meta">${t("appcard.registeredExecutable")}</span><span class="support-badge level-${application.supportLevel}">${levelLabel(application.supportLevel)}</span></div><div style="display:flex;align-items:center;gap:16px;"><span class="app-plugin-count">${t("appcard.enabled", { count: application.enabledPluginCount })}</span><button type="button" class="button button-quiet" style="min-height:32px;padding:6px 12px;font-size:12px;" data-launch="${escapeHtml(application.id)}" ${!canLaunch || state.busy ? "disabled" : ""} title="${escapeHtml(launchHelp)}" aria-label="${escapeHtml(launchHelp)}">${t("action.launch")}</button><button type="button" class="button button-icon" data-remove-application="${escapeHtml(application.id)}" ${state.busy ? "disabled" : ""} title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeAria)}">×</button></div></article>`;
}

function renderPlugins() {
  const application = selectedApplication();
  if (!application) return `${pageHeader(t("plugins.eyebrow"), t("plugins.title"), t("plugins.descEmpty"), addApplicationAction())}${emptyState({ icon: "＋", title: t("empty.needApp.title"), description: t("empty.needApp.desc"), actionLabel: t("action.addApplicationPlain"), actionData: "data-add-application", busy: state.busy })}`;
  const shown = state.plugins.filter((plugin) => state.filter === "all" || (state.filter === "enabled" ? policyFor(plugin).enabled : !policyFor(plugin).enabled));
  const appLabel = application ? escapeHtml(application.name) : t("plugins.noApplicationName");
  const emptyTitle = state.filter === "all" ? t("plugins.noPluginsTitle") : t("plugins.noneForFilter", { filter: t(`plugins.filter.${state.filter}`) });
  return `${pageHeader(t("plugins.eyebrow"), t("plugins.title"), t("plugins.desc"), installAction())}<div class="toolbar"><div class="filter-group" role="group" aria-label="${t("plugins.filterAria")}">${["all", "enabled", "disabled"].map((filter) => `<button class="filter-button ${filter === state.filter ? "is-active" : ""}" data-filter="${filter}">${t(`plugins.filter.${filter}`)}</button>`).join("")}</div><span class="summary-detail">${t("plugins.summary", { shown: shown.length, total: state.plugins.length, application: appLabel })}</span></div>${shown.length ? `<section class="plugin-grid">${shown.map(pluginCard).join("")}</section>` : emptyState({ icon: "◇", title: emptyTitle, description: t("plugins.noneForFilter.desc") })}`;
}
function pluginCard(plugin) {
  const policy = policyFor(plugin);
  const scopedCount = plugin.applicationPolicies.length;
  const canEnable = selectedApplication()?.supportLevel > 0;
  const toggleLabel = policy.enabled ? t("plugin.toggle.disableFor", { name: plugin.name }) : t("plugin.toggle.enableFor", { name: plugin.name });
  const toggleTitle = canEnable ? toggleLabel : t("plugin.toggle.disabled");
  const policyCount = scopedCount === 1 ? t("plugin.policyOne", { count: scopedCount }) : t("plugin.policyOther", { count: scopedCount });
  return `<article class="plugin-card"><div class="plugin-top"><div class="plugin-icon">${initials(plugin.name)}</div><div class="plugin-title"><h3>${escapeHtml(plugin.name)}</h3><span class="version">v${escapeHtml(plugin.version)}</span></div><label class="switch" title="${escapeHtml(toggleTitle)}"><input type="checkbox" data-toggle-policy="${escapeHtml(plugin.id)}" ${policy.enabled ? "checked" : ""} ${state.busy || !canEnable ? "disabled" : ""} aria-label="${escapeHtml(toggleLabel)}"><span class="slider"></span></label></div><p class="plugin-description">${escapeHtml(t("plugin.author", { author: plugin.author, version: plugin.tronhawk }))}</p><footer class="plugin-footer"><span class="plugin-target">${policyCount}</span><div class="plugin-actions"><button class="detail-link" data-permissions="${escapeHtml(plugin.id)}">${t("plugin.permissions")}</button><button class="button button-icon" data-remove="${escapeHtml(plugin.id)}" ${state.busy ? "disabled" : ""} aria-label="${escapeHtml(t("plugin.removeAria", { name: plugin.name }))}">×</button></div></footer></article>`;
}

function renderPermissions() {
  syncPluginConfig();
  const selected = state.plugins.find((plugin) => plugin.id === state.selectedPluginId) || state.plugins[0];
  const application = selectedApplication();
  if (!application) return `${pageHeader(t("permissions.eyebrow"), t("permissions.title"), t("permissions.descEmpty"), addApplicationAction())}${emptyState({ icon: "＋", title: t("empty.needApp.title"), description: t("empty.needApp.desc"), actionLabel: t("action.addApplicationPlain"), actionData: "data-add-application", busy: state.busy })}`;
  if (!selected) return `${pageHeader(t("permissions.eyebrow"), t("permissions.title"), t("permissions.descNoPlugins"))}${emptyState({ icon: "◇", title: t("permissions.noPlugins.title"), description: t("permissions.noPlugins.desc") })}`;
  const policy = policyFor(selected);
  const requested = selected.requested.map((permission) => permissionRow(permission, policy.grants.includes(permission), selected.id, grantsAvailableFor(application).includes(permission))).join("");
  const settings = configSettingsSection(selected, application);
  return `${pageHeader(t("permissions.eyebrow"), t("permissions.title"), t("permissions.desc"))}<section class="permission-layout"><aside class="plugin-picker"><span class="picker-label">${t("permissions.installedPlugins")}</span>${state.plugins.map((plugin) => `<button class="picker-button ${plugin.id === selected.id ? "is-selected" : ""}" data-select-plugin="${escapeHtml(plugin.id)}">${escapeHtml(plugin.name)}<small>${policyFor(plugin).enabled ? t("permissions.enabledFor", { application: escapeHtml(application.name) }) : t("permissions.disabledFor", { application: escapeHtml(application.name) })}</small></button>`).join("")}</aside><article class="panel permission-panel"><header class="permission-plugin-head"><div class="plugin-icon">${initials(selected.name)}</div><div><h2>${escapeHtml(selected.name)}</h2><span class="version">${escapeHtml(t("permissions.policyVersion", { application: application.name, version: selected.version }))}</span></div></header><section class="permission-section"><div class="section-title">${t("permissions.requestedCaps")} <span class="section-count">${selected.requested.length}</span></div><div class="permission-list">${requested || `<p class="empty-inline">${t("permissions.noCaps")}</p>`}</div></section>${settings}<p class="permission-note">${t("permissions.note", { level: levelLabel(application.supportLevel) })}</p></article></section>`;
}
function permissionRow(permission, granted, pluginId, available) {
  const [description, risk] = service.getPermissionDetails(permission);
  const label = available ? (granted ? t("permission.granted") : t("permission.withheld")) : t("permission.unavailable");
  const riskLabel = t("permission.risk", { risk: t(`permission.risk.${risk}`) });
  const aria = escapeHtml(granted ? t("permission.revokeAria", { permission }) : t("permission.grantAria", { permission }));
  return `<div class="permission-row"><div><code>${escapeHtml(permission)}</code><span>${escapeHtml(description)} <i class="risk-badge risk-${risk}">${escapeHtml(riskLabel)}</i></span></div><label class="permission-control"><input type="checkbox" data-toggle-grant="${escapeHtml(permission)}" data-plugin-id="${escapeHtml(pluginId)}" ${granted ? "checked" : ""} ${state.busy || !available ? "disabled" : ""} aria-label="${aria}"><span>${label}</span></label></div>`;
}
const configFieldType = (field) => { const type = field && field.type; return type === "number" || type === "boolean" ? type : "string"; };
function configFieldValue(key, field) {
  const values = state.configValues && typeof state.configValues === "object" ? state.configValues : {};
  if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  if (field && field.default !== undefined && field.default !== null) return field.default;
  return undefined;
}
function configSettingsSection(selected, application) {
  const schema = selected.configSchema && typeof selected.configSchema === "object" ? selected.configSchema : {};
  const keys = Object.keys(schema);
  if (!keys.length) return "";
  return `<section class="permission-section"><div class="section-title">${t("config.pluginSettings")} <span class="section-count">${keys.length}</span></div><div class="permission-list">${keys.map((key) => configFieldRow(selected.id, key, schema[key])).join("")}</div><p class="muted" style="margin:11px 2px 0;font-size:12px;">${escapeHtml(t("config.storedIn", { name: application.name }))}</p></section>`;
}
function configFieldRow(pluginId, key, field) {
  const type = configFieldType(field);
  const label = field && field.label ? String(field.label) : key;
  const fieldId = `th-config-${[pluginId, key].map((part) => encodeURIComponent(part)).join("-")}`;
  const shared = `data-config-field="${escapeHtml(key)}" data-config-type="${type}" data-plugin-id="${escapeHtml(pluginId)}"`;
  const heading = `<strong style="display:block;color:#e2f3ee;font:600 13px/1.25 'Bahnschrift','Segoe UI Variable Display','Segoe UI',sans-serif;">${escapeHtml(label)}</strong><span>${escapeHtml(label === key ? t("config.fieldType", { type }) : `${key} · ${type}`)}</span>`;
  if (type === "boolean") {
    const checked = configFieldValue(key, field) === true;
    const aria = escapeHtml(t("config.toggleAria", { action: checked ? t("config.turnOff") : t("config.turnOn"), label }));
    return `<div class="permission-row"><div>${heading}</div><label class="permission-control"><input type="checkbox" id="${fieldId}" ${shared} ${checked ? "checked" : ""} ${state.busy ? "disabled" : ""} aria-label="${aria}"><span>${checked ? t("config.on") : t("config.off")}</span></label></div>`;
  }
  const value = configFieldValue(key, field);
  const text = value === undefined ? "" : String(value);
  const inputStyle = "width:100%;min-width:0;padding:8px 10px;color:#e2f3ee;border:1px solid rgba(206,239,229,.18);border-radius:8px;background:#172c3a;font:500 12px/1.2 'Cascadia Mono','Consolas',monospace;";
  const aria = escapeHtml(t("config.fieldAria", { label, type }));
  const input = `<input type="${type === "number" ? "number" : "text"}" id="${fieldId}" ${shared} value="${escapeHtml(text)}" style="${inputStyle}" ${state.busy ? "disabled" : ""} aria-label="${aria}">`;
  return `<div class="permission-row" style="grid-template-columns:minmax(0,1fr) minmax(150px,240px);"><label for="${fieldId}" style="display:block;min-width:0;cursor:pointer;">${heading}</label>${input}</div>`;
}
async function syncPluginConfig() {
  const application = selectedApplication();
  const selected = state.plugins.find((plugin) => plugin.id === state.selectedPluginId) || state.plugins[0];
  const schema = selected && selected.configSchema && typeof selected.configSchema === "object" ? selected.configSchema : {};
  if (!application || !selected || !Object.keys(schema).length) { state.configScope = ""; state.configValues = null; return; }
  const scope = `${application.id}|${selected.id}`;
  if (state.configScope === scope) return;
  state.configScope = scope;
  state.configValues = null;
  const applicationId = application.id;
  const pluginId = selected.id;
  const generation = state.configGeneration;
  try {
    const result = await service.getPluginConfig(applicationId, pluginId);
    const values = result && typeof result === "object" && result.config && typeof result.config === "object" ? result.config : {};
    if (generation !== state.configGeneration) return;
    if (applicationId !== state.selectedApplicationId || pluginId !== state.selectedPluginId) return;
    state.configValues = values;
    if (state.view === "permissions") render();
  } catch {
    // A failed read keeps the schema defaults visible; the scope marker stays set so a failing
    // read is not retried on every render while this plugin/application remains selected.
  }
}

function renderSettings() {
  const developerMode = Boolean(state.developerMode);
  const toggle = `<label class="switch" title="${escapeHtml(developerMode ? t("settings.devMode.toggleOn") : t("settings.devMode.toggleOff"))}"><input type="checkbox" data-toggle-developer-mode ${developerMode ? "checked" : ""} ${state.busy ? "disabled" : ""} aria-label="${escapeHtml(developerMode ? t("settings.devMode.ariaOn") : t("settings.devMode.ariaOff"))}"><span class="slider"></span></label>`;
  const warning = developerMode ? `<div class="error-banner" role="alert" style="margin:0;"><span>${t("settings.devMode.warning")}</span></div>` : "";
  const guide = `<div class="stream-guide" style="margin:0;"><div><strong>${t("settings.guide.node.title")}</strong><span>${t("settings.guide.node.desc")}</span></div><div><strong>${t("settings.guide.l2.title")}</strong><span>${t("settings.guide.l2.desc")}</span></div><div><strong>${t("settings.guide.reversible.title")}</strong><span>${t("settings.guide.reversible.desc")}</span></div></div>`;
  const autostart = Boolean(state.coreAutostart);
  const autostartToggle = `<label class="switch" title="${escapeHtml(autostart ? t("settings.autostart.on") : t("settings.autostart.off"))}"><input type="checkbox" data-toggle-autostart ${autostart ? "checked" : ""} ${state.busy || state.coreAutostart === undefined ? "disabled" : ""} aria-label="${escapeHtml(autostart ? t("settings.autostart.ariaOn") : t("settings.autostart.ariaOff"))}"><span class="slider"></span></label>`;
  const languageSelect = `<label class="application-select" style="flex:none;"><select data-language-select aria-label="${t("settings.language.title")}"><option value="en" ${getLanguage() === "en" ? "selected" : ""}>${t("settings.language.optionEn")}</option><option value="zh" ${getLanguage() === "zh" ? "selected" : ""}>${t("settings.language.optionZh")}</option></select></label>`;
  return `${pageHeader(t("settings.eyebrow"), t("settings.title"), t("settings.desc"))}<section style="display:grid;gap:18px;max-width:900px;"><article class="panel"><header class="panel-header"><div><h2>${t("settings.devMode.title")}</h2><p class="muted" style="margin:3px 0 0;font-size:12px;">${t("settings.devMode.desc")}</p></div>${toggle}</header><div style="padding:22px;display:grid;gap:15px;">${warning}<p class="muted" style="margin:0;">${t("settings.devMode.explain")}</p>${guide}<p class="permission-note" style="margin:0;">${t("settings.devMode.offNote")}</p></div></article><article class="panel"><header class="panel-header"><div><h2>${t("settings.system.title")}</h2><p class="muted" style="margin:3px 0 0;font-size:12px;">${t("settings.system.desc")}</p></div></header><div style="padding:22px;display:grid;gap:14px;"><div class="setting-row"><div><strong>${t("settings.language.title")}</strong><span>${t("settings.language.desc")}</span></div>${languageSelect}</div><div class="setting-row"><div><strong>${t("settings.autostart.title")}</strong><span>${t("settings.autostart.desc")}</span></div>${autostartToggle}</div></div></article></section>`;
}

function renderLogs() {
  const application = selectedApplication();
  const logs = state.logs;
  const scopeLabel = logs.scope === "selected" && application ? application.name : t("logs.scope.all");
  const escapedScope = escapeHtml(scopeLabel.toLowerCase());
  const action = `<button class="button button-quiet" data-refresh-logs ${logs.loading || logs.loadingOlder ? "disabled" : ""}>${t("action.refresh")}</button>`;
  let content;
  if (logs.loading) content = `<section class="log-state"><div class="loader" aria-label="${t("loading.aria")}"></div><h2>${t("logs.loading.title")}</h2><p>${t("logs.loading.desc", { scope: escapedScope })}</p></section>`;
  else if (logs.error && !logs.events.length) content = `<section class="log-state" role="alert"><div class="state-icon">!</div><h2>${t("logs.error.title")}</h2><p>${escapeHtml(logs.error)}</p><button class="button button-primary" data-refresh-logs>${t("common.tryAgain")}</button></section>`;
  else if (!logs.events.length) content = `<section class="log-state"><div class="state-icon">≡</div><h2>${t("logs.noEvents.title")}</h2><p>${t("logs.noEvents.desc", { scope: escapedScope })}</p></section>`;
  else content = `<ol class="log-list" aria-label="${t("logs.title")}">${logs.events.map(logRow).join("")}</ol>`;
  const pagination = logs.events.length ? (logs.loadingOlder ? `<p class="log-pagination-status" role="status">${t("logs.loadingOlder")}</p>` : logs.nextBeforeSequence !== null ? `<button class="button button-quiet" data-load-older>${t("action.loadOlder")}</button>` : `<p class="log-pagination-status">${t("logs.oldest")}</p>`) : "";
  const queryError = logs.error && logs.events.length ? `<div class="log-query-error" role="alert"><span>${escapeHtml(logs.error)}</span><button class="text-link" data-refresh-logs>${t("common.tryAgain")}</button></div>` : "";
  const countLabel = t(logs.events.length === 1 ? "logs.results.one" : "logs.results.many", { count: logs.events.length });
  const summary = logs.loaded ? `${countLabel} · ${escapeHtml(scopeLabel)}` : t("logs.results.ready");
  return `${pageHeader(t("logs.eyebrow"), t("logs.title"), t("logs.desc"), action)}<section class="log-layout"><article class="panel log-panel"><div class="log-query-toolbar"><div class="log-filter-group"><label><span>${t("logs.scope.label")}</span><select data-log-scope aria-label="${t("logs.scopeAria")}"><option value="all" ${logs.scope === "all" ? "selected" : ""}>${t("logs.scope.all")}</option><option value="selected" ${logs.scope === "selected" ? "selected" : ""} ${application ? "" : "disabled"}>${t("logs.scope.selected")}</option></select></label><label><span>${t("logs.stream.label")}</span><select data-log-stream aria-label="${t("logs.streamAria")}"><option value="all" ${logs.stream === "all" ? "selected" : ""}>${t("logs.stream.all")}</option><option value="core" ${logs.stream === "core" ? "selected" : ""}>${t("logs.stream.core")}</option><option value="runtime" ${logs.stream === "runtime" ? "selected" : ""}>${t("logs.stream.runtime")}</option><option value="plugin" ${logs.stream === "plugin" ? "selected" : ""}>${t("logs.stream.plugin")}</option></select></label></div><p class="log-results-summary" role="status">${summary}</p></div>${queryError}${content}<div class="log-pagination">${pagination}</div></article><aside class="panel log-side"><p class="eyebrow">${t("logs.queryDetails")}</p><h2>${t("logs.readOnlyTitle")}</h2><div class="stream-guide"><div><strong>${t("logs.guide.latest.title")}</strong><span>${t("logs.guide.latest.desc")}</span></div><div><strong>${t("logs.guide.scoped.title")}</strong><span>${t("logs.guide.scoped.desc")}</span></div><div><strong>${t("logs.guide.nolive.title")}</strong><span>${t("logs.guide.nolive.desc")}</span></div></div></aside></section>`;
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
  const plugin = event.pluginId ? `<span class="log-context-item">${t("logs.pluginContext", { name: escapeHtml(displayPluginName(event.pluginId)) })}</span>` : "";
  return `<li class="log-row"><div class="log-event-meta"><div><span class="log-time">${formatLogTimestamp(event.timestampMs)}</span><span class="log-level ${level}">${escapeHtml(event.level)}</span></div><div class="log-context"><span class="log-stream stream-${stream}">${escapeHtml(event.stream)}</span><span class="log-context-item">${t("logs.appContext", { name: escapeHtml(applicationName) })}</span>${plugin}</div></div><div class="log-event-body"><code>${escapeHtml(event.code)}</code><p>${escapeHtml(event.message)}</p></div></li>`;
}

function render() {
  const body = state.status === "loading" ? loading() : state.status === "error" ? failure() : state.view === "applications" ? renderApplications() : state.view === "plugins" ? renderPlugins() : state.view === "permissions" ? renderPermissions() : state.view === "settings" ? renderSettings() : renderLogs();
  appRoot.innerHTML = state.status === "ready" ? layout(body) : `<main class="content"><div class="page">${body}</div></main>`;
}

async function refreshSnapshot(initial = false) {
  if (initial) { state.status = "loading"; render(); }
  const snapshot = await service.getSnapshot();
  state.applications = snapshot.applications;
  state.plugins = snapshot.plugins;
  state.developerMode = Boolean(snapshot.developerMode);
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
async function loadCoreAutostart() {
  if (state.coreAutostart !== undefined || state.coreAutostartLoading) return;
  state.coreAutostartLoading = true;
  try {
    const result = await service.getCoreAutostart();
    state.coreAutostart = Boolean(result && result.enabled);
  } catch {
    state.coreAutostart = false;
  } finally {
    state.coreAutostartLoading = false;
    if (state.view === "settings") render();
  }
}

async function loadIefo() {
  const application = selectedApplication();
  const targetId = application?.id;
  if (!targetId || state.iefo.id === targetId || state.iefo.loading) return;
  state.iefo.id = targetId;
  state.iefo.loading = true;
  state.iefo.registered = false;
  state.iefo.owned = true;
  state.iefo.error = "";
  try {
    const result = await service.getIefo(targetId);
    if (state.iefo.id !== targetId) return;
    state.iefo.registered = Boolean(result && result.registered);
    state.iefo.owned = result && "owned" in result ? result.owned !== false : true;
  } catch (error) {
    if (state.iefo.id !== targetId) return;
    state.iefo.error = errorMessage(error);
  } finally {
    if (state.iefo.id !== targetId) return;
    state.iefo.loading = false;
    if (state.view === "applications") render();
  }
}

appRoot.addEventListener("click", async (event) => {
  const launchButton = event.target.closest("button[data-launch]");
  const removeApplicationButton = event.target.closest("button[data-remove-application]");
  const selectCard = event.target.closest("[data-select-application]");
  const button = event.target.closest("button");
  if (button && button.disabled) return;
  if (launchButton) {
    if (launchButton.disabled) return;
    await perform(() => service.launchApplication(launchButton.dataset.launch), t("msg.launched"));
    return;
  }
  if (removeApplicationButton) {
    if (removeApplicationButton.disabled) return;
    const application = state.applications.find((entry) => entry.id === removeApplicationButton.dataset.removeApplication);
    state.removeApplicationId = application?.id ?? null;
    document.querySelector("#remove-app-title").textContent = t("dialog.removeApp.titleNamed", { name: application?.name ?? t("dialog.removeApp.titleFallback") });
    removeApplicationDialog.showModal();
    return;
  }
  if (selectCard) { state.selectedApplicationId = selectCard.dataset.selectApplication; render(); return; }
  if (!button || button.disabled) return;
  if (button.dataset.dismissFeedback !== undefined) { state.notice = ""; state.operationError = ""; render(); return; }
  if (button.dataset.view) { state.view = button.dataset.view; render(); if (state.view === "logs") queryLogs(); if (state.view === "settings") loadCoreAutostart(); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; render(); return; }
  if (button.dataset.permissions) { state.selectedPluginId = button.dataset.permissions; state.view = "permissions"; render(); return; }
  if (button.dataset.selectPlugin) { state.selectedPluginId = button.dataset.selectPlugin; render(); return; }
  if (button.dataset.refreshLogs !== undefined) { queryLogs(); return; }
  if (button.dataset.loadOlder !== undefined) { queryLogs({ older: true }); return; }
  if (button.dataset.addApplication !== undefined) { applicationDialog.showModal(); return; }
  if (button.dataset.install !== undefined) { if (await perform(() => service.installPlugin(), t("msg.pluginInstalled"), t("msg.pluginInstallCanceled"))) state.view = "plugins"; render(); return; }
  if (button.dataset.remove) { const plugin = state.plugins.find((entry) => entry.id === button.dataset.remove); state.removePluginId = plugin?.id ?? null; document.querySelector("#remove-title").textContent = t("dialog.remove.titleNamed", { name: plugin?.name ?? t("dialog.remove.titleFallback") }); removeDialog.showModal(); return; }
  if (button.dataset.retry !== undefined) load();
});

// The selectable application card is an element with `role="button"`, so Enter/Space on the
// focused card selects it exactly like the previous native-button card did.
appRoot.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target instanceof Element ? event.target.closest("[data-select-application]") : null;
  if (!card || card !== event.target) return;
  event.preventDefault();
  state.selectedApplicationId = card.dataset.selectApplication;
  render();
});

appRoot.addEventListener("change", async (event) => {
  if (event.target.matches("[data-application-select]")) {
    state.selectedApplicationId = event.target.value;
    render();
    if (state.view === "logs" && state.logs.scope === "selected") queryLogs();
    return;
  }
  if (event.target.matches("[data-language-select]")) {
    setLanguage(event.target.value);
    render();
    return;
  }
  if (event.target.matches("[data-log-scope]")) { state.logs.scope = event.target.value; queryLogs(); return; }
  if (event.target.matches("[data-log-stream]")) { state.logs.stream = event.target.value; queryLogs(); return; }
  if (event.target.matches("[data-toggle-developer-mode]")) {
    const enabled = event.target.checked;
    await perform(() => service.setDeveloperMode(enabled), enabled ? t("msg.developerModeOn") : t("msg.developerModeOff"));
    return;
  }
  if (event.target.matches("[data-toggle-autostart]")) {
    const enabled = event.target.checked;
    state.coreAutostart = enabled;
    const completed = await perform(() => service.setCoreAutostart(enabled), enabled ? t("msg.autostartOn") : t("msg.autostartOff"));
    if (!completed) state.coreAutostart = !enabled;
    render();
    return;
  }
  if (event.target.matches("[data-toggle-iefo]")) {
    const applicationId = event.target.dataset.toggleIefo;
    const enabled = event.target.checked;
    state.busy = true; state.operationError = ""; state.notice = ""; render();
    try {
      const result = await service.setIefo(applicationId, enabled);
      if (state.iefo.id === applicationId) state.iefo.registered = Boolean(result && result.registered);
      state.notice = result && result.cancelled ? t("iefo.notice.cancelled") : (state.iefo.registered ? t("iefo.notice.enabled") : t("iefo.notice.disabled"));
    } catch (error) {
      state.operationError = errorMessage(error);
    } finally {
      state.busy = false;
      render();
    }
    return;
  }
  if (event.target.matches("[data-toggle-policy]")) {
    const plugin = state.plugins.find((entry) => entry.id === event.target.dataset.togglePolicy);
    const policy = plugin && policyFor(plugin);
    if (plugin && policy) await perform(() => service.setApplicationPluginPolicy(state.selectedApplicationId, plugin.id, { enabled: event.target.checked, grants: policy.grants }), t("msg.pluginPolicyUpdated"));
  }
  if (event.target.matches("[data-toggle-grant]")) {
    const plugin = state.plugins.find((entry) => entry.id === event.target.dataset.pluginId);
    const policy = plugin && policyFor(plugin);
    if (plugin && policy) {
      const grant = event.target.dataset.toggleGrant;
      const grants = event.target.checked ? [...new Set([...policy.grants, grant])] : policy.grants.filter((entry) => entry !== grant);
      await perform(() => service.setApplicationPluginPolicy(state.selectedApplicationId, plugin.id, { enabled: policy.enabled, grants }), t("msg.pluginPolicyUpdated"));
    }
  }
  if (event.target.matches("[data-config-field]")) {
    const plugin = state.plugins.find((entry) => entry.id === event.target.dataset.pluginId);
    const applicationId = state.selectedApplicationId;
    const key = event.target.dataset.configField;
    const type = event.target.dataset.configType;
    const schema = plugin && plugin.configSchema && typeof plugin.configSchema === "object" ? plugin.configSchema : {};
    if (!plugin || !applicationId || !key || !type || !schema[key]) return;
    state.configGeneration += 1;
    const checked = event.target.checked;
    const raw = event.target.value;
    const hasValue = raw !== "";
    const number = event.target.valueAsNumber;
    await perform(async () => {
      // setPluginConfig REPLACES the whole stored object, so re-read the stored config first and
      // write back the full desired state — otherwise the untouched keys would be dropped.
      const current = await service.getPluginConfig(applicationId, plugin.id);
      const base = current && typeof current === "object" && current.config && typeof current.config === "object" ? { ...current.config } : {};
      if (type === "boolean") base[key] = checked;
      else if (type === "number") { if (hasValue && Number.isFinite(number)) base[key] = number; else delete base[key]; }
      else base[key] = raw;
      const result = await service.setPluginConfig(applicationId, plugin.id, base);
      if (result && typeof result === "object" && result.config && typeof result.config === "object") state.configValues = result.config;
      else state.configValues = base;
      return result;
    }, t("msg.pluginSettingsUpdated"));
    return;
  }
});

removeForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "default" || !state.removePluginId) return;
  event.preventDefault();
  const pluginId = state.removePluginId;
  removeDialog.close(); state.removePluginId = null;
  await perform(() => service.removePlugin(pluginId), t("msg.pluginRemoved"));
});

applicationForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "default") return;
  event.preventDefault();
  const supportLevel = Number(supportLevelInput.value);
  if (![0, 1, 2].includes(supportLevel)) return;
  applicationDialog.close();
  await perform(
    () => service.registerApplication(supportLevel),
    t("msg.applicationRegistered"),
    t("msg.applicationRegisterCanceled"),
  );
});

removeApplicationForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "default" || !state.removeApplicationId) return;
  event.preventDefault();
  const applicationId = state.removeApplicationId;
  removeApplicationDialog.close(); state.removeApplicationId = null;
  await perform(() => service.removeApplication(applicationId), t("msg.applicationRemoved"));
});

load();

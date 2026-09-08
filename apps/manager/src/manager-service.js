import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n.js";

// Stable risk identifiers (used for the `risk-*` CSS class and the `permission.risk.<id>` key).
const permissionRisk = {
  "renderer.css": "low",
  "renderer.script": "medium",
  "renderer.dom": "medium",
  "renderer.storage": "low",
  "electron.window": "high",
  "electron.windowControls": "high",
  "network.access": "medium",
  "runtime.unsafe": "high",
};

function presentSnapshot(snapshot) {
  const applications = Object.entries(snapshot?.applications ?? {}).map(([id, application]) => ({
    id,
    name: application.displayName,
    supportLevel: application.supportLevel,
    policies: application.plugins ?? {},
  }));

  const plugins = (snapshot?.plugins ?? []).map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    author: plugin.author,
    tronhawk: plugin.tronhawk,
    requested: plugin.requestedPermissions ?? [],
    configSchema: plugin.config ?? {},
    applicationPolicies: applications.flatMap((application) => {
      const policy = application.policies[plugin.id];
      return policy ? [{ applicationId: application.id, enabled: policy.enabled, grants: policy.grants ?? [] }] : [];
    }),
  }));

  return {
    developerMode: Boolean(snapshot?.global?.developerMode),
    applications: applications.map(({ policies, ...application }) => ({
      ...application,
      enabledPluginCount: Object.values(policies).filter((policy) => policy.enabled).length,
    })),
    plugins,
  };
}

/** A deliberately narrow boundary over the Manager's fixed Tauri commands. */
export function createManagerService() {
  return {
    async getSnapshot() {
      return presentSnapshot(await invoke("get_manager_snapshot"));
    },
    async launchApplication(applicationId) {
      return invoke("launch_application", { applicationId });
    },
    async setApplicationPluginPolicy(applicationId, pluginId, policy) {
      return invoke("set_application_plugin_policy", {
        applicationId,
        pluginId,
        enabled: policy.enabled,
        grants: policy.grants,
      });
    },
    async getPluginConfig(applicationId, pluginId) {
      return invoke("get_plugin_config", { applicationId, pluginId });
    },
    async setPluginConfig(applicationId, pluginId, config) {
      return invoke("set_plugin_config", { applicationId, pluginId, config });
    },
    async removePlugin(pluginId) {
      return invoke("remove_plugin", { pluginId });
    },
    async installPlugin() {
      return invoke("install_plugin");
    },
    async registerApplication(supportLevel) {
      return invoke("register_application", { supportLevel });
    },
    async removeApplication(applicationId) {
      return invoke("remove_application", { applicationId });
    },
    async getIefo(applicationId) {
      return invoke("get_iefo_registration", { applicationId });
    },
    async setIefo(applicationId, enabled) {
      return invoke("set_iefo_registration", { applicationId, enabled });
    },
    async setDeveloperMode(enabled) {
      return invoke("set_developer_mode", { enabled });
    },
    async getCoreAutostart() {
      return invoke("get_core_autostart");
    },
    async setCoreAutostart(enabled) {
      return invoke("set_core_autostart", { enabled });
    },
    async queryLogs({ applicationId, stream, beforeSequence, limit }) {
      const params = { limit };
      if (applicationId) params.applicationId = applicationId;
      if (stream) params.stream = stream;
      if (beforeSequence !== undefined && beforeSequence !== null) params.beforeSequence = beforeSequence;
      return invoke("query_logs", params);
    },
    getPermissionDetails(permission) {
      const risk = permissionRisk[permission];
      if (!risk) return [t("perm.default"), "unknown"];
      const key = `perm.${permission}`;
      const description = t(key);
      return [description === key ? t("perm.default") : description, risk];
    },
  };
}

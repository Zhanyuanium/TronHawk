mod core_client;

use core_client::CoreClient;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

struct ManagerState {
    core: CoreClient,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum LogStream {
    Core,
    Runtime,
    Plugin,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogEventDto {
    schema_version: u32,
    sequence: u64,
    timestamp_ms: u64,
    stream: LogStream,
    level: String,
    code: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    application_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>,
    message: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryLogsResultDto {
    events: Vec<LogEventDto>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    next_before_sequence: Option<u64>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

fn deserialize_query_logs_result(value: Value) -> Result<QueryLogsResultDto, String> {
    serde_json::from_value(value).map_err(|_| "Core returned an invalid log result".to_owned())
}

#[tauri::command]
fn get_manager_snapshot(state: State<'_, ManagerState>) -> Result<Value, String> {
    state
        .core
        .call("getManagerSnapshot", json!({}))
        .and_then(redact_manager_snapshot)
}

/// Launches a registered application with extensions. Unlike `get_manager_snapshot`, this
/// command does NOT redact the snapshot it reads: the executable path is resolved in Rust and
/// handed straight to the co-located injector launcher, and only a fixed `{ "launched": true }`
/// acknowledgment (or a fixed, path-free error) ever crosses the WebView boundary.
#[tauri::command]
fn launch_application(
    state: State<'_, ManagerState>,
    application_id: String,
) -> Result<Value, String> {
    state.core.launch(&application_id)
}

#[tauri::command]
fn query_logs(
    state: State<'_, ManagerState>,
    application_id: Option<String>,
    stream: Option<LogStream>,
    before_sequence: Option<u64>,
    limit: u32,
) -> Result<QueryLogsResultDto, String> {
    if !(1..=20).contains(&limit) {
        return Err("log query limit must be between 1 and 20".to_owned());
    }

    let result = state
        .core
        .call(
            "queryLogs",
            json!({
                "applicationId": application_id,
                "stream": stream,
                "beforeSequence": before_sequence,
                "limit": limit,
            }),
        )
        .map_err(|_| "failed to query Core logs".to_owned())?;
    deserialize_query_logs_result(result)
}

#[tauri::command]
fn register_application(
    app: AppHandle,
    state: State<'_, ManagerState>,
    support_level: u8,
) -> Result<Option<Value>, String> {
    let picker = app.dialog().file();
    #[cfg(windows)]
    let picker = picker.add_filter("Windows applications", &["exe"]);
    #[cfg(not(windows))]
    let picker = picker.add_filter("Applications", &["*"]);

    let Some(selected) = picker.blocking_pick_file() else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "the selected application is not a local file".to_owned())?;
    let path = path
        .to_str()
        .ok_or_else(|| "the selected application path is not valid Unicode".to_owned())?;
    let result = state.core.call(
        "registerApplication",
        json!({
            "executablePath": path,
            "supportLevel": support_level,
        }),
    )?;
    Ok(Some(redact_application_registration(result)?))
}

fn redact_manager_snapshot(mut snapshot: Value) -> Result<Value, String> {
    let applications = snapshot
        .get_mut("applications")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Core returned an invalid manager snapshot".to_owned())?;
    for application in applications.values_mut() {
        redact_application_record(application, "manager snapshot")?;
    }
    Ok(snapshot)
}

fn redact_application_registration(mut registration: Value) -> Result<Value, String> {
    redact_application_record(&mut registration, "application registration")?;
    Ok(registration)
}

fn redact_application_record(application: &mut Value, context: &str) -> Result<(), String> {
    let object = application
        .as_object_mut()
        .ok_or_else(|| format!("Core returned an invalid {context}"))?;
    object.remove("executablePath");
    Ok(())
}

#[tauri::command]
fn set_application_plugin_policy(
    state: State<'_, ManagerState>,
    application_id: String,
    plugin_id: String,
    enabled: bool,
    grants: Vec<String>,
) -> Result<Value, String> {
    state.core.call(
        "setApplicationPluginPolicy",
        json!({
            "applicationId": application_id,
            "pluginId": plugin_id,
            "enabled": enabled,
            "grants": grants,
        }),
    )
}

/// Reads the stored per-plugin config (schema defaults merged with stored values) for one
/// application. A thin passthrough to Core's `getPluginConfig` control RPC; the returned object
/// holds only schema-declared scalar values, never paths or credentials.
#[tauri::command]
fn get_plugin_config(
    state: State<'_, ManagerState>,
    application_id: String,
    plugin_id: String,
) -> Result<Value, String> {
    state.core.call(
        "getPluginConfig",
        json!({
            "applicationId": application_id,
            "pluginId": plugin_id,
        }),
    )
}

/// Replaces the whole stored config object for one application + plugin. A thin passthrough to
/// Core's `setPluginConfig` control RPC; Core validates every key against the plugin's manifest
/// schema and rejects unknown keys or type mismatches, so the config field is validated to be a
/// JSON object here before it is ever forwarded.
#[tauri::command]
fn set_plugin_config(
    state: State<'_, ManagerState>,
    application_id: String,
    plugin_id: String,
    config: Value,
) -> Result<Value, String> {
    if !config.is_object() {
        return Err("plugin config must be a JSON object".to_owned());
    }
    state.core.call(
        "setPluginConfig",
        json!({
            "applicationId": application_id,
            "pluginId": plugin_id,
            "config": config,
        }),
    )
}

#[tauri::command]
fn remove_plugin(state: State<'_, ManagerState>, plugin_id: String) -> Result<Value, String> {
    state
        .core
        .call("removePlugin", json!({ "pluginId": plugin_id }))
}

#[tauri::command]
fn set_developer_mode(state: State<'_, ManagerState>, enabled: bool) -> Result<Value, String> {
    state
        .core
        .call("setDeveloperMode", json!({ "enabled": enabled }))
}

#[tauri::command]
fn install_plugin(
    app: AppHandle,
    state: State<'_, ManagerState>,
) -> Result<Option<Value>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("TronHawk plugin", &["thx"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "the selected plugin is not a local file".to_owned())?;
    let path = path
        .to_str()
        .ok_or_else(|| "the selected plugin path is not valid Unicode".to_owned())?;
    state
        .core
        .call("installPlugin", json!({ "path": path }))
        .map(Some)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ManagerState {
            core: CoreClient::from_environment(),
        })
        .invoke_handler(tauri::generate_handler![
            get_manager_snapshot,
            launch_application,
            query_logs,
            register_application,
            set_application_plugin_policy,
            get_plugin_config,
            set_plugin_config,
            remove_plugin,
            install_plugin,
            set_developer_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_registration_result_does_not_expose_the_selected_path() {
        let result = redact_application_registration(json!({
            "applicationId": "application-id",
            "executablePath": "C:\\private\\selected.exe",
            "displayName": "selected",
            "supportLevel": 2
        }))
        .unwrap();

        assert!(result.get("executablePath").is_none());
        assert_eq!(result["applicationId"], "application-id");
        assert_eq!(result["supportLevel"], 2);
    }

    #[test]
    fn manager_snapshot_redacts_paths_without_changing_application_data() {
        let result = redact_manager_snapshot(json!({
            "global": { "developerMode": false },
            "applications": {
                "app-one": {
                    "executablePath": "C:\\private\\one.exe",
                    "displayName": "One",
                    "supportLevel": 2,
                    "plugins": {
                        "plugin.one": { "enabled": true, "grants": ["renderer.css"] }
                    }
                },
                "app-two": {
                    "executablePath": "D:\\private\\two.exe",
                    "displayName": "Two",
                    "supportLevel": 1,
                    "plugins": {
                        "plugin.two": { "enabled": false, "grants": [] }
                    }
                }
            },
            "plugins": []
        }))
        .unwrap();

        let applications = result["applications"].as_object().unwrap();
        assert_eq!(applications.len(), 2);
        assert!(applications.contains_key("app-one"));
        assert!(applications.contains_key("app-two"));
        assert!(applications
            .values()
            .all(|application| application.get("executablePath").is_none()));
        assert_eq!(applications["app-one"]["displayName"], "One");
        assert_eq!(applications["app-one"]["supportLevel"], 2);
        assert_eq!(
            applications["app-one"]["plugins"]["plugin.one"],
            json!({ "enabled": true, "grants": ["renderer.css"] })
        );
        assert_eq!(applications["app-two"]["displayName"], "Two");
        assert_eq!(applications["app-two"]["supportLevel"], 1);
        assert_eq!(
            applications["app-two"]["plugins"]["plugin.two"],
            json!({ "enabled": false, "grants": [] })
        );
    }

    #[test]
    fn log_result_dto_exposes_only_the_approved_fields() {
        let result = deserialize_query_logs_result(json!({
            "events": [{
                "schemaVersion": 1,
                "sequence": 42,
                "timestampMs": 1_725_000_000_000_u64,
                "stream": "plugin",
                "level": "info",
                "code": "plugin.loaded",
                "applicationId": "app-one",
                "pluginId": "plugin.one",
                "message": "Plugin loaded"
            }],
            "nextBeforeSequence": 41
        }))
        .unwrap();

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "events": [{
                    "schemaVersion": 1,
                    "sequence": 42,
                    "timestampMs": 1_725_000_000_000_u64,
                    "stream": "plugin",
                    "level": "info",
                    "code": "plugin.loaded",
                    "applicationId": "app-one",
                    "pluginId": "plugin.one",
                    "message": "Plugin loaded"
                }],
                "nextBeforeSequence": 41
            })
        );
    }

    #[test]
    fn log_result_dto_rejects_sensitive_or_arbitrary_fields() {
        for forbidden_field in ["path", "token", "pluginSource", "payload"] {
            let mut event = json!({
                "schemaVersion": 1,
                "sequence": 42,
                "timestampMs": 1_725_000_000_000_u64,
                "stream": "core",
                "level": "warn",
                "code": "core.warning",
                "applicationId": null,
                "message": "Warning"
            });
            event
                .as_object_mut()
                .unwrap()
                .insert(forbidden_field.to_owned(), json!("private"));

            let error = deserialize_query_logs_result(json!({
                "events": [event],
                "nextBeforeSequence": null
            }))
            .err()
            .unwrap();
            assert_eq!(error, "Core returned an invalid log result");
        }
    }
}

use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::log_store::{LogLevel, LogQuery, LogStore, LogStream, NewLogRecord};
use crate::{hash_json, plugin_grant, transaction_dir, transaction_file, ExecutionPlan, Plugin};

const STATE_SCHEMA_VERSION: u32 = 1;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const IMPLEMENTED_RENDERER_CAPABILITIES: &[&str] = &["renderer.css", "renderer.script"];
const IMPLEMENTED_LEVEL_TWO_CAPABILITIES: &[&str] =
    &["renderer.css", "renderer.script", "electron.window"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GlobalState {
    developer_mode: bool,
}

impl Default for GlobalState {
    fn default() -> Self {
        Self {
            developer_mode: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPolicy {
    pub enabled: bool,
    #[serde(default)]
    pub grants: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationState {
    pub executable_path: String,
    pub display_name: String,
    pub support_level: u8,
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaemonState {
    schema_version: u32,
    global: GlobalState,
    #[serde(default)]
    applications: BTreeMap<String, ApplicationState>,
}

impl Default for DaemonState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            global: GlobalState::default(),
            applications: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
struct LaunchSession {
    application_id: String,
    last_used: Instant,
    allowed_plan_plugins: HashSet<String>,
    log_events: VecDeque<Instant>,
}

#[derive(Debug)]
struct ServiceInner {
    state: DaemonState,
    sessions: HashMap<String, LaunchSession>,
}

/// Single-writer Core state and request router.
pub struct CoreService {
    root: PathBuf,
    installed_root: PathBuf,
    state_path: PathBuf,
    control_token_path: PathBuf,
    control_token: String,
    inner: Mutex<ServiceInner>,
    logs: Mutex<LogStore>,
}

impl CoreService {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        let installed_root = root.join("plugins").join("installed");
        let config_root = root.join("config");
        let state_path = config_root.join("state.json");
        let control_token_path = config_root.join("control.token");
        std::fs::create_dir_all(&installed_root)
            .map_err(|e| format!("create installed root: {e}"))?;
        // A crash mid-install/remove can leave hidden transaction dirs behind; sweep them
        // best-effort so they never accumulate into permanent debris.
        sweep_orphaned_transaction_dirs(&installed_root);
        create_config_directory(&config_root)?;

        let (state, state_needs_write) = read_state(&state_path)?;
        if state_needs_write {
            write_state(&state_path, &state)?;
        }
        let control_token = read_or_create_control_token(&control_token_path)?;
        let logs = LogStore::new(&root)?;

        Ok(Self {
            root,
            installed_root,
            state_path,
            control_token_path,
            control_token,
            logs: Mutex::new(logs),
            inner: Mutex::new(ServiceInner {
                state,
                sessions: HashMap::new(),
            }),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Location a privileged local backend can read to obtain the control credential.
    pub fn control_token_path(&self) -> &Path {
        &self.control_token_path
    }

    pub fn handle_request(&self, request: tronhawk_ipc::Request) -> tronhawk_ipc::Response {
        if request.version != tronhawk_ipc::PROTOCOL_VERSION {
            return tronhawk_ipc::Response::err(request.id, -32600, "unsupported protocol version");
        }

        // Server identity probe (SEC-1): an unauthenticated client proves we hold the control
        // token before it ever sends the token over the wire. Handled before any control/session
        // authorization so a port-squatter cannot capture the credential.
        if request.method == "getServerProof" {
            return self.server_proof(request);
        }

        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };
        inner
            .sessions
            .retain(|_, session| session.last_used.elapsed() < SESSION_IDLE_TIMEOUT);

        if constant_time_eq(request.secret.as_bytes(), self.control_token.as_bytes()) {
            return self.handle_control(request, &mut inner);
        }

        let Some(session) = inner.sessions.get(&request.secret) else {
            return rpc_error(request.id, -32001, "unauthorized");
        };
        let application_id = session.application_id.clone();
        match request.method.as_str() {
            "getExecutionPlan" => {
                if !is_empty_params(&request.params) {
                    return rpc_error(request.id, -32602, "invalid params");
                }
                match self.execution_plan(&inner.state, &application_id) {
                    Ok(plan) => {
                        if let Some(session) = inner.sessions.get_mut(&request.secret) {
                            session.allowed_plan_plugins = plan
                                .plugins
                                .iter()
                                .map(|plugin| plugin.id.clone())
                                .collect();
                            session.last_used = Instant::now();
                        }
                        rpc_ok(request.id, plan)
                    }
                    Err(_) => rpc_error(request.id, -32603, "internal error"),
                }
            }
            "appendRuntimeLogs" => self.append_runtime_logs(request, &mut inner, &application_id),
            "appendPluginLogs" => self.append_plugin_logs(request, &mut inner, &application_id),
            _ => rpc_error(request.id, -32003, "forbidden"),
        }
    }

    /// Answer the SEC-1 server-identity probe. Requires a 64-lowercase-hex `challenge` and
    /// returns `proof = HMAC-SHA256(key = control_token, "tronhawk-server-proof-v1:" +
    /// challenge)` as lowercase hex. The response never contains the control token itself.
    fn server_proof(&self, request: tronhawk_ipc::Request) -> tronhawk_ipc::Response {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Params {
            challenge: String,
        }
        let params: Params = match parse_params(request.params) {
            Ok(params) => params,
            Err(_) => return rpc_error(request.id, -32602, "invalid params"),
        };
        if params.challenge.len() != 64 || !is_lowercase_hex(&params.challenge) {
            return rpc_error(request.id, -32602, "invalid params");
        }
        let proof = tronhawk_ipc::compute_server_proof(&self.control_token, &params.challenge);
        rpc_ok(request.id, serde_json::json!({ "proof": proof }))
    }

    fn handle_control(
        &self,
        request: tronhawk_ipc::Request,
        inner: &mut ServiceInner,
    ) -> tronhawk_ipc::Response {
        let result = match request.method.as_str() {
            "registerApplication" => self.register_application(inner, request.params),
            "getManagerSnapshot" => {
                if is_empty_params(&request.params) {
                    self.manager_snapshot(&inner.state)
                } else {
                    Err(RouterError::InvalidParams("expected empty params".into()))
                }
            }
            "installPlugin" => self.install_plugin(inner, request.params),
            "setApplicationPluginPolicy" => self.set_policy(inner, request.params),
            "removePlugin" => self.remove_plugin(inner, request.params),
            "createLaunchSession" => self.create_launch_session(inner, request.params),
            "queryLogs" => self.query_logs(request.params),
            "appendRuntimeLogs" | "appendPluginLogs" => {
                return rpc_error(request.id, -32003, "forbidden")
            }
            "getExecutionPlan" => return rpc_error(request.id, -32003, "forbidden"),
            _ => return rpc_error(request.id, -32601, "method not found"),
        };
        match result {
            Ok(value) => tronhawk_ipc::Response::ok(request.id, value),
            Err(RouterError::InvalidParams(message)) => rpc_error(request.id, -32602, message),
            Err(RouterError::Internal(_)) => rpc_error(request.id, -32603, "internal error"),
        }
    }

    fn query_logs(&self, params: serde_json::Value) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: Option<String>,
            stream: Option<LogStream>,
            before_sequence: Option<u64>,
            limit: usize,
        }
        let params: Params = parse_params(params)?;
        if !(1..=20).contains(&params.limit) {
            return Err(RouterError::InvalidParams(
                "limit must be between 1 and 20".into(),
            ));
        }
        let events = self
            .logs
            .lock()
            .map_err(|_| RouterError::Internal("log store lock poisoned".into()))?
            .query(LogQuery {
                application_id: params.application_id.as_deref(),
                stream: params.stream,
                before_sequence: params.before_sequence,
                limit: params.limit,
            })
            .map_err(RouterError::Internal)?;
        let next_before_sequence = events.last().map(|event| event.sequence);
        Ok(serde_json::json!({
            "events": events,
            "nextBeforeSequence": next_before_sequence,
        }))
    }

    fn append_runtime_logs(
        &self,
        request: tronhawk_ipc::Request,
        inner: &mut ServiceInner,
        application_id: &str,
    ) -> tronhawk_ipc::Response {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Event {
            level: LogLevel,
            message: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Params {
            events: Vec<Event>,
        }
        let params: Params = match parse_params(request.params) {
            Ok(params) => params,
            Err(_) => return rpc_error(request.id, -32602, "invalid params"),
        };
        if !valid_log_batch(
            &params
                .events
                .iter()
                .map(|event| event.message.as_str())
                .collect::<Vec<_>>(),
        ) {
            return rpc_error(request.id, -32602, "invalid params");
        }
        if !session_rate_available(inner.sessions.get_mut(&request.secret), params.events.len()) {
            return rpc_error(request.id, -32004, "log rate limit exceeded");
        }
        let mut logs = match self.logs.lock() {
            Ok(logs) => logs,
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };
        for event in &params.events {
            if logs
                .append(NewLogRecord {
                    stream: LogStream::Runtime,
                    level: event.level,
                    code: "runtime.message",
                    application_id,
                    plugin_id: None,
                    message: &event.message,
                })
                .is_err()
            {
                return rpc_error(request.id, -32603, "internal error");
            }
        }
        commit_session_log_ingest(inner.sessions.get_mut(&request.secret), params.events.len());
        rpc_ok(
            request.id,
            serde_json::json!({ "accepted": params.events.len() }),
        )
    }

    fn append_plugin_logs(
        &self,
        request: tronhawk_ipc::Request,
        inner: &mut ServiceInner,
        application_id: &str,
    ) -> tronhawk_ipc::Response {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Event {
            plugin_id: String,
            level: LogLevel,
            message: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Params {
            events: Vec<Event>,
        }
        let params: Params = match parse_params(request.params) {
            Ok(params) => params,
            Err(_) => return rpc_error(request.id, -32602, "invalid params"),
        };
        if !valid_log_batch(
            &params
                .events
                .iter()
                .map(|event| event.message.as_str())
                .collect::<Vec<_>>(),
        ) {
            return rpc_error(request.id, -32602, "invalid params");
        }
        let Some(session) = inner.sessions.get_mut(&request.secret) else {
            return rpc_error(request.id, -32001, "unauthorized");
        };
        if params
            .events
            .iter()
            .any(|event| !session.allowed_plan_plugins.contains(&event.plugin_id))
        {
            return rpc_error(
                request.id,
                -32003,
                "plugin was not in the last execution plan",
            );
        }
        if !session_rate_available(Some(session), params.events.len()) {
            return rpc_error(request.id, -32004, "log rate limit exceeded");
        }
        let mut logs = match self.logs.lock() {
            Ok(logs) => logs,
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };
        for event in &params.events {
            if logs
                .append(NewLogRecord {
                    stream: LogStream::Plugin,
                    level: event.level,
                    code: "plugin.message",
                    application_id,
                    plugin_id: Some(&event.plugin_id),
                    message: &event.message,
                })
                .is_err()
            {
                return rpc_error(request.id, -32603, "internal error");
            }
        }
        commit_session_log_ingest(inner.sessions.get_mut(&request.secret), params.events.len());
        rpc_ok(
            request.id,
            serde_json::json!({ "accepted": params.events.len() }),
        )
    }

    fn register_application(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            executable_path: String,
            support_level: u8,
        }
        let params: Params = parse_params(params)?;
        validate_support_level(params.support_level)?;
        let canonical = canonical_executable(&params.executable_path)?;
        let application_id = application_id_for_canonical_path(&canonical.path);

        let mut next = inner.state.clone();
        let existing_plugins = next
            .applications
            .get(&application_id)
            .map(|application| {
                if application.support_level == params.support_level {
                    application.plugins.clone()
                } else {
                    application
                        .plugins
                        .keys()
                        .map(|plugin_id| (plugin_id.clone(), PluginPolicy::default()))
                        .collect()
                }
            })
            .unwrap_or_default();
        let application = ApplicationState {
            executable_path: canonical.path,
            display_name: canonical.display_name,
            support_level: params.support_level,
            plugins: existing_plugins,
        };
        next.applications
            .insert(application_id.clone(), application.clone());
        write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
        inner.state = next;
        self.append_core_event(
            &application_id,
            None,
            "core.application.registered",
            "Application registered",
        );
        Ok(serde_json::json!({
            "applicationId": application_id,
            "executablePath": application.executable_path,
            "displayName": application.display_name,
            "supportLevel": application.support_level,
        }))
    }

    fn create_launch_session(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            executable_path: String,
        }
        let params: Params = parse_params(params)?;
        let canonical = canonical_executable(&params.executable_path)?;
        let application_id = application_id_for_canonical_path(&canonical.path);
        let token = random_token()?;
        inner.sessions.insert(
            token.clone(),
            LaunchSession {
                application_id: application_id.clone(),
                last_used: Instant::now(),
                allowed_plan_plugins: HashSet::new(),
                log_events: VecDeque::new(),
            },
        );
        self.append_core_event(
            &application_id,
            None,
            "core.launch_session.created",
            "Launch session created",
        );
        Ok(serde_json::json!({
            "token": token,
            "applicationId": application_id,
            "expiresAfterIdleSeconds": SESSION_IDLE_TIMEOUT.as_secs(),
        }))
    }

    fn set_policy(&self, inner: &mut ServiceInner, params: serde_json::Value) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: String,
            plugin_id: String,
            enabled: bool,
            grants: Vec<String>,
        }
        let params: Params = parse_params(params)?;
        let application = inner
            .state
            .applications
            .get(&params.application_id)
            .ok_or_else(|| RouterError::InvalidParams("application not found".into()))?;
        if params.enabled && application.support_level == 0 {
            return Err(RouterError::InvalidParams(
                "Level 0 applications cannot enable plugins".into(),
            ));
        }
        let plugin = self
            .installed_plugins()?
            .into_iter()
            .find(|plugin| plugin.id == params.plugin_id)
            .ok_or_else(|| RouterError::InvalidParams("plugin not found".into()))?;
        let mut seen = HashSet::new();
        if params.grants.iter().any(|grant| !seen.insert(grant)) {
            return Err(RouterError::InvalidParams(
                "grants must not contain duplicates".into(),
            ));
        }
        if params
            .grants
            .iter()
            .any(|grant| !plugin.permissions.contains(grant))
        {
            return Err(RouterError::InvalidParams(
                "grants must be requested by the plugin".into(),
            ));
        }
        let supported = capabilities_for_support_level(application.support_level);
        if params
            .grants
            .iter()
            .any(|grant| !supported.contains(&grant.as_str()))
        {
            return Err(RouterError::InvalidParams(
                "grants are unavailable at the application's support level".into(),
            ));
        }

        let policy = PluginPolicy {
            enabled: params.enabled,
            grants: params.grants,
        };
        let mut next = inner.state.clone();
        next.applications
            .get_mut(&params.application_id)
            .expect("application checked above")
            .plugins
            .insert(params.plugin_id.clone(), policy.clone());
        write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
        inner.state = next;
        self.append_core_event(
            &params.application_id,
            Some(&params.plugin_id),
            "core.policy.updated",
            "Application plugin policy updated",
        );
        serde_json::to_value(policy).map_err(|e| RouterError::Internal(e.to_string()))
    }

    fn install_plugin(&self, inner: &mut ServiceInner, params: serde_json::Value) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Params {
            path: String,
        }
        let params: Params = parse_params(params)?;
        let package_path = Path::new(&params.path);
        let staging = self
            .installed_root
            .join(format!(".staging-{}", random_token()?));
        let plugin = tronhawk_package::extract(package_path, &staging).map_err(|error| {
            let _ = std::fs::remove_dir_all(&staging);
            RouterError::InvalidParams(error)
        })?;
        self.commit_staged_plugin(inner, &plugin, &staging, false)?;
        self.append_core_event(
            "global",
            Some(&plugin.id),
            "core.plugin.installed",
            "Plugin installed",
        );
        plugin_metadata_value(&plugin)
    }

    fn commit_staged_plugin(
        &self,
        inner: &mut ServiceInner,
        plugin: &Plugin,
        staging: &Path,
        fail_before_publish: bool,
    ) -> Result<(), RouterError> {
        let mut next = inner.state.clone();
        for application in next.applications.values_mut() {
            application
                .plugins
                .insert(plugin.id.clone(), PluginPolicy::default());
        }
        write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
        inner.state = next;

        if fail_before_publish {
            remove_directory(staging, "discard staged plugin after publish failure")?;
            return Err(RouterError::Internal(
                "simulated plugin publish failure".into(),
            ));
        }

        let final_dir = self.installed_root.join(&plugin.id);
        let backup = transaction_dir(&self.installed_root, "backup", &plugin.id);
        if final_dir.exists() {
            if let Err(error) = std::fs::rename(&final_dir, &backup) {
                let cleanup = remove_directory(staging, "discard staged plugin");
                return Err(merge_recovery_error(
                    format!("backup plugin: {error}"),
                    cleanup,
                ));
            }
        }
        if let Err(error) = std::fs::rename(staging, &final_dir) {
            let restore = if backup.exists() {
                std::fs::rename(&backup, &final_dir)
                    .map_err(|restore| format!("restore prior plugin: {restore}"))
            } else {
                Ok(())
            };
            let cleanup = remove_directory(staging, "discard staged plugin")
                .map_err(|error| internal_message(error));
            let mut message = format!("publish plugin: {error}");
            if let Err(restore) = restore {
                message.push_str(&format!("; {restore}"));
            }
            if let Err(cleanup) = cleanup {
                message.push_str(&format!("; {cleanup}"));
            }
            return Err(RouterError::Internal(message));
        }
        if backup.exists() {
            remove_directory(&backup, "remove prior plugin backup")?;
        }
        Ok(())
    }

    fn remove_plugin(&self, inner: &mut ServiceInner, params: serde_json::Value) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            plugin_id: String,
        }
        let params: Params = parse_params(params)?;
        let plugin = self
            .installed_plugins()?
            .into_iter()
            .find(|plugin| plugin.id == params.plugin_id)
            .ok_or_else(|| RouterError::InvalidParams("plugin not found".into()))?;
        let final_dir = self.installed_root.join(&plugin.id);
        let trash = transaction_dir(&self.installed_root, "remove", &plugin.id);
        std::fs::rename(&final_dir, &trash)
            .map_err(|e| RouterError::Internal(format!("stage plugin removal: {e}")))?;
        let mut next = inner.state.clone();
        for application in next.applications.values_mut() {
            application.plugins.remove(&plugin.id);
        }
        if let Err(error) = write_state(&self.state_path, &next) {
            let _ = std::fs::rename(&trash, &final_dir);
            return Err(RouterError::Internal(error));
        }
        inner.state = next;
        let _ = std::fs::remove_dir_all(trash);
        self.append_core_event(
            "global",
            Some(&plugin.id),
            "core.plugin.removed",
            "Plugin removed",
        );
        plugin_metadata_value(&plugin)
    }

    fn append_core_event(
        &self,
        application_id: &str,
        plugin_id: Option<&str>,
        code: &'static str,
        message: &'static str,
    ) {
        if let Ok(mut logs) = self.logs.lock() {
            let _ = logs.append(NewLogRecord {
                stream: LogStream::Core,
                level: LogLevel::Info,
                code,
                application_id,
                plugin_id,
                message,
            });
        }
    }

    fn installed_plugins(&self) -> Result<Vec<Plugin>, RouterError> {
        let mut plugins = Vec::new();
        for entry in std::fs::read_dir(&self.installed_root)
            .map_err(|e| RouterError::Internal(format!("scan installed plugins: {e}")))?
        {
            let entry = entry.map_err(|e| RouterError::Internal(e.to_string()))?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            let plugin = crate::load_plugin_dir(&entry.path()).map_err(RouterError::Internal)?;
            if name.to_string_lossy() != plugin.id {
                return Err(RouterError::Internal(
                    "installed plugin directory does not match its id".into(),
                ));
            }
            plugins.push(plugin);
        }
        plugins.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(plugins)
    }

    fn manager_snapshot(&self, state: &DaemonState) -> RouterResult {
        let plugins = self
            .installed_plugins()?
            .iter()
            .map(plugin_metadata_value)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(serde_json::json!({
            "global": { "developerMode": state.global.developer_mode },
            "applications": state.applications,
            "plugins": plugins,
        }))
    }

    fn execution_plan(
        &self,
        state: &DaemonState,
        application_id: &str,
    ) -> Result<ExecutionPlan, RouterError> {
        let Some(application) = state.applications.get(application_id) else {
            return Ok(empty_plan());
        };
        if application.support_level == 0 {
            return Ok(empty_plan());
        }
        let supported = capabilities_for_support_level(application.support_level);
        let mut grants = Vec::new();
        for mut plugin in self.installed_plugins()? {
            let Some(policy) = application.plugins.get(&plugin.id) else {
                continue;
            };
            if !policy.enabled {
                continue;
            }
            let effective: Vec<String> = policy
                .grants
                .iter()
                .filter(|grant| {
                    plugin.permissions.contains(grant)
                        && supported.contains(&grant.as_str())
                        && grant.as_str() != "runtime.unsafe"
                })
                .cloned()
                .collect();
            if effective.is_empty() {
                continue;
            }
            plugin.permissions = effective;
            if !plugin
                .permissions
                .iter()
                .any(|grant| grant == "renderer.css")
            {
                plugin.css = None;
            }
            if !plugin
                .permissions
                .iter()
                .any(|grant| grant == "renderer.script")
            {
                plugin.renderer = None;
            }
            if !plugin
                .permissions
                .iter()
                .any(|grant| grant == "electron.window")
            {
                plugin.main = None;
            }
            grants.push(plugin_grant(plugin));
        }
        Ok(ExecutionPlan {
            revision: hash_json(&grants),
            plugins: grants,
        })
    }
}

#[derive(Debug)]
enum RouterError {
    InvalidParams(String),
    Internal(String),
}

type RouterResult = Result<serde_json::Value, RouterError>;

fn parse_params<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, RouterError> {
    serde_json::from_value(value).map_err(|e| RouterError::InvalidParams(e.to_string()))
}

fn valid_log_batch(messages: &[&str]) -> bool {
    !messages.is_empty()
        && messages.len() <= 16
        && messages
            .iter()
            .all(|message| message.as_bytes().len() <= 1024)
}

fn session_rate_available(session: Option<&mut LaunchSession>, count: usize) -> bool {
    let Some(session) = session else { return false };
    let cutoff = Instant::now() - Duration::from_secs(60);
    while session
        .log_events
        .front()
        .is_some_and(|time| *time <= cutoff)
    {
        session.log_events.pop_front();
    }
    session.log_events.len() + count <= 120
}

fn commit_session_log_ingest(session: Option<&mut LaunchSession>, count: usize) {
    if let Some(session) = session {
        let now = Instant::now();
        session
            .log_events
            .extend(std::iter::repeat(now).take(count));
        session.last_used = now;
    }
}

fn validate_support_level(level: u8) -> Result<(), RouterError> {
    if level <= 2 {
        Ok(())
    } else {
        Err(RouterError::InvalidParams(
            "supportLevel must be 0, 1, or 2".into(),
        ))
    }
}

fn capabilities_for_support_level(level: u8) -> &'static [&'static str] {
    match level {
        1 => IMPLEMENTED_RENDERER_CAPABILITIES,
        2 => IMPLEMENTED_LEVEL_TWO_CAPABILITIES,
        _ => &[],
    }
}

/// Create `config_root` and verify it is a real directory that is not a symlink/reparse
/// point, mirroring the log directory hardening. `create_dir_all` alone follows symlinks, so
/// a pre-planted symlink at the config path would otherwise redirect state/token writes.
fn create_config_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("create config root: {e}"))?;
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("inspect config root: {e}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("config root must be a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("secure config root: {e}"))?;
        }
    }
    #[cfg(windows)]
    reject_reparse(&metadata, "config root")?;
    Ok(())
}

/// Best-effort removal of orphaned transaction/backup/staging directories under the installed
/// plugins root. A crash mid-install or mid-remove leaves hidden `.staging-*`, `.backup-*`,
/// `.remove-*`, or `.tronhawk-*` directories behind; removing them keeps a crashed install
/// from leaving permanent debris. Errors are ignored and non-transaction entries (including
/// installed plugin directories) are never touched: only directory names that start with the
/// documented dot-prefixed transaction patterns qualify.
fn sweep_orphaned_transaction_dirs(root: &Path) {
    const TRANSACTION_PREFIXES: [&str; 4] = [".staging-", ".backup-", ".remove-", ".tronhawk-"];
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if TRANSACTION_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(windows)]
fn reject_reparse(metadata: &std::fs::Metadata, name: &str) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!("{name} must not be a reparse point"));
    }
    Ok(())
}

fn remove_directory(path: &Path, operation: &str) -> Result<(), RouterError> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(path)
        .map_err(|error| RouterError::Internal(format!("{operation}: {error}")))
}

fn internal_message(error: RouterError) -> String {
    match error {
        RouterError::Internal(message) | RouterError::InvalidParams(message) => message,
    }
}

fn merge_recovery_error(primary: String, recovery: Result<(), RouterError>) -> RouterError {
    match recovery {
        Ok(()) => RouterError::Internal(primary),
        Err(error) => RouterError::Internal(format!("{primary}; {}", internal_message(error))),
    }
}

struct CanonicalExecutable {
    path: String,
    display_name: String,
}

fn canonical_executable(path: &str) -> Result<CanonicalExecutable, RouterError> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|e| RouterError::InvalidParams(format!("canonicalize executable: {e}")))?;
    if !canonical.is_file() {
        return Err(RouterError::InvalidParams(
            "executable path must name a file".into(),
        ));
    }
    let display_name = canonical
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| RouterError::InvalidParams("executable path has no file name".into()))?
        .to_string();
    let normalized = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();
    Ok(CanonicalExecutable {
        path: normalized,
        display_name,
    })
}

pub fn application_id_for_executable(path: &Path) -> Result<String, String> {
    let canonical = canonical_executable(&path.to_string_lossy()).map_err(|error| match error {
        RouterError::InvalidParams(message) | RouterError::Internal(message) => message,
    })?;
    Ok(application_id_for_canonical_path(&canonical.path))
}

fn application_id_for_canonical_path(canonical: &str) -> String {
    let digest = Sha256::digest(canonical.as_bytes());
    format!("winexe-v1:{}", hex(&digest))
}

fn random_token() -> Result<String, RouterError> {
    let mut bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| RouterError::Internal(format!("secure random token: {e}")))?;
    Ok(hex(&bytes))
}

fn read_or_create_control_token(path: &Path) -> Result<String, String> {
    let token = random_token().map_err(|error| match error {
        RouterError::Internal(message) | RouterError::InvalidParams(message) => message,
    })?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(token.as_bytes())
                .map_err(|e| format!("write control token: {e}"))?;
            file.sync_all()
                .map_err(|e| format!("sync control token: {e}"))?;
            Ok(token)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_existing_control_token(path)
        }
        Err(error) => Err(format!("create control token: {error}")),
    }
}

fn read_existing_control_token(path: &Path) -> Result<String, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("open control token safely: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("inspect control token: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err("control token must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return Err("control token permissions must be owner-only".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("control token must not be a reparse point".into());
        }
    }
    use std::io::Read;
    let mut token = String::new();
    file.read_to_string(&mut token)
        .map_err(|e| format!("read control token: {e}"))?;
    let token = token.trim().to_string();
    if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(token)
    } else {
        Err("invalid control token".into())
    }
}

fn read_state(path: &Path) -> Result<(DaemonState, bool), String> {
    if !path.exists() {
        // A crash under the previous two-rename scheme could leave the last committed state
        // only in an orphaned `.tronhawk-daemon-state-backup-*` file. Restore it instead of
        // silently resetting to defaults; `state_needs_write` makes the caller rewrite the
        // canonical path, which also clears the leftover artifact.
        if let Some(backup) = newest_state_backup(path) {
            if let Ok(contents) = std::fs::read(&backup) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&contents) {
                    if let Some(state) = parse_state_value(value).ok() {
                        return Ok((state, true));
                    }
                }
            }
        }
        return Ok((DaemonState::default(), true));
    }
    let value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(path).map_err(|e| format!("read daemon state: {e}"))?,
    )
    .map_err(|e| format!("invalid daemon state: {e}"))?;
    if value.get("schemaVersion").is_none() || value.get("enabled").is_some() {
        return Ok((DaemonState::default(), true));
    }
    let state = parse_state_value(value)?;
    Ok((state, false))
}

fn parse_state_value(value: serde_json::Value) -> Result<DaemonState, String> {
    let state: DaemonState =
        serde_json::from_value(value).map_err(|e| format!("invalid daemon state: {e}"))?;
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported daemon state schema version: {}",
            state.schema_version
        ));
    }
    Ok(state)
}

/// Newest orphaned `.tronhawk-daemon-state-backup-*` file next to `state_path`, if any.
fn newest_state_backup(state_path: &Path) -> Option<PathBuf> {
    let parent = state_path.parent()?;
    const PREFIX: &str = ".tronhawk-daemon-state-backup-";
    std::fs::read_dir(parent)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(PREFIX) {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// Best-effort removal of leftover `.tronhawk-daemon-state-*` transaction artifacts produced by
/// interrupted writes (including the backups of the pre-atomic scheme). Errors are ignored.
fn remove_stale_state_artifacts(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".tronhawk-daemon-state-") && entry.path().is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_state(path: &Path, state: &DaemonState) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| format!("create state directory: {e}"))?;
    let temp = transaction_file(parent, "daemon-state");
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| format!("serialize state: {e}"))?;
    let mut file = std::fs::File::create(&temp).map_err(|e| format!("create state: {e}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|e| format!("write state: {e}"))?;
    file.sync_all().map_err(|e| format!("sync state: {e}"))?;
    drop(file);

    // Atomic replace-on-write: `std::fs::rename` is a same-volume replace of the destination
    // (rename(2) on Unix, MoveFileExW with REPLACE_EXISTING on Windows), so there is never a
    // moment without `state.json`: a crash leaves either the old or the new file in place.
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("commit state: {error}"));
    }
    remove_stale_state_artifacts(parent);
    Ok(())
}

fn plugin_metadata_value(plugin: &Plugin) -> RouterResult {
    Ok(serde_json::json!({
        "id": plugin.id,
        "name": plugin.name,
        "version": plugin.version,
        "author": plugin.author,
        "tronhawk": plugin.tronhawk,
        "requestedPermissions": plugin.permissions,
    }))
}

fn empty_plan() -> ExecutionPlan {
    let plugins: Vec<crate::PluginGrant> = Vec::new();
    ExecutionPlan {
        revision: hash_json(&plugins),
        plugins,
    }
}

fn rpc_ok<T: Serialize>(id: u64, value: T) -> tronhawk_ipc::Response {
    match serde_json::to_value(value) {
        Ok(value) => tronhawk_ipc::Response::ok(id, value),
        Err(_) => rpc_error(id, -32603, "internal error"),
    }
}

fn rpc_error(id: u64, code: i32, message: impl Into<String>) -> tronhawk_ipc::Response {
    tronhawk_ipc::Response::err(id, code, message)
}

fn is_empty_params(params: &serde_json::Value) -> bool {
    params.is_null() || params.as_object().is_some_and(serde_json::Map::is_empty)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn is_lowercase_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

pub fn serve_service(port: u16, service: std::sync::Arc<CoreService>) -> std::io::Result<()> {
    tronhawk_ipc::serve(port, move |request| service.handle_request(request))
}

pub fn default_storage_root() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("TronHawk");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("TronHawk");
    }
    std::env::temp_dir().join("TronHawk")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tronhawk_ipc::{Request, ResponseResult, PROTOCOL_VERSION};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "tronhawk-daemon-{name}-{}-{}",
                std::process::id(),
                random_token().unwrap()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn executable(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, b"fixture").unwrap();
            path
        }

        fn package(&self, directory: &str, id: &str, version: &str) -> PathBuf {
            let source = self.0.join(directory);
            std::fs::create_dir_all(&source).unwrap();
            std::fs::write(source.join("renderer.js"), "renderer source").unwrap();
            std::fs::write(source.join("main.js"), "main source").unwrap();
            let manifest = serde_json::json!({
                "id": id,
                "name": "Daemon test plugin",
                "version": version,
                "author": "Test",
                "tronhawk": "^0.1",
                "permissions": [
                    "renderer.css",
                    "renderer.script",
                    "renderer.dom",
                    "electron.window",
                    "runtime.unsafe"
                ],
                "css": "body{}",
                "entry": {
                    "renderer": "renderer.js",
                    "main": "main.js"
                }
            });
            std::fs::write(
                source.join("manifest.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            let package = self.0.join(format!("{directory}.thx"));
            tronhawk_package::pack(&source, &package).unwrap();
            package
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn service(temp: &TempRoot) -> (CoreService, String) {
        let service = CoreService::new(&temp.0).unwrap();
        let token = std::fs::read_to_string(service.control_token_path()).unwrap();
        (service, token)
    }

    fn call(
        service: &CoreService,
        secret: &str,
        method: &str,
        params: serde_json::Value,
    ) -> tronhawk_ipc::Response {
        service.handle_request(Request {
            version: PROTOCOL_VERSION.into(),
            id: 1,
            method: method.into(),
            params,
            secret: secret.into(),
        })
    }

    fn ok(response: tronhawk_ipc::Response) -> serde_json::Value {
        match response.result {
            ResponseResult::Ok { result } => result,
            ResponseResult::Err { error } => panic!("unexpected RPC error: {error:?}"),
        }
    }

    fn error_code(response: tronhawk_ipc::Response) -> i32 {
        match response.result {
            ResponseResult::Err { error } => error.code,
            ResponseResult::Ok { result } => panic!("unexpected RPC result: {result}"),
        }
    }

    fn register(
        service: &CoreService,
        control: &str,
        executable: &Path,
        support_level: u8,
    ) -> String {
        ok(call(
            service,
            control,
            "registerApplication",
            serde_json::json!({
                "executablePath": executable,
                "supportLevel": support_level,
            }),
        ))["applicationId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn install_package(service: &CoreService, control: &str, package: &Path) {
        ok(call(
            service,
            control,
            "installPlugin",
            serde_json::json!({ "path": package }),
        ));
    }

    fn set_policy(
        service: &CoreService,
        control: &str,
        application_id: &str,
        enabled: bool,
        grants: &[&str],
    ) -> tronhawk_ipc::Response {
        call(
            service,
            control,
            "setApplicationPluginPolicy",
            serde_json::json!({
                "applicationId": application_id,
                "pluginId": "com.example.daemon",
                "enabled": enabled,
                "grants": grants,
            }),
        )
    }

    fn launch_token(service: &CoreService, control: &str, executable: &Path) -> String {
        ok(call(
            service,
            control,
            "createLaunchSession",
            serde_json::json!({ "executablePath": executable }),
        ))["token"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn plan(service: &CoreService, launch_token: &str) -> serde_json::Value {
        ok(call(
            service,
            launch_token,
            "getExecutionPlan",
            serde_json::json!({}),
        ))
    }

    fn query_logs(service: &CoreService, control: &str) -> serde_json::Value {
        ok(call(
            service,
            control,
            "queryLogs",
            serde_json::json!({ "limit": 20 }),
        ))
    }

    #[test]
    fn logging_rpc_auth_matrix_and_runtime_attribution() {
        let temp = TempRoot::new("log-auth");
        let app = temp.executable("Auth.exe");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &app, 2);
        let token = launch_token(&service, &control, &app);

        assert_eq!(
            error_code(call(
                &service,
                &control,
                "appendRuntimeLogs",
                serde_json::json!({ "events": [{ "level": "info", "message": "no" }] }),
            )),
            -32003
        );
        assert_eq!(
            error_code(call(
                &service,
                &token,
                "queryLogs",
                serde_json::json!({ "limit": 20 }),
            )),
            -32003
        );
        assert_eq!(
            ok(call(
                &service,
                &token,
                "appendRuntimeLogs",
                serde_json::json!({ "events": [{ "level": "warn", "message": "runtime event" }] }),
            ))["accepted"],
            1
        );
        let logs = query_logs(&service, &control);
        let runtime = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["stream"] == "runtime")
            .unwrap();
        assert_eq!(runtime["applicationId"], application_id);
        assert_eq!(runtime["code"], "runtime.message");
        assert!(runtime.get("path").is_none());
        assert!(runtime.get("source").is_none());
        assert!(runtime.get("secret").is_none());
    }

    #[test]
    fn plugin_logs_require_the_most_recent_successful_plan() {
        let temp = TempRoot::new("plugin-log-plan");
        let app = temp.executable("Plan.exe");
        let package = temp.package("log-plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &app, 2);
        install_package(&service, &control, &package);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        let token = launch_token(&service, &control, &app);
        let params = serde_json::json!({
            "events": [{
                "pluginId": "com.example.daemon",
                "level": "error",
                "message": "plugin event"
            }]
        });
        assert_eq!(
            error_code(call(&service, &token, "appendPluginLogs", params.clone())),
            -32003
        );
        plan(&service, &token);
        assert_eq!(
            ok(call(&service, &token, "appendPluginLogs", params))["accepted"],
            1
        );
        let logs = query_logs(&service, &control);
        let plugin = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["stream"] == "plugin")
            .unwrap();
        assert_eq!(plugin["applicationId"], application_id);
        assert_eq!(plugin["pluginId"], "com.example.daemon");
        assert_eq!(plugin["code"], "plugin.message");
    }

    #[test]
    fn log_batches_are_strict_bounded_and_rate_limited() {
        let temp = TempRoot::new("log-bounds");
        let app = temp.executable("Bounds.exe");
        let (service, control) = service(&temp);
        register(&service, &control, &app, 2);
        let token = launch_token(&service, &control, &app);

        for invalid in [
            serde_json::json!({ "events": [] }),
            serde_json::json!({ "events": [{ "level": "debug", "message": "bad" }] }),
            serde_json::json!({ "events": [{ "level": "info", "message": "bad", "extra": true }] }),
            serde_json::json!({ "events": [{ "level": "info", "message": "x".repeat(1025) }] }),
            serde_json::json!({ "events": (0..17).map(|_| serde_json::json!({ "level": "info", "message": "many" })).collect::<Vec<_>>() }),
        ] {
            assert_eq!(
                error_code(call(&service, &token, "appendRuntimeLogs", invalid)),
                -32602
            );
        }

        let sixteen = serde_json::json!({
            "events": (0..16).map(|_| serde_json::json!({ "level": "info", "message": "event" })).collect::<Vec<_>>()
        });
        for _ in 0..7 {
            ok(call(&service, &token, "appendRuntimeLogs", sixteen.clone()));
        }
        assert_eq!(
            error_code(call(
                &service,
                &token,
                "appendRuntimeLogs",
                serde_json::json!({ "events": (0..9).map(|_| serde_json::json!({ "level": "info", "message": "over rate" })).collect::<Vec<_>>() }),
            )),
            -32004
        );
    }

    #[test]
    fn core_log_failure_does_not_rollback_committed_registration() {
        let temp = TempRoot::new("log-failure");
        let app = temp.executable("Committed.exe");
        let (service, control) = service(&temp);
        std::fs::create_dir(temp.0.join("logs/events.jsonl")).unwrap();
        let application_id = register(&service, &control, &app, 2);
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert!(snapshot["applications"].get(application_id).is_some());
    }

    #[test]
    fn default_deny_and_session_identity_isolation() {
        let temp = TempRoot::new("identity");
        let app_one = temp.executable("One.exe");
        let app_two = temp.executable("Two.exe");
        let unknown = temp.executable("Unknown.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        assert_eq!(control.len(), 64);

        let app_one_id = register(&service, &control, &app_one, 2);
        let app_two_id = register(&service, &control, &app_two, 2);
        assert_ne!(app_one_id, app_two_id);
        install_package(&service, &control, &package);

        let one_token = launch_token(&service, &control, &app_one);
        assert!(plan(&service, &one_token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
        ok(set_policy(
            &service,
            &control,
            &app_one_id,
            true,
            &["renderer.css"],
        ));
        ok(set_policy(
            &service,
            &control,
            &app_two_id,
            true,
            &["renderer.script"],
        ));

        let two_token = launch_token(&service, &control, &app_two);
        assert_eq!(
            plan(&service, &one_token)["plugins"][0]["granted"][0],
            "renderer.css"
        );
        assert_eq!(
            plan(&service, &two_token)["plugins"][0]["granted"][0],
            "renderer.script"
        );
        assert_eq!(
            error_code(call(
                &service,
                &one_token,
                "getManagerSnapshot",
                serde_json::json!({}),
            )),
            -32003
        );
        let unknown_token = launch_token(&service, &control, &unknown);
        assert!(plan(&service, &unknown_token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            error_code(call(
                &service,
                "bad-token",
                "getManagerSnapshot",
                serde_json::json!({}),
            )),
            -32001
        );
        assert!(ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ))["applications"]
            .get(&app_one_id)
            .is_some());
    }

    #[test]
    fn invalid_grants_leave_persisted_policy_unchanged() {
        let temp = TempRoot::new("invalid-grants");
        let executable = temp.executable("App.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        let before = std::fs::read(temp.0.join("config/state.json")).unwrap();

        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["renderer.css", "renderer.css"],
            )),
            -32602
        );
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["network.access"],
            )),
            -32602
        );
        assert_eq!(
            before,
            std::fs::read(temp.0.join("config/state.json")).unwrap()
        );
    }

    #[test]
    fn state_and_policies_persist_across_service_reconstruction() {
        let temp = TempRoot::new("persistence");
        let executable = temp.executable("Persistent.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        drop(service);

        let reconstructed = CoreService::new(&temp.0).unwrap();
        let persisted_control =
            std::fs::read_to_string(reconstructed.control_token_path()).unwrap();
        let token = launch_token(&reconstructed, &persisted_control, &executable);
        assert_eq!(
            plan(&reconstructed, &token)["plugins"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(state["schemaVersion"], 1);
        assert_eq!(state["global"]["developerMode"], false);
    }

    #[test]
    fn install_and_update_reset_every_application_policy() {
        let temp = TempRoot::new("update-reset");
        let executable = temp.executable("App.exe");
        let first = temp.package("plugin-one", "com.example.daemon", "1.0.0");
        let update = temp.package("plugin-two", "com.example.daemon", "2.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &first);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        install_package(&service, &control, &update);

        let token = launch_token(&service, &control, &executable);
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        let policy = &snapshot["applications"][&application_id]["plugins"]["com.example.daemon"];
        assert_eq!(policy["enabled"], false);
        assert!(policy["grants"].as_array().unwrap().is_empty());
    }

    #[test]
    fn failed_update_publish_cannot_retain_enabled_policy() {
        let temp = TempRoot::new("update-publish-failure");
        let executable = temp.executable("App.exe");
        let first = temp.package("plugin-one", "com.example.daemon", "1.0.0");
        let update = temp.package("plugin-two", "com.example.daemon", "2.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &first);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        let token = launch_token(&service, &control, &executable);
        assert_eq!(plan(&service, &token)["plugins"][0]["version"], "1.0.0");

        let staging = service.installed_root.join(".staging-failure-test");
        let plugin = tronhawk_package::extract(&update, &staging).unwrap();
        let result = {
            let mut inner = service.inner.lock().unwrap();
            service.commit_staged_plugin(&mut inner, &plugin, &staging, true)
        };
        assert!(result.is_err());
        assert!(!staging.exists());
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(service.installed_plugins().unwrap()[0].version, "1.0.0");
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        let policy = &persisted["applications"][&application_id]["plugins"]["com.example.daemon"];
        assert_eq!(policy["enabled"], false);
        assert!(policy["grants"].as_array().unwrap().is_empty());
    }

    #[test]
    fn support_levels_filter_payloads_and_unsafe_capability() {
        let temp = TempRoot::new("levels");
        let level_zero = temp.executable("Zero.exe");
        let level_one = temp.executable("One.exe");
        let level_two = temp.executable("Two.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let zero_id = register(&service, &control, &level_zero, 0);
        let one_id = register(&service, &control, &level_one, 1);
        let two_id = register(&service, &control, &level_two, 2);
        install_package(&service, &control, &package);
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &zero_id,
                true,
                &["renderer.css"],
            )),
            -32602
        );
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &one_id,
                true,
                &["electron.window"],
            )),
            -32602
        );
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &one_id,
                true,
                &["renderer.dom"],
            )),
            -32602
        );
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &two_id,
                true,
                &["runtime.unsafe"],
            )),
            -32602
        );
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &two_id,
                true,
                &["renderer.dom"],
            )),
            -32602
        );
        ok(set_policy(
            &service,
            &control,
            &one_id,
            true,
            &["renderer.css"],
        ));
        ok(set_policy(
            &service,
            &control,
            &two_id,
            true,
            &["electron.window"],
        ));

        service
            .inner
            .lock()
            .unwrap()
            .state
            .applications
            .get_mut(&one_id)
            .unwrap()
            .plugins
            .insert(
                "com.example.daemon".into(),
                PluginPolicy {
                    enabled: true,
                    grants: vec!["renderer.css".into(), "renderer.dom".into()],
                },
            );

        let zero_plan = plan(&service, &launch_token(&service, &control, &level_zero));
        assert!(zero_plan["plugins"].as_array().unwrap().is_empty());
        let one_plan = plan(&service, &launch_token(&service, &control, &level_one));
        assert_eq!(
            one_plan["plugins"][0]["granted"],
            serde_json::json!(["renderer.css"])
        );
        assert!(one_plan["plugins"][0]["renderer"].is_null());
        assert!(one_plan["plugins"][0]["main"].is_null());
        let two_plan = plan(&service, &launch_token(&service, &control, &level_two));
        assert_eq!(
            two_plan["plugins"][0]["granted"],
            serde_json::json!(["electron.window"])
        );
        assert_eq!(two_plan["plugins"][0]["main"], "main source");
    }

    #[test]
    fn support_level_change_resets_policies_but_same_level_preserves_them() {
        let temp = TempRoot::new("level-transition");
        let executable = temp.executable("App.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 1);
        install_package(&service, &control, &package);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        let token = launch_token(&service, &control, &executable);

        register(&service, &control, &executable, 1);
        assert_eq!(
            plan(&service, &token)["plugins"].as_array().unwrap().len(),
            1
        );
        register(&service, &control, &executable, 2);
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        let policy = &snapshot["applications"][&application_id]["plugins"]["com.example.daemon"];
        assert_eq!(policy["enabled"], false);
        assert!(policy["grants"].as_array().unwrap().is_empty());

        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["electron.window"],
        ));
        register(&service, &control, &executable, 1);
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn manager_snapshot_omits_sources_and_tokens() {
        let temp = TempRoot::new("snapshot-redaction");
        let executable = temp.executable("App.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("renderer source"));
        assert!(!serialized.contains("main source"));
        assert!(!serialized.contains(&control));
        assert!(!serialized.contains("token"));
        assert!(snapshot["plugins"][0]["requestedPermissions"].is_array());
    }

    #[test]
    fn expired_launch_session_is_rejected() {
        let temp = TempRoot::new("session-expiry");
        let executable = temp.executable("App.exe");
        let (service, control) = service(&temp);
        register(&service, &control, &executable, 2);
        let launch = ok(call(
            &service,
            &control,
            "createLaunchSession",
            serde_json::json!({ "executablePath": executable }),
        ));
        let token = launch["token"].as_str().unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(launch["expiresAfterIdleSeconds"], 600);

        service
            .inner
            .lock()
            .unwrap()
            .sessions
            .get_mut(token)
            .unwrap()
            .last_used = Instant::now() - SESSION_IDLE_TIMEOUT - Duration::from_secs(1);
        assert_eq!(
            error_code(call(
                &service,
                token,
                "getExecutionPlan",
                serde_json::json!({}),
            )),
            -32001
        );
    }

    #[test]
    fn control_token_rejects_non_regular_file() {
        let temp = TempRoot::new("token-non-regular");
        let token_path = temp.0.join("config/control.token");
        std::fs::create_dir_all(&token_path).unwrap();
        assert!(CoreService::new(&temp.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn control_token_is_owner_only_and_rejects_unsafe_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let temp = TempRoot::new("token-permissions");
        let service = CoreService::new(&temp.0).unwrap();
        let token_path = service.control_token_path().to_path_buf();
        assert_eq!(
            std::fs::metadata(&token_path).unwrap().mode() & 0o777,
            0o600
        );
        drop(service);

        std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(CoreService::new(&temp.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn control_token_rejects_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let temp = TempRoot::new("token-symlink");
        let config = temp.0.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let target = temp.0.join("token-target");
        std::fs::write(&target, "0".repeat(64)).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, config.join("control.token")).unwrap();
        assert!(CoreService::new(&temp.0).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn control_token_rejects_file_symlink_when_supported() {
        use std::os::windows::fs::symlink_file;

        let temp = TempRoot::new("token-symlink");
        let config = temp.0.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let target = temp.0.join("token-target");
        std::fs::write(&target, "0".repeat(64)).unwrap();
        if symlink_file(&target, config.join("control.token")).is_ok() {
            assert!(CoreService::new(&temp.0).is_err());
        }
    }

    #[test]
    fn state_write_replaces_atomically_and_clears_legacy_artifacts() {
        let temp = TempRoot::new("atomic-state");
        let state_path = temp.0.join("config/state.json");
        let mut state = DaemonState::default();
        state.applications.insert(
            "winexe-v1:test".into(),
            ApplicationState {
                executable_path: "c:/apps/Test.exe".into(),
                display_name: "Test".into(),
                support_level: 2,
                plugins: BTreeMap::new(),
            },
        );
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();

        // Simulate debris left by the previous two-rename scheme: an orphaned backup plus an
        // interrupted temp file, and a state.json that already exists.
        std::fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
        std::fs::write(
            temp.0.join("config/.tronhawk-daemon-state-backup-1-1"),
            b"{}",
        )
        .unwrap();
        std::fs::write(temp.0.join("config/.tronhawk-daemon-state-1-2"), b"{}").unwrap();

        write_state(&state_path, &state).unwrap();

        // The committed state is intact and there is never a moment without `state.json`.
        assert!(state_path.exists());
        let persisted: DaemonState =
            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(persisted, state);
        let leftovers: Vec<String> = std::fs::read_dir(temp.0.join("config"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".tronhawk-daemon-state-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "leftover state artifacts: {leftovers:?}"
        );
    }

    #[test]
    fn orphaned_state_backup_is_restored_when_state_json_is_missing() {
        let temp = TempRoot::new("orphan-restore");
        let mut state = DaemonState::default();
        state.applications.insert(
            "winexe-v1:orphan".into(),
            ApplicationState {
                executable_path: "c:/apps/Orphan.exe".into(),
                display_name: "Orphan".into(),
                support_level: 2,
                plugins: BTreeMap::new(),
            },
        );
        let config = temp.0.join("config");
        std::fs::create_dir_all(&config).unwrap();
        // A crash under the old write scheme left only the backup behind, no `state.json`.
        let backup = config.join(".tronhawk-daemon-state-backup-1-1");
        std::fs::write(&backup, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
        assert!(!config.join("state.json").exists());

        let core = CoreService::new(&temp.0).unwrap();
        drop(core);

        let persisted: DaemonState =
            serde_json::from_slice(&std::fs::read(config.join("state.json")).unwrap()).unwrap();
        assert_eq!(
            persisted, state,
            "state must be restored, not reset to defaults"
        );
        assert!(!backup.exists(), "restored backup should be cleaned up");
    }

    #[test]
    fn startup_sweeps_orphaned_transaction_dirs_but_keeps_plugins() {
        let temp = TempRoot::new("sweep");
        let installed = temp.0.join("plugins").join("installed");
        std::fs::create_dir_all(&installed).unwrap();
        for name in [
            ".staging-crashed",
            ".backup-com.example.old-1-1",
            ".remove-com.example.gone-2-2",
            ".tronhawk-debris",
        ] {
            std::fs::create_dir(installed.join(name)).unwrap();
        }
        // Real content must never be touched.
        std::fs::create_dir(installed.join("com.example.real")).unwrap();
        std::fs::create_dir(installed.join(".cache-ish")).unwrap();
        std::fs::write(installed.join("notes.txt"), b"keep").unwrap();

        let core = CoreService::new(&temp.0).unwrap();
        drop(core);

        for name in [
            ".staging-crashed",
            ".backup-com.example.old-1-1",
            ".remove-com.example.gone-2-2",
            ".tronhawk-debris",
        ] {
            assert!(!installed.join(name).exists(), "{name} should be swept");
        }
        assert!(installed.join("com.example.real").is_dir());
        assert!(installed.join(".cache-ish").is_dir());
        assert!(installed.join("notes.txt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn config_root_rejects_symlink() {
        use std::os::unix::fs::symlink;

        let temp = TempRoot::new("config-symlink");
        let target = temp.0.join("config-target");
        std::fs::create_dir_all(&target).unwrap();
        symlink(&target, temp.0.join("config")).unwrap();
        assert!(CoreService::new(&temp.0).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn config_root_rejects_directory_symlink_when_supported() {
        use std::os::windows::fs::symlink_dir;

        let temp = TempRoot::new("config-symlink");
        let target = temp.0.join("config-target");
        std::fs::create_dir_all(&target).unwrap();
        if symlink_dir(&target, temp.0.join("config")).is_ok() {
            assert!(CoreService::new(&temp.0).is_err());
        }
    }

    #[test]
    fn get_server_proof_works_without_a_secret_and_leaks_no_token() {
        let temp = TempRoot::new("server-proof");
        let (service, control) = service(&temp);
        let challenge = "cafe".repeat(16);

        // The probe is answered before any secret-based authorization, so an empty secret is
        // enough to receive the proof.
        let response = call(
            &service,
            "",
            "getServerProof",
            serde_json::json!({ "challenge": challenge }),
        );
        let result = ok(response);
        let proof = result["proof"].as_str().unwrap();
        assert_eq!(proof.len(), 64);
        assert!(is_lowercase_hex(proof));
        assert_eq!(
            proof,
            tronhawk_ipc::compute_server_proof(&control, &challenge)
        );
        assert_ne!(proof, challenge);

        // The serialized proof response must never contain the control token.
        let serialized = serde_json::to_string(&call(
            &service,
            "",
            "getServerProof",
            serde_json::json!({ "challenge": challenge }),
        ))
        .unwrap();
        assert!(
            !serialized.contains(&control),
            "proof response leaked the control token"
        );
        drop(service);
    }

    #[test]
    fn get_server_proof_rejects_invalid_challenges() {
        let temp = TempRoot::new("server-proof-invalid");
        let (service, _control) = service(&temp);
        let invalid = [
            serde_json::json!({ "challenge": "z".repeat(64) }), // non-hex character
            serde_json::json!({ "challenge": "a".repeat(63) }), // too short
            serde_json::json!({ "challenge": "a".repeat(65) }), // too long
            serde_json::json!({ "challenge": "AB".repeat(32) }), // uppercase hex
            serde_json::json!({ "challenge": "a".repeat(64), "extra": 1 }), // unknown field
        ];
        for params in invalid {
            let response = call(&service, "", "getServerProof", params.clone());
            assert_eq!(error_code(response), -32602, "params: {params}");
        }
        drop(service);
    }
}

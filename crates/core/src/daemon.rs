use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::autostart::{autostart_command, AutostartStore, RunKeyAutostart};
use crate::iefo::{IefoReader, IefoWriteOutcome, IefoWriter, LauncherIefoWriter, RegistryIefoReader};
#[cfg(test)]
use crate::iefo::IefoSnapshot;
use crate::log_store::{LogLevel, LogQuery, LogStore, LogStream, NewLogRecord};
use crate::{
    hash_bytes, hash_json, plugin_grant, transaction_dir, transaction_file, ExecutionPlan, Plugin,
};
use tronhawk_package::{ConfigField, ConfigType};

const STATE_SCHEMA_VERSION: u32 = 1;
/// Idle window (and the value advertised as `expiresAfterIdleSeconds`). Single source of truth:
/// the signed token's freshness and the wire contract both derive from SESSION_IDLE_TIMEOUT.
const SESSION_IDLE_TIMEOUT_SECS: u64 = 600;
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(SESSION_IDLE_TIMEOUT_SECS);
/// Absolute lifetime of a launch token; a token older than this can no longer even renew.
const TOKEN_MAX_AGE_SECS: u64 = 24 * 60 * 60;
/// Clock-skew tolerance for launch-token `issued_at` (accept at most 5s in the future).
const TOKEN_FUTURE_TOLERANCE_SECS: u64 = 5;
const IMPLEMENTED_RENDERER_CAPABILITIES: &[&str] = &["renderer.css", "renderer.script"];
const IMPLEMENTED_LEVEL_TWO_CAPABILITIES: &[&str] = &[
    "renderer.css",
    "renderer.script",
    "electron.window",
    "network.access",
];
/// Level-2 capability set while Developer mode is enabled: the normal Level-2 set plus
/// `runtime.unsafe`. Developer mode never bypasses the support level — Level 0/1 are unchanged.
const IMPLEMENTED_LEVEL_TWO_DEVELOPER_CAPABILITIES: &[&str] = &[
    "renderer.css",
    "renderer.script",
    "electron.window",
    "network.access",
    "runtime.unsafe",
];
const APPLICATION_ID_PREFIX: &str = "winexe-v1:";
/// Rolling rate-limit window and budget shared by every launch token of an application.
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX_EVENTS: usize = 120;
/// A log-rate entry idle for this long has its budget reset on the next event.
const RATE_IDLE_RESET: Duration = Duration::from_secs(600);

// --- Tier-2 `networkRequest` capability limits (all enforced Core-side) ----------------------
/// Total wall-clock bound for one outbound request (connect + write + read, per hop).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum number of redirect hops Core follows; every hop is re-checked against the plugin's
/// `network.domains` whitelist before it is attempted.
const MAX_REDIRECTS: usize = 5;
/// Maximum request body a plugin may send (bytes). The IPC frame cap is far smaller today, but
/// this bound stays correct if the transport cap ever grows.
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
/// Maximum response body Core will read or return (bytes).
const MAX_RESPONSE_BODY_BYTES: usize = 1024 * 1024;
/// Maximum request headers a plugin may send.
const MAX_REQUEST_HEADERS: usize = 64;
/// Maximum response headers Core will relay back to the plugin.
const MAX_RESPONSE_HEADERS: usize = 128;
/// Maximum length of a single request header name/value and response header value (bytes).
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 8192;
/// HTTP methods a plugin may ask Core to perform.
const ALLOWED_REQUEST_METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/// Headers the transport must own; a plugin may not override them.
const CORE_CONTROLLED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
];

/// One outbound HTTP request Core performs on behalf of a plugin. The plugin never sees a
/// socket; every field has already passed capability/whitelist/cap enforcement.
struct OutboundRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// The response Core relays back to the plugin as data (`status`, `headers`, `body`).
struct OutboundResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// Test seam: Core performs HTTP through this single-shot (no redirect-following) transport.
/// The production implementation is [`UreqTransport`]; tests substitute a fake so authorization,
/// whitelisting, redirect re-checks, caps, and audit behavior are exercised deterministically
/// without a real network. Transport errors are `Err(String)`; any HTTP status (including
/// 4xx/5xx) is returned as data in `Ok`.
trait HttpTransport: Send + Sync {
    fn execute(&self, request: &OutboundRequest) -> Result<OutboundResponse, String>;
}

/// Production transport: `ureq` 2.x blocking client with a per-hop 30s timeout, automatic
/// redirects disabled (Core re-checks each redirect target against the whitelist itself), gzip
/// off (bodies stay verbatim), and the cookie feature off (no cookie jar).
struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    fn new() -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(REQUEST_TIMEOUT)
            .redirects(0)
            .user_agent(concat!("tronhawk-core/", env!("CARGO_PKG_VERSION")))
            .build();
        Self { agent }
    }
}

impl HttpTransport for UreqTransport {
    fn execute(&self, request: &OutboundRequest) -> Result<OutboundResponse, String> {
        let mut http = self.agent.request(&request.method, &request.url);
        for (name, value) in &request.headers {
            http = http.set(name, value);
        }
        let response = if request.body.is_empty() {
            http.call()
        } else {
            http.send_bytes(&request.body)
        };
        let response = match response {
            Ok(response) => response,
            // HTTP status codes (including 4xx/5xx) are data, not transport failures.
            Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(transport)) => {
                return Err(sanitize_transport_error(&transport.to_string()));
            }
        };
        let status = response.status();
        let header_names = response.headers_names();
        let headers = header_names
            .iter()
            .filter_map(|name| {
                // Keep the first value for a name; duplicates (e.g. multiple Set-Cookie) are
                // collapsed when the response is relayed as a JSON header object anyway.
                response
                    .all(name)
                    .into_iter()
                    .next()
                    .map(|value| (name.clone(), value.to_owned()))
            })
            .collect::<Vec<_>>();
        let mut reader = response.into_reader();
        let mut body = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = reader
                .read(&mut chunk)
                .map_err(|error| format!("read outbound response: {error}"))?;
            if count == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..count]);
            if body.len() > MAX_RESPONSE_BODY_BYTES {
                // Drop the reader without draining; the connection is abandoned (never pooled).
                return Err(format!(
                    "response body exceeds the {} MiB limit",
                    MAX_RESPONSE_BODY_BYTES / (1024 * 1024)
                ));
            }
        }
        Ok(OutboundResponse {
            status,
            headers,
            body,
        })
    }
}

/// A transport error may embed addresses but never secrets we hold; clamp it to a single line
/// so a pathological message cannot inject control characters into a JSON error payload.
fn sanitize_transport_error(message: &str) -> String {
    message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GlobalState {
    developer_mode: bool,
    /// Whether Core registers itself in the HKCU Run key at boot. Defaults to true; a legacy
    /// state file without the field loads with the default via `#[serde(default)]`.
    #[serde(default = "core_autostart_default")]
    core_autostart: bool,
}

/// The `coreAutostart` default for a fresh state and for legacy state files that predate the
/// field: Core registers itself unless the user opted out.
fn core_autostart_default() -> bool {
    true
}

impl Default for GlobalState {
    fn default() -> Self {
        Self {
            developer_mode: false,
            core_autostart: core_autostart_default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPolicy {
    pub enabled: bool,
    #[serde(default)]
    pub grants: Vec<String>,
    /// Stored per-plugin config values (a whole-object snapshot replaced by `setPluginConfig`),
    /// keyed by the plugin manifest's declared config schema. Missing for legacy state.json —
    /// `#[serde(default)]` keeps old state files loadable.
    #[serde(default)]
    pub config: BTreeMap<String, serde_json::Value>,
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

/// Claims recovered from a verified, self-contained launch token.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchClaims {
    application_id: String,
    issued_at: u64,
}

/// Per-application runtime log-ingest budget, shared across every launch token of that
/// application. Idle entries have their budget reset lazily on the next event (see
/// [`RATE_IDLE_RESET`]); restart resets all budgets, which is a DoS-only regression (accepted).
#[derive(Debug)]
struct LogRate {
    last_activity: Instant,
    log_events: VecDeque<Instant>,
}

/// Content-fingerprinted snapshot of the installed plugins. Served from memory while the
/// installed-plugin directory fingerprint is unchanged. When `stale` is set the cached plugins
/// are a last-good fallback because the most recent rescan failed.
#[derive(Debug, Clone)]
struct PluginCache {
    fingerprint: String,
    plugins: Vec<Plugin>,
    stale: bool,
}

struct ServiceInner {
    state: DaemonState,
    plugin_cache: Option<PluginCache>,
    log_rates: HashMap<String, LogRate>,
    /// Autostart Run-entry backend. Swappable so daemon tests can inject a fake; production
    /// always uses the Windows `reg`-backed [`RunKeyAutostart`].
    autostart: Arc<dyn AutostartStore>,
}

/// Single-writer Core state and request router.
pub struct CoreService {
    root: PathBuf,
    installed_root: PathBuf,
    state_path: PathBuf,
    control_token_path: PathBuf,
    control_token: String,
    /// Persistent HMAC key for self-contained launch tokens. Never derived from the control
    /// token. Deleting `launch.key` is a manual rotation: all previously minted launch tokens
    /// stop verifying, so every running target must relaunch to acquire a fresh one.
    launch_key: String,
    /// Outbound HTTP client used by the Tier-2 `networkRequest` capability. Always Core-side:
    /// plugins only ever send a URL + params over IPC and receive the response back.
    http: Box<dyn HttpTransport>,
    inner: Mutex<ServiceInner>,
    logs: Mutex<LogStore>,
    /// HKLM IFEO registration backend (elevated write through the co-located injector launcher).
    /// Swappable so daemon tests can inject a fake; production always uses [`LauncherIefoWriter`].
    iefo_writer: Arc<dyn IefoWriter>,
    /// HKLM IFEO read backend (direct, non-elevated). Swappable so daemon tests can inject a
    /// fake; production always uses [`RegistryIefoReader`].
    iefo_reader: Arc<dyn IefoReader>,
}

impl CoreService {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        let installed_root = root.join("plugins").join("installed");
        let config_root = root.join("config");
        let state_path = config_root.join("state.json");
        let control_token_path = config_root.join("control.token");
        let launch_key_path = config_root.join("launch.key");
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
        let control_token = read_or_create_secret(&control_token_path, "control token")?;
        let launch_key = read_or_create_secret(&launch_key_path, "launch key")?;
        let logs = LogStore::new(&root)?;

        Ok(Self {
            root,
            installed_root,
            state_path,
            control_token_path,
            control_token,
            launch_key,
            http: Box::new(UreqTransport::new()),
            logs: Mutex::new(logs),
            inner: Mutex::new(ServiceInner {
                state,
                plugin_cache: None,
                log_rates: HashMap::new(),
                autostart: Arc::new(RunKeyAutostart),
            }),
            iefo_writer: Arc::new(LauncherIefoWriter),
            iefo_reader: Arc::new(RegistryIefoReader),
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

        // Control-token requests are authorized by possession of the persistent control token.
        if constant_time_eq(request.secret.as_bytes(), self.control_token.as_bytes()) {
            // setIefoRegistration may sit on a UAC prompt for a long time, and the runtime's plan
            // polls share the state mutex. Dispatch it BEFORE taking the state lock: the handler
            // snapshots the application record under a short lock, then runs the elevated write
            // with the mutex free.
            if request.method == "setIefoRegistration" {
                return self.set_iefo_registration(request);
            }
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return rpc_error(request.id, -32603, "internal error"),
            };
            return self.handle_control(request, &mut inner);
        }

        // Launch tokens are self-contained and stateless (DUR-1): verify signature + claims here,
        // with no in-memory session table to lose across restarts.
        let now_secs = match now_unix_seconds() {
            Ok(now) => now,
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };
        let Some(claims) = verify_launch_token(now_secs, &self.launch_key, &request.secret) else {
            return rpc_error(request.id, -32001, "unauthorized");
        };

        if request.method == "renewSession" {
            if !is_empty_params(&request.params) {
                return rpc_error(request.id, -32602, "invalid params");
            }
            if now_secs.saturating_sub(claims.issued_at) >= TOKEN_MAX_AGE_SECS {
                return rpc_error(request.id, -32001, "unauthorized");
            }
            // Renewal is a stateless re-sign; no per-renew core log event is emitted.
            return self.mint_session_response(request.id, &claims.application_id);
        }
        if now_secs.saturating_sub(claims.issued_at) >= SESSION_IDLE_TIMEOUT_SECS {
            return rpc_error(request.id, -32001, "unauthorized");
        }

        let application_id = claims.application_id;
        // `networkRequest` performs outbound I/O (up to 30s per hop). Dispatch it before taking
        // the request lock so a slow fetch can never stall plan/log/control requests on the same
        // application; authorization takes the lock only briefly, then releases it for I/O.
        if request.method == "networkRequest" {
            return self.network_request(request, &application_id);
        }
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };
        match request.method.as_str() {
            "getExecutionPlan" => {
                if !is_empty_params(&request.params) {
                    return rpc_error(request.id, -32602, "invalid params");
                }
                match self.execution_plan(&mut inner, &application_id) {
                    Ok(plan) => rpc_ok(request.id, plan),
                    Err(_) => rpc_error(request.id, -32603, "internal error"),
                }
            }
            "appendRuntimeLogs" => self.append_runtime_logs(request, &mut inner, &application_id),
            "appendPluginLogs" => self.append_plugin_logs(request, &mut inner, &application_id),
            _ => rpc_error(request.id, -32003, "forbidden"),
        }
    }

    /// Mint a fresh self-contained launch token for `application_id` and respond with the
    /// canonical `createLaunchSession`/`renewSession` shape.
    fn mint_session_response(
        &self,
        request_id: u64,
        application_id: &str,
    ) -> tronhawk_ipc::Response {
        match self.session_json(application_id) {
            Ok(value) => rpc_ok(request_id, value),
            Err(_) => rpc_error(request_id, -32603, "internal error"),
        }
    }

    /// Canonical launch-session JSON: a fresh HMAC-signed launch token for `application_id`.
    fn session_json(&self, application_id: &str) -> RouterResult {
        let now_secs = now_unix_seconds()
            .map_err(|_| RouterError::Internal("system clock is before Unix epoch".into()))?;
        let token = mint_launch_token(now_secs, &self.launch_key, application_id)?;
        Ok(serde_json::json!({
            "token": token,
            "applicationId": application_id,
            "expiresAfterIdleSeconds": SESSION_IDLE_TIMEOUT.as_secs(),
        }))
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
            "removeApplication" => self.remove_application(inner, request.params),
            "getIefoRegistration" => self.get_iefo_registration(inner, request.params),
            "getManagerSnapshot" => {
                if is_empty_params(&request.params) {
                    self.manager_snapshot(inner)
                } else {
                    Err(RouterError::InvalidParams("expected empty params".into()))
                }
            }
            "getCoreAutostart" => {
                if is_empty_params(&request.params) {
                    self.get_core_autostart(inner)
                } else {
                    Err(RouterError::InvalidParams("expected empty params".into()))
                }
            }
            "setCoreAutostart" => self.set_core_autostart(inner, request.params),
            "installPlugin" => self.install_plugin(inner, request.params),
            "setApplicationPluginPolicy" => self.set_policy(inner, request.params),
            "setDeveloperMode" => self.set_developer_mode(inner, request.params),
            "getPluginConfig" => self.get_plugin_config(inner, request.params),
            "setPluginConfig" => self.set_plugin_config(inner, request.params),
            "removePlugin" => self.remove_plugin(inner, request.params),
            "createLaunchSession" => self.create_launch_session(request.params),
            "queryLogs" => self.query_logs(request.params),
            "appendRuntimeLogs" | "appendPluginLogs" => {
                return rpc_error(request.id, -32003, "forbidden")
            }
            "getExecutionPlan" | "renewSession" | "networkRequest" => {
                return rpc_error(request.id, -32003, "forbidden")
            }
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
        if !log_rate_available(inner, application_id, params.events.len()) {
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
        commit_log_ingest(inner, application_id, params.events.len());
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
        // Each event's plugin must be granted in the CURRENT plan for this application
        // (derived from the cached plugins + in-memory policy each request), so a policy
        // revoke takes effect immediately — there is no stored allowed-set to go stale.
        let allowed: HashSet<String> = match self.execution_plan(inner, application_id) {
            Ok(plan) => plan
                .plugins
                .iter()
                .map(|plugin| plugin.id.clone())
                .collect(),
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };
        if params
            .events
            .iter()
            .any(|event| !allowed.contains(&event.plugin_id))
        {
            return rpc_error(
                request.id,
                -32003,
                "plugin was not in the current execution plan",
            );
        }
        if !log_rate_available(inner, application_id, params.events.len()) {
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
        commit_log_ingest(inner, application_id, params.events.len());
        rpc_ok(
            request.id,
            serde_json::json!({ "accepted": params.events.len() }),
        )
    }

    /// Handle the Tier-2 `networkRequest` RPC (launch-token only). Authorization is derived from
    /// the app's CURRENT execution plan (a plugin must be enabled right now with a granted
    /// `network.access`, so a policy revoke or support-level change takes effect immediately),
    /// and the request URL is checked against the plugin manifest's `network.domains` whitelist
    /// (exact host / `*.` subdomain, port-aware). Only then does Core perform the HTTP(S)
    /// request; the plugin never sees a socket. Redirects are followed Core-side, each re-checked
    /// against the whitelist, up to [`MAX_REDIRECTS`].
    fn network_request(
        &self,
        request: tronhawk_ipc::Request,
        application_id: &str,
    ) -> tronhawk_ipc::Response {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            plugin_id: String,
            url: String,
            #[serde(default)]
            method: Option<String>,
            #[serde(default)]
            headers: Option<BTreeMap<String, String>>,
            #[serde(default)]
            body: Option<String>,
        }
        let params: Params = match parse_params(request.params) {
            Ok(params) => params,
            Err(_) => return rpc_error(request.id, -32602, "invalid params"),
        };

        // Authorize under a brief lock: derive the current plan, require a live `network.access`
        // grant, and clone the plugin manifest's domain whitelist. The lock is released before
        // any network I/O so a slow fetch cannot stall other requests.
        let whitelist = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return rpc_error(request.id, -32603, "internal error"),
            };
            match self.authorize_network_request(
                &mut inner,
                application_id,
                &params.plugin_id,
                request.id,
            ) {
                Ok(whitelist) => whitelist,
                Err(response) => return response,
            }
        };

        if params.url.len() > 16 * 1024 {
            return rpc_error(request.id, -32602, "url is too long");
        }
        let url = match url::Url::parse(&params.url) {
            Ok(url) => url,
            Err(_) => {
                return rpc_error(
                    request.id,
                    -32602,
                    "url must be an absolute http:// or https:// URL",
                )
            }
        };
        let (host, port, url) = match validate_request_url(url) {
            Ok(triple) => triple,
            Err((code, message)) => return rpc_error(request.id, code, message),
        };
        if !domain_allows(&host, port, &whitelist) {
            return rpc_error(
                request.id,
                -32003,
                format!(
                    "host `{host}` is not allowed by plugin `{}` network.domains",
                    params.plugin_id
                ),
            );
        }

        // Method / body / header validation (request-side caps -> invalid params).
        let method = params.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
        if !ALLOWED_REQUEST_METHODS.contains(&method.as_str()) {
            return rpc_error(
                request.id,
                -32602,
                format!(
                    "unsupported method `{method}` (allowed: GET, HEAD, POST, PUT, PATCH, DELETE)"
                ),
            );
        }
        let mut body = Vec::new();
        if let Some(body_text) = &params.body {
            if body_text.len() > MAX_REQUEST_BODY_BYTES {
                return rpc_error(
                    request.id,
                    -32602,
                    format!(
                        "request body exceeds the {} MiB limit",
                        MAX_REQUEST_BODY_BYTES / (1024 * 1024)
                    ),
                );
            }
            if (method == "GET" || method == "HEAD") && !body_text.is_empty() {
                return rpc_error(
                    request.id,
                    -32602,
                    "request bodies are not allowed for GET or HEAD",
                );
            }
            body = body_text.as_bytes().to_vec();
        }
        let headers = params.headers.unwrap_or_default();
        if headers.len() > MAX_REQUEST_HEADERS {
            return rpc_error(
                request.id,
                -32602,
                format!("too many request headers (limit {MAX_REQUEST_HEADERS})"),
            );
        }
        for (name, value) in &headers {
            if name.is_empty() || name.len() > MAX_HEADER_NAME_BYTES || !valid_header_name(name) {
                return rpc_error(
                    request.id,
                    -32602,
                    format!("invalid request header name `{name}`"),
                );
            }
            let lower = name.to_ascii_lowercase();
            if CORE_CONTROLLED_HEADERS.contains(&lower.as_str()) {
                return rpc_error(
                    request.id,
                    -32602,
                    format!("header `{name}` is controlled by Core"),
                );
            }
            if value.len() > MAX_HEADER_VALUE_BYTES || value.contains('\r') || value.contains('\n') {
                return rpc_error(
                    request.id,
                    -32602,
                    format!("invalid request header value for `{name}`"),
                );
            }
        }
        let header_pairs: Vec<(String, String)> = headers.into_iter().collect();

        // Perform the request Core-side, following redirects manually so each hop is re-checked
        // against the whitelist. `current_host` drives cross-host header stripping and the audit.
        let mut current_url = url;
        let mut current_host = (host.clone(), port);
        let mut method = method;
        // Header set for the next hop; on a cross-host redirect, credential headers the plugin
        // attached for the original host are dropped so they never leak to a different host.
        let mut hop_headers = header_pairs.clone();
        let mut redirects_followed = 0usize;
        let response = loop {
            let outbound = OutboundRequest {
                url: current_url.to_string(),
                method: method.clone(),
                headers: hop_headers.clone(),
                body: body.clone(),
            };
            let response = match self.http.execute(&outbound) {
                Ok(response) => response,
                Err(error) => {
                    self.append_network_audit(
                        application_id,
                        &params.plugin_id,
                        &current_host.0,
                        0,
                        0,
                    );
                    return rpc_error(request.id, -32004, format!("network request failed: {error}"));
                }
            };
            if !is_redirect_status(response.status) {
                break response;
            }
            let Some(location) = response_header(&response.headers, "location") else {
                // A 3xx without a Location header is a final response (data).
                break response;
            };
            if redirects_followed >= MAX_REDIRECTS {
                self.append_network_audit(
                    application_id,
                    &params.plugin_id,
                    &current_host.0,
                    0,
                    0,
                );
                return rpc_error(
                    request.id,
                    -32004,
                    format!("too many redirects (limit {MAX_REDIRECTS})"),
                );
            }
            let next_url = match current_url.join(location) {
                Ok(next) => next,
                Err(_) => {
                    return rpc_error(
                        request.id,
                        -32004,
                        "redirect location could not be resolved",
                    )
                }
            };
            let (next_host, next_port, next_url) = match validate_request_url(next_url) {
                Ok(triple) => triple,
                Err((code, message)) => return rpc_error(request.id, code, message),
            };
            if !domain_allows(&next_host, next_port, &whitelist) {
                return rpc_error(
                    request.id,
                    -32003,
                    format!(
                        "redirect target host `{next_host}` is not allowed by plugin `{}` \
                         network.domains",
                        params.plugin_id
                    ),
                );
            }
            // RFC 7231/7230 redirect semantics: 303 forces GET (HEAD stays HEAD); 301/302
            // downgrade other methods to GET and drop the body; 307/308 resend the same method
            // and body. Credential headers are not forwarded across hosts.
            if response.status == 303 {
                if method != "HEAD" {
                    method = "GET".into();
                }
                body.clear();
            } else if matches!(response.status, 301 | 302)
                && method != "GET"
                && method != "HEAD"
            {
                method = "GET".into();
                body.clear();
            }
            let _ = response; // not used again; next hop is a fresh request
            redirects_followed += 1;
            if next_host != current_host.0 {
                hop_headers.retain(|(name, _)| {
                    let lower = name.to_ascii_lowercase();
                    lower != "authorization" && lower != "cookie"
                });
            }
            current_url = next_url;
            current_host = (next_host, next_port);
        };

        // Response-side caps -> resource-limit rejections (HTTP status is always data).
        if response.headers.len() > MAX_RESPONSE_HEADERS {
            return rpc_error(
                request.id,
                -32004,
                format!("response has too many headers (limit {MAX_RESPONSE_HEADERS})"),
            );
        }
        for (name, value) in &response.headers {
            if name.len() > MAX_HEADER_NAME_BYTES || value.len() > MAX_HEADER_VALUE_BYTES {
                return rpc_error(request.id, -32004, "response headers exceed the size limits");
            }
        }
        if response.body.len() > MAX_RESPONSE_BODY_BYTES {
            return rpc_error(
                request.id,
                -32004,
                format!(
                    "response body exceeds the {} MiB limit",
                    MAX_RESPONSE_BODY_BYTES / (1024 * 1024)
                ),
            );
        }
        self.append_network_audit(
            application_id,
            &params.plugin_id,
            &current_host.0,
            response.status,
            response.body.len(),
        );
        let header_map: BTreeMap<String, String> = response.headers.iter().cloned().collect();
        let body_text = String::from_utf8_lossy(&response.body).into_owned();
        rpc_ok(
            request.id,
            serde_json::json!({
                "status": response.status,
                "headers": header_map,
                "body": body_text,
            }),
        )
    }

    /// Verify that `plugin_id` is in the CURRENT execution plan for `application_id` with a
    /// granted `network.access`, then return the plugin manifest's (lowercased) `network.domains`
    /// whitelist. A plugin that is not in the plan, is not granted the capability, or declares no
    /// whitelist is rejected fail-closed with a structured error response.
    fn authorize_network_request(
        &self,
        inner: &mut ServiceInner,
        application_id: &str,
        plugin_id: &str,
        request_id: u64,
    ) -> Result<Vec<String>, tronhawk_ipc::Response> {
        let plan = match self.execution_plan(inner, application_id) {
            Ok(plan) => plan,
            Err(_) => return Err(rpc_error(request_id, -32603, "internal error")),
        };
        let Some(grant) = plan.plugins.iter().find(|plugin| plugin.id == plugin_id) else {
            return Err(rpc_error(
                request_id,
                -32003,
                format!("plugin `{plugin_id}` is not in the current execution plan"),
            ));
        };
        if !grant.granted.iter().any(|capability| capability == "network.access") {
            return Err(rpc_error(
                request_id,
                -32003,
                format!("plugin `{plugin_id}` is not granted `network.access`"),
            ));
        }
        // The plan derives from the same installed-plugin snapshot, so the manifest is present.
        let installed = match self.installed_plugins(inner) {
            Ok(plugins) => plugins,
            Err(_) => return Err(rpc_error(request_id, -32603, "internal error")),
        };
        let Some(plugin) = installed.iter().find(|plugin| plugin.id == plugin_id) else {
            return Err(rpc_error(request_id, -32603, "internal error"));
        };
        let whitelist = plugin
            .network
            .as_ref()
            .map(|network| network.domains.clone())
            .unwrap_or_default();
        if whitelist.is_empty() {
            return Err(rpc_error(
                request_id,
                -32003,
                format!(
                    "plugin `{plugin_id}` declares no `network.domains`; the domain whitelist is empty"
                ),
            ));
        }
        Ok(whitelist)
    }

    /// Best-effort plugin-stream audit record for a Core-performed `network.request` (host,
    /// status, bytes). A failed exchange is recorded with status 0 and bytes 0 so attempts are
    /// accountable even when the upstream never answered. Never includes the URL query, the
    /// request headers, or the response body.
    fn append_network_audit(
        &self,
        application_id: &str,
        plugin_id: &str,
        host: &str,
        status: u16,
        bytes: usize,
    ) {
        if let Ok(mut logs) = self.logs.lock() {
            let message = format!("network.request host={host} status={status} bytes={bytes}");
            let _ = logs.append(NewLogRecord {
                stream: LogStream::Plugin,
                level: LogLevel::Info,
                code: "network.request",
                application_id,
                plugin_id: Some(plugin_id),
                message: &message,
            });
        }
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

    /// Remove a registered application: its state (registration + per-plugin policy/config) is
    /// dropped from `state.json`, the record is persisted, and a `core.application.removed`
    /// event is logged. Deliberately does NOT touch the HKLM IFEO entry — transparent launch is
    /// owned by the separate `setIefoRegistration` switch, so removing an application never
    /// silently tears down (or silently keeps) a redirection the user manages explicitly.
    /// Unknown ids are invalid params (-32602).
    fn remove_application(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: String,
        }
        let params: Params = parse_params(params)?;
        if !inner.state.applications.contains_key(&params.application_id) {
            return Err(RouterError::InvalidParams("application not found".into()));
        }
        let mut next = inner.state.clone();
        next.applications.remove(&params.application_id);
        write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
        inner.state = next;
        self.append_core_event(
            &params.application_id,
            None,
            "core.application.removed",
            "Application removed",
        );
        Ok(serde_json::json!({ "removed": true }))
    }

    /// Read the current HKLM IFEO registration for an application by resolving its executable
    /// and probing the registry directly — no launcher, no elevation. Unknown ids are invalid
    /// params (-32602); a missing/unreadable key (or a non-Windows host) degrades to
    /// `{ registered: false, owned: false }`.
    fn get_iefo_registration(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: String,
        }
        let params: Params = parse_params(params)?;
        let application = inner
            .state
            .applications
            .get(&params.application_id)
            .cloned()
            .ok_or_else(|| RouterError::InvalidParams("application not found".into()))?;
        let snapshot = self
            .iefo_reader
            .read(&application.executable_path)
            .unwrap_or_default();
        Ok(serde_json::json!({
            "applicationId": params.application_id,
            "registered": snapshot.registered,
            "owned": snapshot.owned,
        }))
    }

    /// Enable/disable the HKLM IFEO registration for an application by re-launching the
    /// co-located injector launcher elevated (`register`/`unregister <exe>`). Runs WITHOUT the
    /// state mutex held across the UAC prompt (see [`Self::handle_request`]); the application
    /// record is snapshotted under a short lock first.
    ///
    /// - Exit code 0 (Applied) → `registered = enabled`, `cancelled = false`.
    /// - A dismissed UAC prompt (Cancelled) → `cancelled = true`, `registered` reflects whatever
    ///   is still in the registry (the Manager snaps its switch back to the real state).
    /// - Any other launcher failure → -32603 with a `core.iefo.write_failed` event.
    fn set_iefo_registration(&self, request: tronhawk_ipc::Request) -> tronhawk_ipc::Response {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: String,
            enabled: bool,
        }
        let params: Params = match parse_params(request.params) {
            Ok(params) => params,
            Err(_) => return rpc_error(request.id, -32602, "invalid params"),
        };
        let executable_path = match self.inner.lock() {
            Ok(inner) => match inner.state.applications.get(&params.application_id) {
                Some(application) => application.executable_path.clone(),
                None => return rpc_error(request.id, -32602, "application not found"),
            },
            Err(_) => return rpc_error(request.id, -32603, "internal error"),
        };

        let outcome = match self.iefo_writer.apply(&executable_path, params.enabled) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.report_iefo_failure(&params.application_id, params.enabled, &error);
                return rpc_error(
                    request.id,
                    -32603,
                    format!("IFEO registration failed: {error}"),
                );
            }
        };

        let (registered, cancelled) = match outcome {
            IefoWriteOutcome::Applied => (params.enabled, false),
            // The user declined elevation: nothing changed, so report the state actually still
            // in the registry (degraded to false when the entry can no longer be read).
            IefoWriteOutcome::Cancelled => (
                self.iefo_reader
                    .read(&executable_path)
                    .map(|snapshot| snapshot.registered)
                    .unwrap_or(false),
                true,
            ),
        };
        match outcome {
            IefoWriteOutcome::Applied if params.enabled => self.append_core_event(
                &params.application_id,
                None,
                "core.iefo.registered",
                "IFEO registration enabled",
            ),
            IefoWriteOutcome::Applied => self.append_core_event(
                &params.application_id,
                None,
                "core.iefo.unregistered",
                "IFEO registration disabled",
            ),
            // A cancelled UAC prompt changes nothing, so no event is recorded.
            IefoWriteOutcome::Cancelled => {}
        }
        rpc_ok(
            request.id,
            serde_json::json!({
                "applicationId": params.application_id,
                "registered": registered,
                "cancelled": cancelled,
            }),
        )
    }

    /// Record an elevated IFEO write failure as a `core.iefo.write_failed` event and echo it to
    /// the daemon stderr. The message never embeds the target executable path.
    fn report_iefo_failure(&self, application_id: &str, enabled: bool, error: &str) {
        let action = if enabled { "enable" } else { "disable" };
        let message = format!("IFEO {action} failed: {error}");
        self.append_core_event(application_id, None, "core.iefo.write_failed", &message);
        eprintln!("[core] {message}");
    }

    fn create_launch_session(&self, params: serde_json::Value) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            executable_path: String,
        }
        let params: Params = parse_params(params)?;
        let canonical = canonical_executable(&params.executable_path)?;
        let application_id = application_id_for_canonical_path(&canonical.path);
        self.append_core_event(
            &application_id,
            None,
            "core.launch_session.created",
            "Launch session created",
        );
        self.session_json(&application_id)
    }

    /// Toggle Developer mode (control-token only). Enabling only flips the persisted flag;
    /// disabling additionally purges `runtime.unsafe` from every application's plugin policy
    /// grants so revoking Developer mode also revokes previously granted unsafe capability.
    /// No-op when the requested state equals the current one (idempotent: no write, no event).
    fn set_developer_mode(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            enabled: bool,
        }
        let params: Params = parse_params(params)?;
        if inner.state.global.developer_mode == params.enabled {
            return Ok(serde_json::json!({ "developerMode": params.enabled }));
        }
        let mut next = inner.state.clone();
        if !params.enabled {
            for application in next.applications.values_mut() {
                for policy in application.plugins.values_mut() {
                    policy.grants.retain(|grant| grant != "runtime.unsafe");
                }
            }
        }
        next.global.developer_mode = params.enabled;
        write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
        inner.state = next;
        let message = if params.enabled {
            "Developer mode enabled"
        } else {
            "Developer mode disabled; runtime.unsafe grants revoked"
        };
        self.append_core_event("global", None, "core.developerMode.updated", message);
        Ok(serde_json::json!({ "developerMode": params.enabled }))
    }

    /// Effective Core-autostart state: the persisted preference OR the presence of the HKCU Run
    /// entry. The OR keeps reporting an entry that is actually registered even when the persisted
    /// preference was turned off afterwards (e.g. a failed disable), and a preference that is on
    /// but has not reached the registry yet still reports enabled — the registry op is a
    /// reconciliation detail recorded in the event log.
    fn get_core_autostart(&self, inner: &ServiceInner) -> RouterResult {
        Ok(serde_json::json!({
            "enabled": inner.state.global.core_autostart || inner.autostart.is_registered(),
        }))
    }

    /// Set the Core-autostart preference and reconcile the HKCU Run entry. Control-token only.
    /// `register` runs only when the entry is missing (idempotent — never rewritten); `unregister`
    /// is a no-op when the entry is already absent. A failed registry op is surfaced as an RPC
    /// error (the preference is NOT flipped to a state the registry does not back) and is also
    /// recorded as a `core.autostart.register_failed` event.
    fn set_core_autostart(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            enabled: bool,
        }
        let params: Params = parse_params(params)?;
        let store = Arc::clone(&inner.autostart);

        if params.enabled {
            if !store.is_registered() {
                let executable = std::env::current_exe()
                    .map_err(|error| RouterError::Internal(format!("resolve core executable: {error}")))?;
                if let Err(error) = store.register(&autostart_command(&executable)) {
                    self.report_autostart_failure("registration", &error);
                    return Err(RouterError::Internal(format!(
                        "Core autostart registration failed: {error}"
                    )));
                }
            }
        } else if store.is_registered() {
            if let Err(error) = store.unregister() {
                self.report_autostart_failure("unregistration", &error);
                return Err(RouterError::Internal(format!(
                    "Core autostart unregistration failed: {error}"
                )));
            }
        }

        if inner.state.global.core_autostart != params.enabled {
            let mut next = inner.state.clone();
            next.global.core_autostart = params.enabled;
            write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
            inner.state = next;
        }
        Ok(serde_json::json!({ "enabled": params.enabled }))
    }

    /// Startup reconciliation of the autostart preference: when the persisted preference is true
    /// and the HKCU Run entry is missing, register `<core.exe> /autostart`. Called by the daemon
    /// entrypoint on the default storage root (the root the Run entry actually launches).
    /// Failures are recorded as `core.autostart.register_failed` events and never crash startup.
    pub fn ensure_core_autostart_registered(&self) {
        let (enabled, store) = {
            let Ok(inner) = self.inner.lock() else {
                return;
            };
            (inner.state.global.core_autostart, Arc::clone(&inner.autostart))
        };
        if !enabled || store.is_registered() {
            return;
        }
        let command = match std::env::current_exe() {
            Ok(executable) => autostart_command(&executable),
            Err(error) => {
                self.report_autostart_failure(
                    "registration",
                    &format!("cannot resolve core executable: {error}"),
                );
                return;
            }
        };
        if let Err(error) = store.register(&command) {
            self.report_autostart_failure("registration", &error);
        }
    }

    /// Record a startup-scoped Core event (e.g. a failed legacy-storage migration) through the
    /// secure event log. Best-effort: a broken log store never fails daemon startup.
    pub fn record_startup_event(&self, code: &'static str, message: &str) {
        self.append_core_event("global", None, code, message);
    }

    fn report_autostart_failure(&self, action: &str, error: &str) {
        let message = format!("Core autostart {action} failed: {error}");
        self.append_core_event("global", None, "core.autostart.register_failed", &message);
        eprintln!("[core] {message}");
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
            .cloned()
            .ok_or_else(|| RouterError::InvalidParams("application not found".into()))?;
        if params.enabled && application.support_level == 0 {
            return Err(RouterError::InvalidParams(
                "Level 0 applications cannot enable plugins".into(),
            ));
        }
        let plugin = self
            .installed_plugins(inner)?
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
        let supported = capabilities_for_support_level(
            application.support_level,
            inner.state.global.developer_mode,
        );
        if params
            .grants
            .iter()
            .any(|grant| !supported.contains(&grant.as_str()))
        {
            return Err(RouterError::InvalidParams(
                "grants are unavailable at the application's support level".into(),
            ));
        }

        // CRITICAL interlock: rebuilding the policy from `enabled` + `grants` must NOT wipe the
        // per-plugin stored config. A Manager grant-toggle goes through here and would otherwise
        // silently drop every configured value.
        let config = application
            .plugins
            .get(&params.plugin_id)
            .map(|existing| existing.config.clone())
            .unwrap_or_default();
        let policy = PluginPolicy {
            enabled: params.enabled,
            grants: params.grants,
            config,
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

    /// Read the merged config for an installed plugin in an application: schema defaults overlaid
    /// with the stored per-application policy config, restricted to schema-declared keys.
    fn get_plugin_config(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: String,
            plugin_id: String,
        }
        let params: Params = parse_params(params)?;
        let application = inner
            .state
            .applications
            .get(&params.application_id)
            .cloned()
            .ok_or_else(|| RouterError::InvalidParams("application not found".into()))?;
        let plugin = self
            .installed_plugins(inner)?
            .into_iter()
            .find(|plugin| plugin.id == params.plugin_id)
            .ok_or_else(|| RouterError::InvalidParams("plugin not found".into()))?;
        let stored = application
            .plugins
            .get(&plugin.id)
            .map(|policy| policy.config.clone())
            .unwrap_or_default();
        Ok(serde_json::json!({
            "config": merge_plugin_config(&plugin.config, &stored)
        }))
    }

    /// Replace the whole stored config object for an installed plugin in an application. Every
    /// key must be declared by the plugin's config schema and every value must match the schema
    /// field type (strings capped at 4096 bytes); the object is persisted and a core event is
    /// emitted. Returns the merged config (defaults overlaid on the newly stored values).
    fn set_plugin_config(
        &self,
        inner: &mut ServiceInner,
        params: serde_json::Value,
    ) -> RouterResult {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            application_id: String,
            plugin_id: String,
            config: BTreeMap<String, serde_json::Value>,
        }
        let params: Params = parse_params(params)?;
        if !inner
            .state
            .applications
            .contains_key(&params.application_id)
        {
            return Err(RouterError::InvalidParams("application not found".into()));
        }
        let plugin = self
            .installed_plugins(inner)?
            .into_iter()
            .find(|plugin| plugin.id == params.plugin_id)
            .ok_or_else(|| RouterError::InvalidParams("plugin not found".into()))?;
        for key in params.config.keys() {
            if !plugin.config.contains_key(key) {
                return Err(RouterError::InvalidParams(format!(
                    "unknown config key `{key}`"
                )));
            }
        }
        for (key, value) in &params.config {
            let field = &plugin.config[key];
            let matches_type = match field.field_type {
                ConfigType::String => value.is_string(),
                ConfigType::Number => value.is_number(),
                ConfigType::Boolean => value.is_boolean(),
            };
            if !matches_type {
                return Err(RouterError::InvalidParams(format!(
                    "config key `{key}` must be a {}",
                    field.field_type.type_name()
                )));
            }
            if field.field_type == ConfigType::String
                && value.as_str().is_some_and(|string| string.len() > 4096)
            {
                return Err(RouterError::InvalidParams(format!(
                    "config key `{key}` must be at most 4096 bytes"
                )));
            }
        }
        let merged = merge_plugin_config(&plugin.config, &params.config);

        // REPLACE the whole stored config object (not a per-key merge): callers always send the
        // full desired state.
        let mut next = inner.state.clone();
        next.applications
            .get_mut(&params.application_id)
            .expect("application checked above")
            .plugins
            .entry(params.plugin_id.clone())
            .or_default()
            .config = params.config;
        write_state(&self.state_path, &next).map_err(RouterError::Internal)?;
        inner.state = next;
        self.append_core_event(
            &params.application_id,
            Some(&params.plugin_id),
            "core.plugin_config.updated",
            "Plugin config updated",
        );
        Ok(serde_json::json!({ "config": merged }))
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
        // The installed directory changed; drop the cached plugin snapshot so the next read
        // rescans and repopulates it.
        inner.plugin_cache = None;
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
            .installed_plugins(inner)?
            .into_iter()
            .find(|plugin| plugin.id == params.plugin_id)
            .ok_or_else(|| RouterError::InvalidParams("plugin not found".into()))?;
        let final_dir = self.installed_root.join(&plugin.id);
        let trash = transaction_dir(&self.installed_root, "remove", &plugin.id);
        std::fs::rename(&final_dir, &trash)
            .map_err(|e| RouterError::Internal(format!("stage plugin removal: {e}")))?;
        // The installed directory changed; drop the cached plugin snapshot immediately so a
        // concurrently served plan cannot keep advertising a plugin that is being removed.
        inner.plugin_cache = None;
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
        message: &str,
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

    /// Cached read of the installed plugins (CORE-3). Returns the cached snapshot while the
    /// installed-root fingerprint is unchanged; rescans and repopulates on change. If a rescan
    /// fails after a fingerprint change (a plugin directory was damaged or removed out-of-band),
    /// a single recovery event is logged and the last good cache is served so plan/snapshot stay
    /// available (availability-first, like CORE-2); policy ∩ permissions ∩ support-level
    /// filtering is still applied to whatever payload is produced.
    fn installed_plugins(&self, inner: &mut ServiceInner) -> Result<Vec<Plugin>, RouterError> {
        let fingerprint = fingerprint(&self.installed_root).ok();
        if let (Some(current), Some(cache)) = (&fingerprint, &inner.plugin_cache) {
            if cache.fingerprint == *current && !cache.stale {
                return Ok(cache.plugins.clone());
            }
        }

        // Fingerprint changed (or no cache yet): rescan, repairing the cache on success.
        let rescanned = match &fingerprint {
            Some(_) => self.scan_installed_plugins(),
            // The installed root itself is unreadable; there is nothing to scan.
            None => Err("installed plugin root is unreadable".into()),
        };
        match rescanned {
            Ok(plugins) => {
                inner.plugin_cache = Some(PluginCache {
                    fingerprint: fingerprint.unwrap_or_default(),
                    plugins: plugins.clone(),
                    stale: false,
                });
                Ok(plugins)
            }
            Err(error) => match inner
                .plugin_cache
                .as_ref()
                .map(|cache| cache.plugins.clone())
            {
                Some(plugins) => {
                    let already_falling_back = inner
                        .plugin_cache
                        .as_ref()
                        .map(|cache| cache.stale)
                        .unwrap_or(true);
                    if let Some(cache) = inner.plugin_cache.as_mut() {
                        cache.stale = true;
                    }
                    if !already_falling_back {
                        self.append_core_event(
                            "global",
                            None,
                            "core.plugin.scan_failed",
                            "Installed-plugin scan failed; serving the last cached plugin set",
                        );
                    }
                    let _ = error;
                    Ok(plugins)
                }
                None => Err(RouterError::Internal(format!(
                    "scan installed plugins: {error}"
                ))),
            },
        }
    }

    fn scan_installed_plugins(&self) -> Result<Vec<Plugin>, String> {
        let mut plugins = Vec::new();
        for entry in std::fs::read_dir(&self.installed_root)
            .map_err(|e| format!("scan installed plugins: {e}"))?
        {
            let entry = entry.map_err(|e| format!("scan install entry: {e}"))?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            let plugin = crate::load_plugin_dir(&entry.path())
                .map_err(|e| format!("invalid installed plugin {}: {e}", entry.path().display()))?;
            if name.to_string_lossy() != plugin.id {
                return Err(format!(
                    "installed directory `{}` does not match plugin id `{}`",
                    name.to_string_lossy(),
                    plugin.id
                ));
            }
            plugins.push(plugin);
        }
        plugins.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(plugins)
    }

    fn manager_snapshot(&self, inner: &mut ServiceInner) -> RouterResult {
        let plugins = self.installed_plugins(inner)?;
        let plugins = plugins
            .iter()
            .map(plugin_metadata_value)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(serde_json::json!({
            "global": { "developerMode": inner.state.global.developer_mode },
            "applications": inner.state.applications,
            "plugins": plugins,
        }))
    }

    fn execution_plan(
        &self,
        inner: &mut ServiceInner,
        application_id: &str,
    ) -> Result<ExecutionPlan, RouterError> {
        let Some(application) = inner.state.applications.get(application_id) else {
            return Ok(empty_plan());
        };
        let application = application.clone();
        if application.support_level == 0 {
            return Ok(empty_plan());
        }
        let supported = capabilities_for_support_level(
            application.support_level,
            inner.state.global.developer_mode,
        );
        let mut grants = Vec::new();
        for mut plugin in self.installed_plugins(inner)? {
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
                    plugin.permissions.contains(grant) && supported.contains(&grant.as_str())
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
                .any(|grant| grant == "renderer.script" || grant == "runtime.unsafe")
            {
                plugin.renderer = None;
            }
            if !plugin
                .permissions
                .iter()
                .any(|grant| grant == "electron.window" || grant == "runtime.unsafe")
            {
                plugin.main = None;
            }
            // Carry the merged config (schema defaults overlaid with stored policy values) into
            // this plan grant. Only enabled plugins reach this point, so a disabled plugin's
            // config is never included in the plan; the snapshot is content-hashed, so a config
            // change alters the plan revision.
            let config = merge_plugin_config(&plugin.config, &policy.config);
            let mut grant = plugin_grant(plugin);
            grant.config = config;
            grants.push(grant);
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

/// Rolling per-application log budget check. `application_id` keys the budget so every launch
/// token of the same application shares one limit. Budgets reset lazily after
/// [`RATE_IDLE_RESET`] of inactivity; restart resets all budgets (DoS-only, accepted).
fn log_rate_available(inner: &mut ServiceInner, application_id: &str, count: usize) -> bool {
    let now = Instant::now();
    let rate = inner
        .log_rates
        .entry(application_id.to_owned())
        .or_insert_with(|| LogRate {
            last_activity: now,
            log_events: VecDeque::new(),
        });
    if rate.last_activity.elapsed() > RATE_IDLE_RESET {
        rate.last_activity = now;
        rate.log_events.clear();
    }
    let cutoff = now - RATE_WINDOW;
    while rate.log_events.front().is_some_and(|time| *time <= cutoff) {
        rate.log_events.pop_front();
    }
    rate.log_events.len() + count <= RATE_MAX_EVENTS
}

fn commit_log_ingest(inner: &mut ServiceInner, application_id: &str, count: usize) {
    if let Some(rate) = inner.log_rates.get_mut(application_id) {
        let now = Instant::now();
        rate.last_activity = now;
        rate.log_events.extend(std::iter::repeat(now).take(count));
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

fn capabilities_for_support_level(level: u8, developer_mode: bool) -> &'static [&'static str] {
    match level {
        1 => IMPLEMENTED_RENDERER_CAPABILITIES,
        2 if developer_mode => IMPLEMENTED_LEVEL_TWO_DEVELOPER_CAPABILITIES,
        2 => IMPLEMENTED_LEVEL_TWO_CAPABILITIES,
        _ => &[],
    }
}

/// Validate an http(s) URL for the `networkRequest` capability. Returns `(lowercased_host,
/// effective_port, url)`, or a `(code, message)` rejection. `http`/`https` schemes only, no
/// credentials, no IPv6 literals (the manifest whitelist cannot contain them), and a real host.
fn validate_request_url(
    url: url::Url,
) -> Result<(String, u16, url::Url), (i32, String)> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err((
            -32003,
            "only http:// and https:// URLs may be requested".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err((-32003, "URLs containing credentials are not allowed".into()));
    }
    if matches!(url.host(), Some(url::Host::Ipv6(_))) {
        return Err((
            -32003,
            "IPv6 literal hosts cannot match a network.domains whitelist".into(),
        ));
    }
    let Some(raw_host) = url.host_str() else {
        return Err((-32003, "url must include a host".into()));
    };
    let Some(port) = url.port_or_known_default() else {
        return Err((-32003, "url must include a port".into()));
    };
    let host = raw_host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err((-32003, "url must include a host".into()));
    }
    Ok((host, port, url))
}

/// Whether `host:port` is allowed by the plugin's lowercased `network.domains` whitelist: an
/// entry without a port matches any effective port of that host; an entry `host:port` must match
/// the effective port exactly; a leading `*.` entry matches the base host and any of its
/// subdomains (never the bare base).
fn domain_allows(host: &str, port: u16, whitelist: &[String]) -> bool {
    whitelist
        .iter()
        .any(|entry| domain_entry_allows(entry, host, port))
}

fn domain_entry_allows(entry: &str, host: &str, port: u16) -> bool {
    let (entry_host, entry_port) = split_domain_entry(entry);
    if let Some(expected) = entry_port {
        if expected != port {
            return false;
        }
    }
    match entry_host.strip_prefix("*.") {
        Some(base) => {
            // host is a strict subdomain of `base` (there is a label boundary before `base`).
            host.len() > base.len()
                && host.ends_with(base)
                && host.as_bytes()[host.len() - base.len() - 1] == b'.'
        }
        None => entry_host == host,
    }
}

/// Split a validated `network.domains` entry (`host` or `host:port`, wildcard preserved) into
/// its lowercased host part and optional port. Entries are canonicalized by manifest validation,
/// so this cannot encounter IPv6 or empty ports.
fn split_domain_entry(entry: &str) -> (&str, Option<u16>) {
    match entry.rfind(':') {
        Some(index) => (&entry[..index], entry[index + 1..].parse().ok()),
        None => (entry, None),
    }
}

fn is_redirect_status(status: u16) -> bool {
    (300..400).contains(&status)
}

fn response_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// HTTP/1.1 token characters (RFC 7230): ASCII letters/digits plus `!#$%&'*+-.^_`|~`.
fn valid_header_name(name: &str) -> bool {
    name.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
    })
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

/// Read a persistent 64-hex secret (control token or launch key) or create it atomically with
/// `create_new` and owner-only permissions. `label` only shapes error messages. On Unix the
/// existing-file read rejects group/other permissions and uses `O_NOFOLLOW | O_CLOEXEC`; on
/// Windows it opens the reparse point itself and rejects non-regular/reparse targets.
fn read_or_create_secret(path: &Path, label: &str) -> Result<String, String> {
    let secret = random_token().map_err(|error| match error {
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
            file.write_all(secret.as_bytes())
                .map_err(|e| format!("write {label}: {e}"))?;
            file.sync_all().map_err(|e| format!("sync {label}: {e}"))?;
            Ok(secret)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_existing_secret(path, label)
        }
        Err(error) => Err(format!("create {label}: {error}")),
    }
}

fn read_existing_secret(path: &Path, label: &str) -> Result<String, String> {
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
        .map_err(|e| format!("open {label} safely: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("inspect {label}: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{label} must be a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return Err(format!("{label} permissions must be owner-only"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("{label} must not be a reparse point"));
        }
    }
    use std::io::Read;
    let mut secret = String::new();
    file.read_to_string(&mut secret)
        .map_err(|e| format!("read {label}: {e}"))?;
    let secret = secret.trim().to_string();
    if secret.len() == 64 && secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(secret)
    } else {
        Err(format!("invalid {label}"))
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
        // The declared config schema, so the Manager can render a per-plugin settings form.
        "config": plugin.config,
    }))
}

/// Merge a plugin's stored config into its full effective config for one application: schema
/// defaults overlaid with stored values, restricted to schema-declared keys. A stored value wins
/// over the schema default when both exist; a non-schema stored key (e.g. left over after the
/// plugin manifest dropped a field) is ignored.
fn merge_plugin_config(
    schema_fields: &BTreeMap<String, ConfigField>,
    stored: &BTreeMap<String, serde_json::Value>,
) -> BTreeMap<String, serde_json::Value> {
    let mut merged = BTreeMap::new();
    for (key, field) in schema_fields {
        let value = stored.get(key).cloned().or_else(|| field.default.clone());
        if let Some(value) = value {
            merged.insert(key.clone(), value);
        }
    }
    merged
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

fn now_unix_seconds() -> Result<u64, ()> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| ())
}

fn is_application_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix(APPLICATION_ID_PREFIX) else {
        return false;
    };
    digest.len() == 64 && is_lowercase_hex(digest)
}

/// Launch-token payload: `v1.<application_id>.<issued_at_secs>.<nonce>`.
fn launch_token_payload(application_id: &str, issued_at: u64, nonce: &str) -> String {
    format!("{}.{}.{}.{}", "v1", application_id, issued_at, nonce)
}

fn launch_token_mac(launch_key: &str, payload: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(launch_key.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(payload.as_bytes());
    hex(&mac.finalize().into_bytes())
}

/// Sign a launch token for `application_id` issued at `now` (unix seconds) with `nonce`
/// (16 lowercase hex). Pure: given identical inputs it always produces the same token.
fn sign_launch_token(launch_key: &str, application_id: &str, now_secs: u64, nonce: &str) -> String {
    let payload = launch_token_payload(application_id, now_secs, nonce);
    format!("{payload}.{}", launch_token_mac(launch_key, &payload))
}

/// Mint a fresh launch token for `application_id` issued at `now` with a fresh 8-byte nonce.
fn mint_launch_token(
    now_secs: u64,
    launch_key: &str,
    application_id: &str,
) -> Result<String, RouterError> {
    let mut nonce = [0_u8; 8];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|e| RouterError::Internal(format!("secure token nonce: {e}")))?;
    Ok(sign_launch_token(
        launch_key,
        application_id,
        now_secs,
        &hex(&nonce),
    ))
}

/// Verify a self-contained launch token at `now_secs` (unix seconds). Returns the claims only
/// when the signature is valid, the structure matches, and `issued_at` is not more than 5s in
/// the future (clock-skew tolerance). Age-based authorization is applied by the caller.
fn verify_launch_token(now_secs: u64, launch_key: &str, token: &str) -> Option<LaunchClaims> {
    let (payload, mac) = token.rsplit_once('.')?;
    if !is_lowercase_hex(mac) || mac.len() != 64 {
        return None;
    }
    let expected = launch_token_mac(launch_key, payload);
    if !constant_time_eq(mac.as_bytes(), expected.as_bytes()) {
        return None;
    }
    let mut segments = payload.split('.');
    let version = segments.next()?;
    let application_id = segments.next()?;
    let issued_at = segments.next()?.parse::<u64>().ok()?;
    let nonce = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    if version != "v1" || !is_application_id(application_id) {
        return None;
    }
    if nonce.len() != 16 || !is_lowercase_hex(nonce) {
        return None;
    }
    if issued_at > now_secs.saturating_add(TOKEN_FUTURE_TOLERANCE_SECS) {
        return None;
    }
    Some(LaunchClaims {
        application_id: application_id.to_owned(),
        issued_at,
    })
}

/// Recursive content fingerprint of a plugin tree: sorted `(relpath, kind, size, mtime_ns)`
/// lines hashed via the crate's stable hash. Detects additions, deletions, and content/mtime
/// changes. Symlinks are recorded as leaf entries but never traversed, so a directory symlink
/// cannot cause infinite recursion.
fn fingerprint(root: &Path) -> Result<String, String> {
    let mut entries = Vec::new();
    collect_fingerprint(root, "", &mut entries)?;
    entries.sort();
    Ok(hash_bytes(entries.join("\n").as_bytes()))
}

fn collect_fingerprint(dir: &Path, rel: &str, out: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read plugin dir: {e}"))? {
        let entry = entry.map_err(|e| format!("plugin dir entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel_path = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let file_type = entry
            .file_type()
            .map_err(|e| format!("plugin entry type: {e}"))?;
        if file_type.is_dir() {
            collect_fingerprint(&path, &rel_path, out)?;
            let mtime_ns = file_mtime_ns(&entry)?;
            out.push(format!("{rel_path}/\t0\t{mtime_ns}"));
        } else if file_type.is_file() {
            let meta = entry
                .metadata()
                .map_err(|e| format!("plugin file metadata: {e}"))?;
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            out.push(format!("{rel_path}\t{}\t{}", meta.len(), mtime_ns));
        } else {
            // Symlinks and other special files count as opaque leaves (size of the link target
            // metadata, which DirEntry::metadata reports without following).
            let meta = entry
                .metadata()
                .map_err(|e| format!("plugin entry metadata: {e}"))?;
            let mtime_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            out.push(format!("{rel_path}*\t{}\t{mtime_ns}", meta.len()));
        }
    }
    Ok(())
}

fn file_mtime_ns(entry: &std::fs::DirEntry) -> Result<u128, String> {
    let meta = entry
        .metadata()
        .map_err(|e| format!("plugin dir metadata: {e}"))?;
    Ok(meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0))
}

pub fn serve_service(port: u16, service: std::sync::Arc<CoreService>) -> std::io::Result<()> {
    tronhawk_ipc::serve(port, move |request| service.handle_request(request))
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
            self.package_with_permissions(
                directory,
                id,
                version,
                &[
                    "renderer.css",
                    "renderer.script",
                    "renderer.dom",
                    "electron.window",
                    "runtime.unsafe",
                ],
            )
        }

        /// A fixture identical to [`package`] except it does NOT declare `runtime.unsafe`, for
        /// tests that assert grants must still be requested by the plugin manifest.
        fn package_without_unsafe(&self, directory: &str, id: &str, version: &str) -> PathBuf {
            self.package_with_permissions(
                directory,
                id,
                version,
                &[
                    "renderer.css",
                    "renderer.script",
                    "renderer.dom",
                    "electron.window",
                ],
            )
        }

        fn package_with_permissions(
            &self,
            directory: &str,
            id: &str,
            version: &str,
            permissions: &[&str],
        ) -> PathBuf {
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
                "permissions": permissions,
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

        /// A fixture like [`package`] whose manifest also declares a per-plugin `config` schema.
        fn package_with_config(
            &self,
            directory: &str,
            id: &str,
            version: &str,
            config: serde_json::Value,
        ) -> PathBuf {
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
                    "runtime.unsafe",
                ],
                "css": "body{}",
                "entry": {
                    "renderer": "renderer.js",
                    "main": "main.js"
                },
                "config": config,
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

        /// A fixture like [`package`] whose manifest declares the `network.access` permission
        /// (plus `renderer.css`, so a policy can put the plugin in a plan without granting
        /// `network.access` — for grant-rejection tests) and a `network.domains` allowlist.
        fn package_with_network(
            &self,
            directory: &str,
            id: &str,
            version: &str,
            domains: &[&str],
        ) -> PathBuf {
            let source = self.0.join(directory);
            std::fs::create_dir_all(&source).unwrap();
            std::fs::write(source.join("renderer.js"), "renderer source").unwrap();
            let manifest = serde_json::json!({
                "id": id,
                "name": "Daemon test plugin",
                "version": version,
                "author": "Test",
                "tronhawk": "^0.1",
                "permissions": ["renderer.css", "network.access"],
                "network": { "domains": domains },
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

    fn error_message(response: tronhawk_ipc::Response) -> String {
        match response.result {
            ResponseResult::Err { error } => error.message,
            ResponseResult::Ok { result } => panic!("unexpected RPC result: {result}"),
        }
    }

    /// A manifest `config` schema exercising every scalar type, each with a default.
    fn config_schema() -> serde_json::Value {
        serde_json::json!({
            "opacity": { "type": "number", "default": 0.8 },
            "mode": { "type": "string", "default": "auto" },
            "debug": { "type": "boolean", "default": false },
            "title": { "type": "string", "default": "glass" },
        })
    }

    fn config_merged_defaults() -> serde_json::Value {
        serde_json::json!({
            "opacity": 0.8,
            "mode": "auto",
            "debug": false,
            "title": "glass",
        })
    }

    fn get_plugin_config(
        service: &CoreService,
        secret: &str,
        application_id: &str,
        plugin_id: &str,
    ) -> tronhawk_ipc::Response {
        call(
            service,
            secret,
            "getPluginConfig",
            serde_json::json!({
                "applicationId": application_id,
                "pluginId": plugin_id,
            }),
        )
    }

    fn set_plugin_config(
        service: &CoreService,
        secret: &str,
        application_id: &str,
        plugin_id: &str,
        config: serde_json::Value,
    ) -> tronhawk_ipc::Response {
        call(
            service,
            secret,
            "setPluginConfig",
            serde_json::json!({
                "applicationId": application_id,
                "pluginId": plugin_id,
                "config": config,
            }),
        )
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
    fn plugin_logs_must_target_plugins_in_the_current_plan() {
        let temp = TempRoot::new("plugin-log-plan");
        let app = temp.executable("Plan.exe");
        let package = temp.package("log-plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &app, 2);
        install_package(&service, &control, &package);
        let token = launch_token(&service, &control, &app);
        let params = serde_json::json!({
            "events": [{
                "pluginId": "com.example.daemon",
                "level": "error",
                "message": "plugin event"
            }]
        });
        let params_for_unknown = serde_json::json!({
            "events": [{
                "pluginId": "com.example.not-granted",
                "level": "error",
                "message": "plugin event"
            }]
        });

        // A plugin that is not in the CURRENT plan (default-deny until enabled) is rejected,
        // with no need to call getExecutionPlan first.
        assert_eq!(
            error_code(call(&service, &token, "appendPluginLogs", params.clone())),
            -32003
        );

        // Enable with a grant: now the same plugin_id is in the current plan and accepted.
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        assert_eq!(
            ok(call(&service, &token, "appendPluginLogs", params.clone()))["accepted"],
            1
        );

        // A plugin_id outside the current plan is rejected even while the app has the daemon
        // plugin enabled.
        assert_eq!(
            error_code(call(
                &service,
                &token,
                "appendPluginLogs",
                params_for_unknown.clone()
            )),
            -32003
        );

        // Disabling the policy revokes the grant immediately: the very next append is rejected
        // without any further getExecutionPlan round-trip.
        ok(set_policy(&service, &control, &application_id, false, &[]));
        assert_eq!(
            error_code(call(&service, &token, "appendPluginLogs", params.clone())),
            -32003
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
        {
            let mut inner = service.inner.lock().unwrap();
            assert_eq!(
                service.installed_plugins(&mut inner).unwrap()[0].version,
                "1.0.0"
            );
        }
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
                    config: BTreeMap::new(),
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
    fn launch_token_pure_roundtrip_and_tamper_rejection() {
        let key = "ab".repeat(32);
        let app_id = format!("winexe-v1:{}", "c".repeat(64));
        let now = 1_700_000_000_u64;

        // Valid round-trip.
        let token = sign_launch_token(&key, &app_id, now, "deadbeefdeadbeef");
        let claims = verify_launch_token(now, &key, &token).expect("valid token verifies");
        assert_eq!(claims.application_id, app_id);
        assert_eq!(claims.issued_at, now);
        // `issued_at` exactly `now` and within +5s tolerance is accepted.
        assert!(verify_launch_token(now, &key, &token).is_some());

        // Tampered application_id segment -> reject.
        let other_app = format!("winexe-v1:{}", "d".repeat(64));
        let tampered_payload = launch_token_payload(&other_app, now, "deadbeefdeadbeef");
        let tampered_app = format!("{tampered_payload}.{}", token.rsplit_once('.').unwrap().1);
        assert!(verify_launch_token(now, &key, &tampered_app).is_none());

        // Tampered mac -> reject.
        let mut tampered_mac = token.clone();
        let last = tampered_mac.pop().unwrap();
        let replacement = if last == '0' { '1' } else { '0' };
        tampered_mac.push(replacement);
        assert!(verify_launch_token(now, &key, &tampered_mac).is_none());

        // Wrong key -> reject (covers deleting/rotating launch.key).
        assert!(verify_launch_token(now, &"ff".repeat(32), &token).is_none());

        // issued_at more than 5s in the future -> reject.
        let future = sign_launch_token(&key, &app_id, now + 10, "deadbeefdeadbeef");
        assert!(verify_launch_token(now, &key, &future).is_none());

        // Malformed structure -> reject.
        assert!(verify_launch_token(now, &key, "not-a-token").is_none());
        assert!(verify_launch_token(now, &key, "v1.app.123.abc.deadbeef").is_none());

        // Nonce uniqueness: two mints at the same instant differ but both verify.
        let first = mint_launch_token(now, &key, &app_id).unwrap();
        let second = mint_launch_token(now, &key, &app_id).unwrap();
        assert_ne!(first, second);
        assert!(verify_launch_token(now, &key, &first).is_some());
        assert!(verify_launch_token(now, &key, &second).is_some());
    }

    fn read_launch_key(temp: &TempRoot) -> String {
        std::fs::read_to_string(temp.0.join("config/launch.key"))
            .unwrap()
            .trim()
            .to_string()
    }

    fn launch_token_signed_at(launch_key: &str, application_id: &str, issued_at: u64) -> String {
        sign_launch_token(launch_key, application_id, issued_at, "deadbeefdeadbeef")
    }

    #[test]
    fn launch_token_freshness_windows_and_renewal() {
        let temp = TempRoot::new("token-windows");
        let executable = temp.executable("App.exe");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        let launch_key = read_launch_key(&temp);
        let now = now_unix_seconds().unwrap();

        // Fresh minted token is accepted and is self-contained (not a 64-hex random id).
        let launch = ok(call(
            &service,
            &control,
            "createLaunchSession",
            serde_json::json!({ "executablePath": executable }),
        ));
        let fresh = launch["token"].as_str().unwrap().to_string();
        assert_eq!(launch["expiresAfterIdleSeconds"], 600);
        assert_eq!(launch["applicationId"], application_id);
        assert_ne!(fresh.len(), 64);
        assert!(verify_launch_token(now, &launch_key, &fresh).is_some());
        assert!(plan(&service, &fresh)["plugins"].is_array());

        // issued_at = now - 601s: normal methods are rejected...
        let idle_expired = launch_token_signed_at(&launch_key, &application_id, now - 601);
        assert_eq!(
            error_code(call(
                &service,
                &idle_expired,
                "getExecutionPlan",
                serde_json::json!({}),
            )),
            -32001
        );
        // ...but renewSession still works and the fresh token is usable...
        let renewed = ok(call(
            &service,
            &idle_expired,
            "renewSession",
            serde_json::json!({}),
        ));
        let renewed_token = renewed["token"].as_str().unwrap().to_string();
        assert_eq!(renewed["applicationId"], application_id);
        assert_eq!(renewed["expiresAfterIdleSeconds"], 600);
        assert_ne!(renewed_token, idle_expired);
        assert!(plan(&service, &renewed_token)["plugins"].is_array());

        // renewSession with non-empty params is rejected.
        assert_eq!(
            error_code(call(
                &service,
                &idle_expired,
                "renewSession",
                serde_json::json!({ "unexpected": true }),
            )),
            -32602
        );

        // issued_at = now - 25h: renewSession is also rejected (absolute 24h cap).
        let ancient = launch_token_signed_at(&launch_key, &application_id, now - 25 * 3600);
        assert_eq!(
            error_code(call(
                &service,
                &ancient,
                "renewSession",
                serde_json::json!({}),
            )),
            -32001
        );
        assert_eq!(
            error_code(call(
                &service,
                &ancient,
                "getExecutionPlan",
                serde_json::json!({}),
            )),
            -32001
        );
        drop(service);
    }

    #[test]
    fn launch_token_survives_service_restart() {
        let temp = TempRoot::new("restart-token");
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
        let token = launch_token(&service, &control, &executable);
        assert_eq!(
            plan(&service, &token)["plugins"].as_array().unwrap().len(),
            1
        );
        drop(service);

        // A restarted daemon over the same root still accepts the SAME token (DUR-1 regression:
        // sessions used to be in-memory and died with the process).
        let rebuilt = CoreService::new(&temp.0).unwrap();
        assert_eq!(
            plan(&rebuilt, &token)["plugins"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn launch_key_is_persistent_distinct_from_control_and_rotation_invalidates_tokens() {
        let temp = TempRoot::new("launch-key-rotate");
        let executable = temp.executable("App.exe");
        let (service, control) = service(&temp);
        register(&service, &control, &executable, 2);
        let launch_key = read_launch_key(&temp);
        assert_eq!(launch_key.len(), 64);
        assert!(is_lowercase_hex(&launch_key));
        assert_ne!(
            launch_key, control,
            "launch key must never equal the control token"
        );
        let token = launch_token(&service, &control, &executable);
        drop(service);

        // Deleting/rotating launch.key invalidates existing tokens.
        let replacement = format!("{:016x}", 0x0123_4567_89ab_cdef_u64).repeat(4);
        std::fs::write(temp.0.join("config/launch.key"), replacement).unwrap();
        let rotated = CoreService::new(&temp.0).unwrap();
        assert_eq!(
            error_code(call(
                &rotated,
                &token,
                "getExecutionPlan",
                serde_json::json!({}),
            )),
            -32001,
            "a token minted under the old key must stop verifying after rotation"
        );
        let relaunch = ok(call(
            &rotated,
            &control,
            "createLaunchSession",
            serde_json::json!({ "executablePath": executable }),
        ));
        assert!(plan(&rotated, relaunch["token"].as_str().unwrap())["plugins"].is_array());
    }

    #[test]
    fn launch_key_rejects_non_regular_file() {
        let temp = TempRoot::new("launch-key-nonregular");
        let launch_key_path = temp.0.join("config/launch.key");
        std::fs::create_dir_all(&launch_key_path).unwrap();
        assert!(CoreService::new(&temp.0).is_err());
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
    fn plugin_cache_picks_up_source_edits_and_stays_stable_while_unchanged() {
        let temp = TempRoot::new("cache-edit");
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
            &["renderer.script"],
        ));
        let token = launch_token(&service, &control, &executable);
        let installed_dir = temp
            .0
            .join("plugins")
            .join("installed")
            .join("com.example.daemon");

        let first = plan(&service, &token);
        let revision = first["revision"].as_str().unwrap().to_string();
        assert_eq!(first["plugins"][0]["renderer"], "renderer source");

        // Unchanged polls stay stable (fingerprint cache hit).
        assert_eq!(plan(&service, &token)["revision"], revision);
        assert_eq!(plan(&service, &token)["revision"], revision);

        // Editing the plugin source (size change) must change the next plan within 2 polls.
        std::fs::write(
            installed_dir.join("renderer.js"),
            "renderer source v2 — longer",
        )
        .unwrap();
        let after_edit = plan(&service, &token);
        let after_edit_revision = after_edit["revision"].as_str().unwrap().to_string();
        assert_ne!(
            after_edit_revision, revision,
            "source edit must change the plan revision"
        );
        assert_eq!(
            after_edit["plugins"][0]["renderer"],
            "renderer source v2 — longer"
        );
        assert_eq!(plan(&service, &token)["revision"], after_edit_revision);
        drop(service);
    }

    #[test]
    fn plugin_scan_failure_falls_back_to_last_good_cache() {
        let temp = TempRoot::new("cache-stale");
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
        let token = launch_token(&service, &control, &executable);
        let installed_dir = temp
            .0
            .join("plugins")
            .join("installed")
            .join("com.example.daemon");

        // Warm the cache.
        let warmed = plan(&service, &token);
        assert_eq!(warmed["plugins"][0]["id"], "com.example.daemon");

        // Damage the plugin directory out-of-band so a rescan fails (manifest removed) while the
        // directory still exists. The daemon must keep serving the last good plan instead of
        // erroring (availability-first).
        std::fs::remove_file(installed_dir.join("manifest.json")).unwrap();
        let stale = plan(&service, &token);
        assert_eq!(
            stale["plugins"][0]["id"], "com.example.daemon",
            "stale cache fallback must still return the last plan"
        );
        // A manager snapshot must also remain available.
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert_eq!(snapshot["plugins"][0]["id"], "com.example.daemon");
        drop(service);
    }

    #[test]
    fn install_and_remove_are_immediately_reflected_in_plans() {
        let temp = TempRoot::new("cache-install-remove");
        let executable = temp.executable("App.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        let token = launch_token(&service, &control, &executable);
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());

        // InstallPlugin must be visible to the very next plan poll.
        install_package(&service, &control, &package);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        assert_eq!(
            plan(&service, &token)["plugins"].as_array().unwrap().len(),
            1
        );

        // removePlugin must be gone from the very next plan poll.
        ok(call(
            &service,
            &control,
            "removePlugin",
            serde_json::json!({ "pluginId": "com.example.daemon" }),
        ));
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());
        drop(service);
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

    #[test]
    fn set_developer_mode_control_auth_and_idempotence() {
        let temp = TempRoot::new("dev-mode-control");
        let executable = temp.executable("Dev.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);

        // setDeveloperMode is a control-token-only RPC: a launch token is forbidden.
        let token = launch_token(&service, &control, &executable);
        assert_eq!(
            error_code(call(
                &service,
                &token,
                "setDeveloperMode",
                serde_json::json!({ "enabled": true }),
            )),
            -32003
        );

        // Malformed params: missing field, unknown field, and wrong type all fail validation.
        for params in [
            serde_json::json!({}),
            serde_json::json!({ "enabled": true, "extra": false }),
            serde_json::json!({ "enabled": "yes" }),
            serde_json::json!({ "enabled": null }),
        ] {
            assert_eq!(
                error_code(call(&service, &control, "setDeveloperMode", params)),
                -32602
            );
        }

        // Enable returns the new state; a repeated identical call is idempotent.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setDeveloperMode",
                serde_json::json!({ "enabled": true }),
            )),
            serde_json::json!({ "developerMode": true })
        );
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setDeveloperMode",
                serde_json::json!({ "enabled": true }),
            )),
            serde_json::json!({ "developerMode": true })
        );
        // The manager snapshot exposes the flag...
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert_eq!(snapshot["global"]["developerMode"], true);
        // ...and exactly one core event records the enable (the idempotent repeat emits none,
        // and the code round-trips through the log store's Core allowlist).
        let logs = query_logs(&service, &control);
        let updates = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["code"] == "core.developerMode.updated")
            .collect::<Vec<_>>();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["message"], "Developer mode enabled");
        assert_eq!(updates[0]["stream"], "core");
        assert_eq!(updates[0]["applicationId"], "global");

        // Developer mode is durable across a CoreService rebuild.
        drop(service);
        let rebuilt = CoreService::new(&temp.0).unwrap();
        let rebuilt_control = std::fs::read_to_string(rebuilt.control_token_path()).unwrap();
        let snapshot = ok(call(
            &rebuilt,
            &rebuilt_control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert_eq!(snapshot["global"]["developerMode"], true);

        // While enabled runtime.unsafe can be granted; disabling then purges it from the policy
        // and persists the purge.
        ok(set_policy(
            &rebuilt,
            &rebuilt_control,
            &application_id,
            true,
            &["runtime.unsafe"],
        ));
        assert_eq!(
            ok(call(
                &rebuilt,
                &rebuilt_control,
                "setDeveloperMode",
                serde_json::json!({ "enabled": false }),
            )),
            serde_json::json!({ "developerMode": false })
        );
        let logs = query_logs(&rebuilt, &rebuilt_control);
        let disabled = logs["events"].as_array().unwrap().iter().any(|event| {
            event["code"] == "core.developerMode.updated"
                && event["message"] == "Developer mode disabled; runtime.unsafe grants revoked"
        });
        assert!(disabled);
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["global"]["developerMode"], false);
        let policy = &persisted["applications"][&application_id]["plugins"]["com.example.daemon"];
        assert_eq!(policy["enabled"], true);
        assert!(policy["grants"].as_array().unwrap().is_empty());
    }

    #[test]
    fn runtime_unsafe_requires_developer_mode_end_to_end() {
        let temp = TempRoot::new("dev-mode-grant-flow");
        let executable = temp.executable("App.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);

        // Developer mode off: runtime.unsafe cannot be granted.
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["runtime.unsafe"],
            )),
            -32602
        );

        // Developer mode on (Level 2 app): the same grant is accepted.
        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": true }),
        ));
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["runtime.unsafe"],
        ));

        // The execution plan ships the plugin with runtime.unsafe granted and its source intact
        // (runtime.unsafe unlocks main/renderer payloads instead of filtering the plugin out).
        let token = launch_token(&service, &control, &executable);
        let dev_on = plan(&service, &token);
        assert_eq!(dev_on["plugins"][0]["id"], "com.example.daemon");
        assert_eq!(
            dev_on["plugins"][0]["granted"],
            serde_json::json!(["runtime.unsafe"])
        );
        assert_eq!(dev_on["plugins"][0]["main"], "main source");
        assert_eq!(dev_on["plugins"][0]["renderer"], "renderer source");

        // Developer mode off again: the grant is filtered out of the plan AND purged from the
        // persisted policy; re-granting afterwards fails.
        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": false }),
        ));
        let dev_off = plan(&service, &token);
        assert!(dev_off["plugins"].as_array().unwrap().is_empty());
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["global"]["developerMode"], false);
        assert!(
            persisted["applications"][&application_id]["plugins"]["com.example.daemon"]["grants"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["runtime.unsafe"],
            )),
            -32602
        );
    }

    #[test]
    fn developer_mode_does_not_bypass_support_levels() {
        let temp = TempRoot::new("dev-mode-no-bypass");
        let executable = temp.executable("One.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 1);
        install_package(&service, &control, &package);

        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": true }),
        ));
        // Level 1 never gets runtime.unsafe, even with Developer mode on.
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["runtime.unsafe"],
            )),
            -32602
        );
        // Level-2-only capabilities remain gated for a Level 1 app under Developer mode.
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["electron.window"],
            )),
            -32602
        );
        // Normal Level 1 grants still work while Developer mode is on.
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
    }

    #[test]
    fn developer_mode_keeps_must_be_requested() {
        let temp = TempRoot::new("dev-mode-must-request");
        let executable = temp.executable("App.exe");
        // This fixture does NOT declare runtime.unsafe in its manifest.
        let package = temp.package_without_unsafe("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);

        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": true }),
        ));
        // Even with Developer mode on, an undeclared capability cannot be granted.
        assert_eq!(
            error_code(set_policy(
                &service,
                &control,
                &application_id,
                true,
                &["runtime.unsafe"],
            )),
            -32602
        );
    }

    #[test]
    fn developer_mode_toggle_changes_plan_revision() {
        let temp = TempRoot::new("dev-mode-revision");
        let executable = temp.executable("App.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);

        // Developer mode on, plugin granted both a normal and the unsafe capability.
        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": true }),
        ));
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css", "runtime.unsafe"],
        ));
        let token = launch_token(&service, &control, &executable);
        let dev_on = plan(&service, &token);
        assert_eq!(
            dev_on["plugins"][0]["granted"],
            serde_json::json!(["renderer.css", "runtime.unsafe"])
        );

        // The same app + plugin yields a different revision once Developer mode is off, so a
        // Runtime polling on its token sees the change and revokes/re-syncs its plugin set.
        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": false }),
        ));
        let dev_off = plan(&service, &token);
        assert_eq!(
            dev_off["plugins"][0]["granted"],
            serde_json::json!(["renderer.css"])
        );
        assert_ne!(dev_off["revision"], dev_on["revision"]);
    }

    // --- Per-plugin config (PluginPolicy.config / getPluginConfig / setPluginConfig) ----------

    #[test]
    fn plugin_config_rpcs_are_control_only_and_validate_targets() {
        let temp = TempRoot::new("config-auth");
        let executable = temp.executable("App.exe");
        let package =
            temp.package_with_config("plugin", "com.example.daemon", "1.0.0", config_schema());
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);
        let token = launch_token(&service, &control, &executable);

        // Launch tokens are forbidden from the config control-plane RPCs (-32003, same fall-through
        // as the other control methods).
        for method in ["getPluginConfig", "setPluginConfig"] {
            assert_eq!(
                error_code(call(
                    &service,
                    &token,
                    method,
                    serde_json::json!({
                        "applicationId": application_id,
                        "pluginId": "com.example.daemon",
                        "config": {},
                    }),
                )),
                -32003,
                "{method} must be control-token only"
            );
        }

        // Unknown application -> -32602.
        assert_eq!(
            error_code(get_plugin_config(
                &service,
                &control,
                "winexe-v1:missing",
                "com.example.daemon",
            )),
            -32602
        );
        assert_eq!(
            error_code(set_plugin_config(
                &service,
                &control,
                "winexe-v1:missing",
                "com.example.daemon",
                serde_json::json!({}),
            )),
            -32602
        );
        // Installed-plugin lookup: unknown plugin id -> -32602.
        assert_eq!(
            error_code(get_plugin_config(
                &service,
                &control,
                &application_id,
                "com.example.gone"
            )),
            -32602
        );
        assert_eq!(
            error_code(set_plugin_config(
                &service,
                &control,
                &application_id,
                "com.example.gone",
                serde_json::json!({}),
            )),
            -32602
        );
        // Missing params and malformed config values -> -32602.
        assert_eq!(
            error_code(call(
                &service,
                &control,
                "getPluginConfig",
                serde_json::json!({ "applicationId": application_id }),
            )),
            -32602
        );
        assert_eq!(
            error_code(call(
                &service,
                &control,
                "setPluginConfig",
                serde_json::json!({
                    "applicationId": application_id,
                    "pluginId": "com.example.daemon",
                    "config": "not-an-object",
                }),
            )),
            -32602
        );
    }

    #[test]
    fn plugin_config_validation_rejects_unknown_keys_type_mismatches_and_oversized_strings() {
        let temp = TempRoot::new("config-validation");
        let executable = temp.executable("App.exe");
        let package =
            temp.package_with_config("plugin", "com.example.daemon", "1.0.0", config_schema());
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);

        // Unknown key -> -32602 naming the key.
        let response = set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "bogus": 1 }),
        );
        assert_eq!(error_code(response.clone()), -32602);
        assert!(
            error_message(response).contains("bogus"),
            "message must name the key"
        );
        // A key absent from the schema is rejected even when the value is well typed.
        assert_eq!(
            error_code(set_plugin_config(
                &service,
                &control,
                &application_id,
                "com.example.daemon",
                serde_json::json!({ "opacity": 0.5, "extra": "x" }),
            )),
            -32602
        );

        // Type mismatches -> -32602 (message names the offending key).
        for (config, expected) in [
            (serde_json::json!({ "opacity": "high" }), "opacity"),
            (serde_json::json!({ "mode": 7 }), "mode"),
            (serde_json::json!({ "debug": 1 }), "debug"),
            (serde_json::json!({ "title": ["a"] }), "title"),
        ] {
            let response = set_plugin_config(
                &service,
                &control,
                &application_id,
                "com.example.daemon",
                config,
            );
            assert_eq!(error_code(response.clone()), -32602);
            assert!(
                error_message(response).contains(expected),
                "message must name the key"
            );
        }

        // A string value over 4096 bytes -> -32602.
        let oversized = set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "title": "x".repeat(4097) }),
        );
        assert_eq!(error_code(oversized.clone()), -32602);
        assert!(error_message(oversized).contains("4096"));

        // No config is persisted by any rejected write.
        assert_eq!(
            ok(get_plugin_config(
                &service,
                &control,
                &application_id,
                "com.example.daemon"
            ))["config"],
            config_merged_defaults()
        );
    }

    #[test]
    fn plugin_config_merge_semantics_replace_and_persist_across_rebuild() {
        let temp = TempRoot::new("config-merge");
        let executable = temp.executable("App.exe");
        let package =
            temp.package_with_config("plugin", "com.example.daemon", "1.0.0", config_schema());
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);

        // Nothing stored yet: get returns the schema defaults merged, schema keys only.
        let get = |service: &CoreService, secret: &str| -> serde_json::Value {
            ok(get_plugin_config(
                service,
                secret,
                &application_id,
                "com.example.daemon",
            ))["config"]
                .clone()
        };
        assert_eq!(get(&service, &control), config_merged_defaults());

        // A partial set returns defaults overlaid by the new stored values…
        let partial = ok(set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "opacity": 0.5, "mode": "fast" }),
        ));
        assert_eq!(
            partial["config"],
            serde_json::json!({
                "opacity": 0.5,
                "mode": "fast",
                "debug": false,
                "title": "glass",
            })
        );
        // …and subsequent gets reflect exactly the same merged shape.
        assert_eq!(
            get(&service, &control),
            serde_json::json!({
                "opacity": 0.5,
                "mode": "fast",
                "debug": false,
                "title": "glass",
            })
        );

        // setPluginConfig REPLACES the whole stored object: setting one key drops the others, so
        // the merged result falls back to defaults for every key not in the new object.
        let replaced = ok(set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "debug": true }),
        ));
        assert_eq!(
            replaced["config"],
            serde_json::json!({
                "opacity": 0.8,
                "mode": "auto",
                "debug": true,
                "title": "glass",
            })
        );

        // A stored key that is not schema-declared (e.g. left over from an older manifest) is
        // ignored by the merge: only schema keys are returned.
        {
            let mut inner = service.inner.lock().unwrap();
            inner
                .state
                .applications
                .get_mut(&application_id)
                .unwrap()
                .plugins
                .get_mut("com.example.daemon")
                .unwrap()
                .config
                .insert("ghost".to_string(), serde_json::json!("leftover"));
        }
        assert_eq!(
            get(&service, &control),
            serde_json::json!({
                "opacity": 0.8,
                "mode": "auto",
                "debug": true,
                "title": "glass",
            })
        );

        // A set persists across a service rebuild (whole replacement drops the ghost key too).
        ok(set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "opacity": 0.9 }),
        ));
        drop(service);
        let rebuilt = CoreService::new(&temp.0).unwrap();
        let persisted_control = std::fs::read_to_string(rebuilt.control_token_path()).unwrap();
        assert_eq!(
            get(&rebuilt, &persisted_control),
            serde_json::json!({
                "opacity": 0.9,
                "mode": "auto",
                "debug": false,
                "title": "glass",
            })
        );

        // Every successful set emitted the core event with the right attribution.
        let logs = query_logs(&rebuilt, &persisted_control);
        let updates = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["code"] == "core.plugin_config.updated")
            .collect::<Vec<_>>();
        assert_eq!(updates.len(), 3);
        assert!(updates.iter().all(|event| {
            event["applicationId"] == application_id
                && event["pluginId"] == "com.example.daemon"
                && event["message"] == "Plugin config updated"
        }));
    }

    #[test]
    fn plugin_config_reaches_the_plan_revision_and_is_absent_when_disabled() {
        let temp = TempRoot::new("config-plan");
        let executable = temp.executable("App.exe");
        let package =
            temp.package_with_config("plugin", "com.example.daemon", "1.0.0", config_schema());
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
        let token = launch_token(&service, &control, &executable);

        // The enabled plugin's grant carries the merged config snapshot.
        let before = plan(&service, &token);
        assert_eq!(
            before["plugins"][0]["config"],
            config_merged_defaults(),
            "the plan grant must carry the merged config"
        );
        let before_revision = before["revision"].as_str().unwrap().to_string();

        // Changing config changes the plan revision and the grant carries the new merged values.
        ok(set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "opacity": 0.33, "mode": "fast", "debug": true, "title": "custom" }),
        ));
        let after = plan(&service, &token);
        assert_ne!(
            after["revision"], before_revision,
            "config change must bump the revision"
        );
        assert_eq!(
            after["plugins"][0]["config"],
            serde_json::json!({
                "opacity": 0.33,
                "mode": "fast",
                "debug": true,
                "title": "custom",
            })
        );

        // A disabled plugin is not in the plan at all, so its config is never included.
        ok(set_policy(&service, &control, &application_id, false, &[]));
        assert!(plan(&service, &token)["plugins"]
            .as_array()
            .unwrap()
            .is_empty());

        // Re-enabling the plugin brings the stored config back into the plan.
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));
        let reenabled = plan(&service, &token);
        assert_eq!(
            reenabled["plugins"][0]["config"],
            serde_json::json!({
                "opacity": 0.33,
                "mode": "fast",
                "debug": true,
                "title": "custom",
            })
        );
    }

    #[test]
    fn set_policy_preserves_plugin_config() {
        // Regression: setApplicationPluginPolicy rebuilds the PluginPolicy from enabled + grants;
        // a grant-toggle must never wipe the stored per-plugin config.
        let temp = TempRoot::new("config-set-policy");
        let executable = temp.executable("App.exe");
        let package =
            temp.package_with_config("plugin", "com.example.daemon", "1.0.0", config_schema());
        let (service, control) = service(&temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);
        ok(set_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
            serde_json::json!({ "opacity": 0.5, "mode": "fast" }),
        ));

        // Toggle disabled → enabled (and an unrelated re-registration at the same level): the
        // config must survive every policy rebuild.
        ok(set_policy(&service, &control, &application_id, false, &[]));
        register(&service, &control, &executable, 2);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            &["renderer.css"],
        ));

        let merged = ok(get_plugin_config(
            &service,
            &control,
            &application_id,
            "com.example.daemon",
        ));
        assert_eq!(
            merged["config"],
            serde_json::json!({
                "opacity": 0.5,
                "mode": "fast",
                "debug": false,
                "title": "glass",
            }),
            "a grant-toggle must preserve the stored plugin config"
        );
        // The persisted policy itself carries the config, and the manager snapshot exposes it.
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(
            persisted["applications"][&application_id]["plugins"]["com.example.daemon"]["config"]
                ["opacity"],
            0.5
        );
    }

    #[test]
    fn legacy_state_without_plugin_config_loads_with_defaults() {
        // A state.json written before the config field existed must load: PluginPolicy.config
        // defaults to empty via #[serde(default)].
        let temp = TempRoot::new("legacy-state-config");
        let config_dir = temp.0.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("state.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "global": { "developerMode": false },
                "applications": {
                    "winexe-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
                        "executablePath": "c:/apps/legacy.exe",
                        "displayName": "Legacy",
                        "supportLevel": 2,
                        "plugins": {
                            "com.example.legacy": {
                                "enabled": true,
                                "grants": ["renderer.css"]
                            }
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let service = CoreService::new(&temp.0).unwrap();
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        let policy = &snapshot["applications"]
            ["winexe-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
            ["plugins"]["com.example.legacy"];
        assert_eq!(policy["enabled"], true);
        assert_eq!(policy["grants"], serde_json::json!(["renderer.css"]));
        assert_eq!(
            policy["config"],
            serde_json::json!({}),
            "legacy policies must load with an empty config"
        );
        // A later state write persists the config field as present and empty.
        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": true }),
        ));
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(
            persisted["applications"]
                ["winexe-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
                ["plugins"]["com.example.legacy"]["config"],
            serde_json::json!({})
        );
    }

    // --- Core autostart (HKCU Run preference + registration) --------------------------------

    /// No-side-effect autostart backend for tests: records every register/unregister attempt,
    /// tracks the (fake) registry presence, and can be made to fail.
    #[derive(Clone)]
    struct RecordingAutostart {
        state: Arc<Mutex<AutostartRecording>>,
    }

    #[derive(Default)]
    struct AutostartRecording {
        registered: bool,
        register_failure: Option<String>,
        unregister_failure: Option<String>,
        calls: Vec<String>,
        last_command: Option<String>,
    }

    impl RecordingAutostart {
        fn new() -> Self {
            Self {
                state: Arc::new(Mutex::new(AutostartRecording::default())),
            }
        }

        fn set_registered(&self, registered: bool) {
            self.state.lock().unwrap().registered = registered;
        }

        fn fail_register(&self, message: &str) {
            self.state.lock().unwrap().register_failure = Some(message.to_owned());
        }

        fn fail_unregister(&self, message: &str) {
            self.state.lock().unwrap().unregister_failure = Some(message.to_owned());
        }

        fn registered(&self) -> bool {
            self.state.lock().unwrap().registered
        }

        fn calls(&self) -> Vec<String> {
            self.state.lock().unwrap().calls.clone()
        }

        fn last_command(&self) -> Option<String> {
            self.state.lock().unwrap().last_command.clone()
        }
    }

    impl AutostartStore for RecordingAutostart {
        fn is_registered(&self) -> bool {
            self.state.lock().unwrap().registered
        }

        fn register(&self, command: &str) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            state.calls.push("register".to_owned());
            state.last_command = Some(command.to_owned());
            if let Some(error) = state.register_failure.clone() {
                return Err(error);
            }
            state.registered = true;
            Ok(())
        }

        fn unregister(&self) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            state.calls.push("unregister".to_owned());
            if let Some(error) = state.unregister_failure.clone() {
                return Err(error);
            }
            state.registered = false;
            Ok(())
        }
    }

    /// Replace a service's autostart backend with a recording fake (production CoreService uses
    /// the real RunKeyAutostart, which must never run `reg` in tests).
    fn install_autostart_fake(service: &CoreService) -> RecordingAutostart {
        let fake = RecordingAutostart::new();
        service.inner.lock().unwrap().autostart = Arc::new(fake.clone());
        fake
    }

    /// No-side-effect IFEO write backend for tests: records every apply attempt and can be told
    /// to report an applied write, a UAC cancellation, or a hard failure.
    #[derive(Clone)]
    struct RecordingIefoWriter {
        state: Arc<Mutex<IefoWriteRecording>>,
    }

    struct IefoWriteRecording {
        outcome: IefoWriteOutcome,
        failure: Option<String>,
        calls: Vec<(String, bool)>,
    }

    impl Default for IefoWriteRecording {
        fn default() -> Self {
            Self {
                outcome: IefoWriteOutcome::Applied,
                failure: None,
                calls: Vec::new(),
            }
        }
    }

    impl RecordingIefoWriter {
        fn new() -> Self {
            Self {
                state: Arc::new(Mutex::new(IefoWriteRecording::default())),
            }
        }

        fn set_outcome(&self, outcome: IefoWriteOutcome) {
            self.state.lock().unwrap().outcome = outcome;
        }

        fn set_failure(&self, message: &str) {
            self.state.lock().unwrap().failure = Some(message.to_owned());
        }

        fn calls(&self) -> Vec<(String, bool)> {
            self.state.lock().unwrap().calls.clone()
        }
    }

    impl IefoWriter for RecordingIefoWriter {
        fn apply(&self, target_exe: &str, enabled: bool) -> Result<IefoWriteOutcome, String> {
            let mut state = self.state.lock().unwrap();
            state.calls.push((target_exe.to_owned(), enabled));
            if let Some(error) = state.failure.clone() {
                return Err(error);
            }
            Ok(state.outcome)
        }
    }

    /// No-side-effect IFEO read backend for tests: returns a canned snapshot, or an error when
    /// none is configured (exercising the daemon's degraded-read path).
    #[derive(Clone)]
    struct StubIefoReader {
        state: Arc<Mutex<IefoReadRecording>>,
    }

    #[derive(Default)]
    struct IefoReadRecording {
        snapshot: Option<IefoSnapshot>,
        calls: Vec<String>,
    }

    impl StubIefoReader {
        fn new() -> Self {
            Self {
                state: Arc::new(Mutex::new(IefoReadRecording::default())),
            }
        }

        fn set_snapshot(&self, snapshot: Option<IefoSnapshot>) {
            self.state.lock().unwrap().snapshot = snapshot;
        }

        fn calls(&self) -> Vec<String> {
            self.state.lock().unwrap().calls.clone()
        }
    }

    impl IefoReader for StubIefoReader {
        fn read(&self, target_exe: &str) -> Result<IefoSnapshot, String> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(target_exe.to_owned());
            state
                .snapshot
                .ok_or_else(|| "no IFEO entry".to_owned())
        }
    }

    /// Replace a service's IFEO backends with recording fakes (production CoreService uses the
    /// real elevated launcher / HKLM reader, which must never run in tests).
    fn install_iefo_fakes(service: &mut CoreService) -> (RecordingIefoWriter, StubIefoReader) {
        let writer = RecordingIefoWriter::new();
        let reader = StubIefoReader::new();
        service.iefo_writer = Arc::new(writer.clone());
        service.iefo_reader = Arc::new(reader.clone());
        (writer, reader)
    }

    /// The registered executable path Core hands to the IFEO backends for `application_id`.
    fn registered_executable_path(
        service: &CoreService,
        control: &str,
        application_id: &str,
    ) -> String {
        ok(call(
            service,
            control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ))["applications"][application_id]["executablePath"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn unknown_application_id() -> String {
        format!("winexe-v1:{}", "0".repeat(64))
    }

    #[test]
    fn remove_and_iefo_rpcs_are_control_only_and_reject_bad_input() {
        let temp = TempRoot::new("remove-iefo-auth");
        let app = temp.executable("Auth.exe");
        let (mut service, control) = service(&temp);
        let (writer, reader) = install_iefo_fakes(&mut service);
        let application_id = register(&service, &control, &app, 2);
        let token = launch_token(&service, &control, &app);

        // The three new RPCs are control-token-only: a launch token is forbidden, and the fake
        // backends stay untouched.
        for (method, params) in [
            (
                "removeApplication",
                serde_json::json!({ "applicationId": application_id }),
            ),
            (
                "getIefoRegistration",
                serde_json::json!({ "applicationId": application_id }),
            ),
            (
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "enabled": true }),
            ),
        ] {
            assert_eq!(
                error_code(call(&service, &token, method, params)),
                -32003
            );
        }
        assert!(writer.calls().is_empty());
        assert!(reader.calls().is_empty());

        // Malformed params (missing/unknown/wrong-typed fields) are invalid params.
        for (method, params) in [
            ("removeApplication", serde_json::json!({})),
            (
                "removeApplication",
                serde_json::json!({ "applicationId": application_id, "extra": true }),
            ),
            ("removeApplication", serde_json::json!({ "applicationId": 1 })),
            ("getIefoRegistration", serde_json::json!({})),
            (
                "getIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "extra": true }),
            ),
            ("setIefoRegistration", serde_json::json!({})),
            (
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id }),
            ),
            (
                "setIefoRegistration",
                serde_json::json!({
                    "applicationId": application_id,
                    "enabled": true,
                    "extra": true,
                }),
            ),
            (
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "enabled": "yes" }),
            ),
        ] {
            assert_eq!(
                error_code(call(&service, &control, method, params)),
                -32602
            );
        }

        // Unknown application ids are invalid params for all three RPCs (and never touch the
        // backends).
        let unknown = unknown_application_id();
        for (method, params) in [
            ("removeApplication", serde_json::json!({ "applicationId": unknown })),
            ("getIefoRegistration", serde_json::json!({ "applicationId": unknown })),
            (
                "setIefoRegistration",
                serde_json::json!({ "applicationId": unknown, "enabled": true }),
            ),
        ] {
            assert_eq!(
                error_code(call(&service, &control, method, params)),
                -32602
            );
        }
        assert!(writer.calls().is_empty());
        assert!(reader.calls().is_empty());
    }

    #[test]
    fn remove_application_drops_only_the_target_and_keeps_other_app_data() {
        let temp = TempRoot::new("remove-app");
        let one = temp.executable("One.exe");
        let two = temp.executable("Two.exe");
        let package = temp.package("plugin", "com.example.daemon", "1.0.0");
        let (mut service, control) = service(&temp);
        let (writer, reader) = install_iefo_fakes(&mut service);
        let one_id = register(&service, &control, &one, 2);
        let two_id = register(&service, &control, &two, 1);
        install_package(&service, &control, &package);
        ok(set_policy(&service, &control, &one_id, true, &["renderer.css"]));
        ok(set_policy(
            &service,
            &control,
            &two_id,
            true,
            &["renderer.css", "renderer.script"],
        ));

        // removeApplication returns the contract shape and never consults the IFEO backends.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "removeApplication",
                serde_json::json!({ "applicationId": one_id }),
            )),
            serde_json::json!({ "removed": true })
        );
        assert!(writer.calls().is_empty());
        assert!(reader.calls().is_empty());

        // The removed application is gone; the other one (with its policy) survives.
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert!(snapshot["applications"].get(&one_id).is_none());
        assert!(snapshot["applications"].get(&two_id).is_some());
        assert_eq!(
            snapshot["applications"][&two_id]["plugins"]["com.example.daemon"]["enabled"],
            true
        );

        // The removal is recorded as a core event against the removed application id.
        let logs = query_logs(&service, &control);
        assert!(logs["events"].as_array().unwrap().iter().any(|event| {
            event["code"] == "core.application.removed"
                && event["applicationId"] == one_id
        }));

        // Removal is durable across a CoreService rebuild.
        drop(service);
        let rebuilt = CoreService::new(&temp.0).unwrap();
        let rebuilt_control = std::fs::read_to_string(rebuilt.control_token_path()).unwrap();
        let snapshot = ok(call(
            &rebuilt,
            &rebuilt_control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert!(snapshot["applications"].get(&one_id).is_none());
        assert!(snapshot["applications"].get(&two_id).is_some());
    }

    #[test]
    fn set_iefo_registration_applied_maps_and_records_events() {
        let temp = TempRoot::new("iefo-applied");
        let app = temp.executable("Applied.exe");
        let (mut service, control) = service(&temp);
        let (writer, reader) = install_iefo_fakes(&mut service);
        let application_id = register(&service, &control, &app, 2);
        let executable_path = registered_executable_path(&service, &control, &application_id);
        writer.set_outcome(IefoWriteOutcome::Applied);

        // Enable: registered = enabled, cancelled = false, and the writer saw the executable.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "enabled": true }),
            )),
            serde_json::json!({
                "applicationId": application_id,
                "registered": true,
                "cancelled": false,
            })
        );
        assert_eq!(
            writer.calls(),
            vec![(executable_path.clone(), true)]
        );
        assert!(reader.calls().is_empty());

        // Disable: registered = enabled = false.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "enabled": false }),
            )),
            serde_json::json!({
                "applicationId": application_id,
                "registered": false,
                "cancelled": false,
            })
        );
        assert_eq!(
            writer.calls(),
            vec![(executable_path.clone(), true), (executable_path, false)]
        );

        // The two applied writes are recorded as core events.
        let logs = query_logs(&service, &control);
        let codes = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|event| {
                if event["applicationId"] == application_id {
                    event["code"].as_str()
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        assert!(codes.contains(&"core.iefo.registered"));
        assert!(codes.contains(&"core.iefo.unregistered"));
    }

    #[test]
    fn set_iefo_registration_cancellation_reports_the_actual_state_and_no_event() {
        let temp = TempRoot::new("iefo-cancel");
        let app = temp.executable("Cancelled.exe");
        let (mut service, control) = service(&temp);
        let (writer, reader) = install_iefo_fakes(&mut service);
        let application_id = register(&service, &control, &app, 2);
        writer.set_outcome(IefoWriteOutcome::Cancelled);

        // Cancelling an enable while nothing is registered: nothing changed, registered=false.
        reader.set_snapshot(None); // unreadable entry -> degraded read
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "enabled": true }),
            )),
            serde_json::json!({
                "applicationId": application_id,
                "registered": false,
                "cancelled": true,
            })
        );

        // Cancelling a disable while a registration remains: the switch must snap back to the
        // actual (still-registered) state.
        reader.set_snapshot(Some(IefoSnapshot {
            registered: true,
            owned: true,
        }));
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setIefoRegistration",
                serde_json::json!({ "applicationId": application_id, "enabled": false }),
            )),
            serde_json::json!({
                "applicationId": application_id,
                "registered": true,
                "cancelled": true,
            })
        );
        assert_eq!(writer.calls().len(), 2);
        // A cancelled prompt changes nothing, so no registered/unregistered event is recorded.
        let logs = query_logs(&service, &control);
        assert!(logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["code"] != "core.iefo.registered"
                && event["code"] != "core.iefo.unregistered"));
    }

    #[test]
    fn set_iefo_registration_write_failure_surfaces_an_error_and_event() {
        let temp = TempRoot::new("iefo-fail");
        let app = temp.executable("Fail.exe");
        let (mut service, control) = service(&temp);
        let (writer, reader) = install_iefo_fakes(&mut service);
        let application_id = register(&service, &control, &app, 2);
        writer.set_failure("registry denied");

        let response = call(
            &service,
            &control,
            "setIefoRegistration",
            serde_json::json!({ "applicationId": application_id, "enabled": true }),
        );
        assert_eq!(error_code(response.clone()), -32603);
        // The failure reason travels on the wire (it never embeds the executable path).
        let message = error_message(response);
        assert!(message.contains("registry denied"), "message: {message}");
        assert!(!message.contains("Fail.exe"), "message: {message}");
        assert_eq!(writer.calls().len(), 1);
        assert!(reader.calls().is_empty());

        // The readable reason lands in a core event (never on the wire as a raw path).
        let logs = query_logs(&service, &control);
        assert!(logs["events"].as_array().unwrap().iter().any(|event| {
            event["code"] == "core.iefo.write_failed"
                && event["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("registry denied"))
        }));
    }

    #[test]
    fn get_iefo_registration_shapes_and_read_degrades_on_failure() {
        let temp = TempRoot::new("iefo-get");
        let app = temp.executable("Probe.exe");
        let (mut service, control) = service(&temp);
        let (writer, reader) = install_iefo_fakes(&mut service);
        let application_id = register(&service, &control, &app, 2);
        let executable_path = registered_executable_path(&service, &control, &application_id);

        // Owned + registered -> the contract shape echoes applicationId.
        reader.set_snapshot(Some(IefoSnapshot {
            registered: true,
            owned: true,
        }));
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getIefoRegistration",
                serde_json::json!({ "applicationId": application_id }),
            )),
            serde_json::json!({
                "applicationId": application_id,
                "registered": true,
                "owned": true,
            })
        );

        // A third-party registration (Debugger present, no TronHawk marker) -> owned=false.
        reader.set_snapshot(Some(IefoSnapshot {
            registered: true,
            owned: false,
        }));
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getIefoRegistration",
                serde_json::json!({ "applicationId": application_id }),
            ))["owned"],
            false
        );

        // An unreadable/missing key (or a non-Windows host) degrades to registered/owned=false.
        reader.set_snapshot(None);
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getIefoRegistration",
                serde_json::json!({ "applicationId": application_id }),
            )),
            serde_json::json!({
                "applicationId": application_id,
                "registered": false,
                "owned": false,
            })
        );

        // Every read probed the registered executable path.
        assert_eq!(reader.calls(), vec![executable_path.clone(); 3]);
        assert!(writer.calls().is_empty());
    }

    #[test]
    fn core_autostart_defaults_on_and_rpcs_are_control_only() {
        let temp = TempRoot::new("autostart-auth");
        let executable = temp.executable("Auto.exe");
        let (service, control) = service(&temp);
        assert_eq!(
            service.inner.lock().unwrap().state.global.core_autostart,
            true,
            "coreAutostart defaults to true"
        );

        // Both autostart RPCs are control-token-only.
        let token = launch_token(&service, &control, &executable);
        assert_eq!(
            error_code(call(
                &service,
                &token,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            -32003
        );
        assert_eq!(
            error_code(call(
                &service,
                &token,
                "setCoreAutostart",
                serde_json::json!({ "enabled": false }),
            )),
            -32003
        );

        // Malformed params are rejected.
        for params in [
            serde_json::json!({}),
            serde_json::json!({ "enabled": "yes" }),
            serde_json::json!({ "enabled": false, "extra": true }),
        ] {
            assert_eq!(
                error_code(call(&service, &control, "setCoreAutostart", params)),
                -32602
            );
        }
        assert_eq!(
            error_code(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({ "enabled": false }),
            )),
            -32602
        );

        // Fresh state: preference true => enabled (even with no registry entry).
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": true })
        );
    }

    #[test]
    fn set_core_autostart_registers_persists_and_is_idempotent() {
        let temp = TempRoot::new("autostart-set");
        let (service, control) = service(&temp);
        let fake = install_autostart_fake(&service);
        let expected_command = autostart_command(&std::env::current_exe().unwrap());

        // Enable: registers once (entry missing), persists the preference.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setCoreAutostart",
                serde_json::json!({ "enabled": true }),
            )),
            serde_json::json!({ "enabled": true })
        );
        assert_eq!(fake.calls(), vec!["register".to_owned()]);
        assert_eq!(fake.last_command(), Some(expected_command));
        assert!(fake.registered());
        assert_eq!(
            service.inner.lock().unwrap().state.global.core_autostart,
            true
        );
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(temp.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["global"]["coreAutostart"], true);

        // Enabling again is idempotent: the entry exists, so nothing is rewritten.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setCoreAutostart",
                serde_json::json!({ "enabled": true }),
            )),
            serde_json::json!({ "enabled": true })
        );
        assert_eq!(fake.calls(), vec!["register".to_owned()]);

        // Disable: unregisters and persists false.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setCoreAutostart",
                serde_json::json!({ "enabled": false }),
            )),
            serde_json::json!({ "enabled": false })
        );
        assert_eq!(
            fake.calls(),
            vec!["register".to_owned(), "unregister".to_owned()]
        );
        assert!(!fake.registered());
        assert_eq!(
            service.inner.lock().unwrap().state.global.core_autostart,
            false
        );

        // Disabling again is idempotent: no registry call (entry already absent).
        assert_eq!(
            ok(call(
                &service,
                &control,
                "setCoreAutostart",
                serde_json::json!({ "enabled": false }),
            )),
            serde_json::json!({ "enabled": false })
        );
        assert_eq!(
            fake.calls(),
            vec!["register".to_owned(), "unregister".to_owned()]
        );
    }

    #[test]
    fn core_autostart_effective_state_is_preference_or_registry() {
        let temp = TempRoot::new("autostart-effective");
        let (service, control) = service(&temp);
        let fake = install_autostart_fake(&service);

        // Preference true (fresh default) with no entry => enabled.
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": true })
        );

        // Preference false, no entry => disabled.
        ok(call(
            &service,
            &control,
            "setCoreAutostart",
            serde_json::json!({ "enabled": false }),
        ));
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": false })
        );

        // Preference false but a registry entry appears (e.g. created externally or left by a
        // crashed disable) => enabled, because the boot entry is actually active.
        fake.set_registered(true);
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": true })
        );
    }

    #[test]
    fn core_autostart_preference_survives_service_rebuild() {
        let temp = TempRoot::new("autostart-persist");
        let (service, control) = service(&temp);
        let fake = install_autostart_fake(&service);

        ok(call(
            &service,
            &control,
            "setCoreAutostart",
            serde_json::json!({ "enabled": false }),
        ));
        assert_eq!(fake.registered(), false);
        drop(service);

        let rebuilt = CoreService::new(&temp.0).unwrap();
        let rebuilt_control = std::fs::read_to_string(rebuilt.control_token_path()).unwrap();
        install_autostart_fake(&rebuilt);
        assert_eq!(
            ok(call(
                &rebuilt,
                &rebuilt_control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": false }),
            "the persisted false preference must survive a rebuild"
        );
    }

    #[test]
    fn core_autostart_startup_ensure_registers_only_when_enabled_and_absent() {
        let temp = TempRoot::new("autostart-ensure");
        let (core, _control) = service(&temp);

        // Default preference true + missing entry => one register with the quoted /autostart cmd.
        let fake = install_autostart_fake(&core);
        core.ensure_core_autostart_registered();
        assert!(fake.registered());
        let command = fake.last_command().unwrap();
        assert!(
            command.ends_with("\" /autostart"),
            "command must launch core with /autostart: {command}"
        );
        assert!(command.starts_with('"'), "executable must be quoted: {command}");

        // Entry already present => no second write.
        core.ensure_core_autostart_registered();
        assert_eq!(fake.calls(), vec!["register".to_owned()]);

        // Preference false => never registers.
        let temp_disabled = TempRoot::new("autostart-ensure-disabled");
        let (disabled, _control) = service(&temp_disabled);
        let fake = install_autostart_fake(&disabled);
        disabled.inner.lock().unwrap().state.global.core_autostart = false;
        disabled.ensure_core_autostart_registered();
        assert!(fake.calls().is_empty());
        assert!(!fake.registered());
    }

    #[test]
    fn core_autostart_failures_record_events_and_never_crash() {
        let temp = TempRoot::new("autostart-fail");
        let (service, control) = service(&temp);

        // Startup-ensure failure: registered event, service keeps serving, preference stays on
        // (get reports the preference; the event log carries the reason).
        let fake = install_autostart_fake(&service);
        fake.fail_register("registry denied");
        service.ensure_core_autostart_registered();
        assert!(!fake.registered());
        let logs = query_logs(&service, &control);
        let failures = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["code"] == "core.autostart.register_failed")
            .collect::<Vec<_>>();
        assert_eq!(failures.len(), 1);
        assert!(failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("Core autostart registration failed: registry denied"));
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": true })
        );

        // setCoreAutostart failure surfaces as an RPC error and the preference is not flipped.
        assert_eq!(
            error_code(call(
                &service,
                &control,
                "setCoreAutostart",
                serde_json::json!({ "enabled": true }),
            )),
            -32603
        );
        let logs = query_logs(&service, &control);
        let failures = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["code"] == "core.autostart.register_failed")
            .count();
        assert_eq!(failures, 2);

        // Unregister failure also records an event and returns an error.
        fake.set_registered(true);
        fake.fail_unregister("registry busy");
        assert_eq!(
            error_code(call(
                &service,
                &control,
                "setCoreAutostart",
                serde_json::json!({ "enabled": false }),
            )),
            -32603
        );
        assert_eq!(
            service.inner.lock().unwrap().state.global.core_autostart,
            true,
            "a failed disable must not flip the persisted preference"
        );
    }

    #[test]
    fn legacy_global_state_without_core_autostart_loads_with_default_on() {
        // A state.json written before coreAutostart existed must load with the field defaulting
        // to true (developer-mode persistence is untouched).
        let temp = TempRoot::new("legacy-autostart");
        let config_dir = temp.0.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("state.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "global": { "developerMode": true },
                "applications": {}
            }))
            .unwrap(),
        )
        .unwrap();

        let service = CoreService::new(&temp.0).unwrap();
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert_eq!(snapshot["global"]["developerMode"], true);
        assert_eq!(
            ok(call(
                &service,
                &control,
                "getCoreAutostart",
                serde_json::json!({}),
            )),
            serde_json::json!({ "enabled": true }),
            "legacy state without coreAutostart must default to on"
        );
    }

    #[test]
    fn migration_preserves_developer_mode_and_config_state() {
        // End-to-end guard for the legacy-storage migration: after the merge copy, a daemon
        // built on the new root reads developer mode / application config from the migrated
        // state, and further writes land in the new root — never the legacy one.
        let legacy = TempRoot::new("migrate-dev-legacy");
        let current = TempRoot::new("migrate-dev-current");
        let config_dir = legacy.0.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("state.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "global": { "developerMode": true },
                "applications": {}
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            crate::migrate_legacy_storage(&legacy.0, &current.0).unwrap(),
            crate::MigrationOutcome::Migrated
        );
        let service = CoreService::new(&current.0).unwrap();
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        let snapshot = ok(call(
            &service,
            &control,
            "getManagerSnapshot",
            serde_json::json!({}),
        ));
        assert_eq!(
            snapshot["global"]["developerMode"],
            true,
            "developer mode must survive the storage-root migration"
        );

        // A state write after migration lands in the new root only.
        ok(call(
            &service,
            &control,
            "setDeveloperMode",
            serde_json::json!({ "enabled": false }),
        ));
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(current.0.join("config/state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["global"]["developerMode"], false);
        assert!(
            !legacy.0.exists(),
            "the legacy root must be removed after a successful migration"
        );
    }

    // --- Tier-2 networkRequest (manifest network.domains whitelist) --------------------------

    /// Deterministic transport seam: returns a scripted sequence of responses and records every
    /// request URL it is asked to fetch, so redirect re-checks are observable without a network.
    struct FakeTransport {
        responses: std::sync::Mutex<VecDeque<Result<OutboundResponse, String>>>,
        requests: std::sync::Mutex<Vec<String>>,
    }

    impl FakeTransport {
        fn new(responses: Vec<Result<OutboundResponse, String>>) -> std::sync::Arc<Self> {
            std::sync::Arc::new(Self {
                responses: std::sync::Mutex::new(responses.into()),
                requests: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn requested_urls(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl HttpTransport for std::sync::Arc<FakeTransport> {
        fn execute(&self, request: &OutboundRequest) -> Result<OutboundResponse, String> {
            self.requests.lock().unwrap().push(request.url.clone());
            match self.responses.lock().unwrap().pop_front() {
                Some(response) => response,
                None => Err("no fake response queued".to_string()),
            }
        }
    }

    fn http_response(status: u16, headers: &[(&str, &str)], body: &str) -> OutboundResponse {
        OutboundResponse {
            status,
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            body: body.as_bytes().to_vec(),
        }
    }

    /// Register a Level-2 app, install the network plugin, enable it with the given grants, mint
    /// a launch token, and swap in `fake` as the transport.
    fn network_env(
        temp: &TempRoot,
        domains: &[&str],
        grants: &[&str],
        fake: std::sync::Arc<FakeTransport>,
    ) -> (CoreService, String) {
        let executable = temp.executable("Network.exe");
        let package =
            temp.package_with_network("net-plugin", "com.example.daemon", "1.0.0", domains);
        let (mut service, control) = service(temp);
        let application_id = register(&service, &control, &executable, 2);
        install_package(&service, &control, &package);
        ok(set_policy(
            &service,
            &control,
            &application_id,
            true,
            grants,
        ));
        service.http = Box::new(fake);
        let token = launch_token(&service, &control, &executable);
        (service, token)
    }

    fn network_request_params(
        url: &str,
        extra: Option<(&str, serde_json::Value)>,
    ) -> serde_json::Value {
        let mut params = serde_json::json!({
            "pluginId": "com.example.daemon",
            "url": url,
        });
        if let Some((key, value)) = extra {
            params[key] = value;
        }
        params
    }

    #[test]
    fn network_request_is_launch_token_only_and_validates_params() {
        let temp = TempRoot::new("network-routing");
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            FakeTransport::new(vec![Ok(http_response(200, &[], "ok"))]),
        );

        // Control tokens are forbidden from the launch-only RPC.
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        assert_eq!(
            error_code(call(
                &service,
                &control,
                "networkRequest",
                network_request_params("https://api.example.com/", None),
            )),
            -32003
        );

        // Launch token routes to the handler: params problems are -32602, not a route miss.
        for params in [
            serde_json::json!({ "url": "https://api.example.com/" }), // missing pluginId
            serde_json::json!({ "pluginId": "com.example.daemon" }), // missing url
            network_request_params("https://api.example.com/", Some(("extra", serde_json::json!(1)))), // unknown field
            network_request_params("https://api.example.com/", Some(("pluginId", serde_json::json!(7)))), // wrong type
        ] {
            assert_eq!(
                error_code(call(&service, &token, "networkRequest", params)),
                -32602
            );
        }
        // An unparseable URL is an invalid-param rejection.
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("not a url at all", None),
        );
        assert_eq!(error_code(response.clone()), -32602);
        assert!(error_message(response).contains("absolute"));
    }

    #[test]
    fn network_request_rejects_unknown_plugins_and_missing_grants() {
        let temp = TempRoot::new("network-grants");
        let fake = FakeTransport::new(vec![Ok(http_response(200, &[], "ok"))]);
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            fake.clone(),
        );

        // A plugin id that is not installed / not in the plan is rejected fail-closed.
        let unknown = call(
            &service,
            &token,
            "networkRequest",
            network_request_params(
                "https://api.example.com/",
                Some(("pluginId", serde_json::json!("com.example.ghost"))),
            ),
        );
        assert_eq!(error_code(unknown.clone()), -32003);
        assert!(error_message(unknown).contains("not in the current execution plan"));
        assert!(fake.requested_urls().is_empty(), "no fetch may occur");
    }

    #[test]
    fn network_request_requires_a_live_network_access_grant() {
        let temp = TempRoot::new("network-not-granted");
        let fake = FakeTransport::new(vec![Ok(http_response(200, &[], "ok"))]);
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["renderer.css"], // plugin IS in the plan, but without network.access
            fake.clone(),
        );

        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        let message = error_message(response);
        assert!(message.contains("not granted"), "{message}");
        assert!(message.contains("network.access"), "{message}");
        assert!(fake.requested_urls().is_empty());

        // Disabling the policy removes the plugin from the current plan entirely.
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        let app = service
            .inner
            .lock()
            .unwrap()
            .state
            .applications
            .keys()
            .next()
            .unwrap()
            .clone();
        ok(call(
            &service,
            &control,
            "setApplicationPluginPolicy",
            serde_json::json!({
                "applicationId": app,
                "pluginId": "com.example.daemon",
                "enabled": false,
                "grants": [],
            }),
        ));
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        assert!(error_message(response).contains("not in the current execution plan"));
    }

    #[test]
    fn network_request_whitelist_match_returns_data_and_emits_audit_log() {
        let temp = TempRoot::new("network-success");
        let fake = FakeTransport::new(vec![
            Ok(http_response(
                200,
                &[("content-type", "application/json")],
                "{\"ok\":true}",
            )),
            Ok(http_response(
                200,
                &[("content-type", "application/json")],
                "{\"ok\":true}",
            )),
            Ok(http_response(204, &[], "")),
        ]);
        let (service, token) = network_env(
            &temp,
            &["api.example.com", "*.example.org", "127.0.0.1:8080"],
            &["network.access"],
            fake.clone(),
        );

        // Exact host match.
        let result = ok(call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/v1/data?q=1", None),
        ));
        assert_eq!(result["status"], 200);
        assert_eq!(result["headers"]["content-type"], "application/json");
        assert_eq!(result["body"], "{\"ok\":true}");
        assert_eq!(
            fake.requested_urls(),
            vec!["https://api.example.com/v1/data?q=1".to_string()]
        );

        // A wildcard subdomain and an IPv4+port entry also match (each is a fresh request).
        ok(call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://deep.api.example.org/x", None),
        ));
        ok(call(
            &service,
            &token,
            "networkRequest",
            serde_json::json!({
                "pluginId": "com.example.daemon",
                "url": "http://127.0.0.1:8080/health",
                "method": "GET",
            }),
        ));
        assert_eq!(fake.requested_urls().len(), 3);

        // Every performed exchange is audited on the plugin stream with domain/status/bytes.
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        let logs = query_logs(&service, &control);
        let audits: Vec<&serde_json::Value> = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["code"] == "network.request")
            .collect();
        assert_eq!(audits.len(), 3);
        assert!(audits.iter().all(|event| {
            event["stream"] == "plugin"
                && event["pluginId"] == "com.example.daemon"
                && event["applicationId"].is_string()
        }));
        let first = audits
            .iter()
            .find(|event| {
                event["message"]
                    .as_str()
                    .unwrap()
                    .contains("host=api.example.com")
            })
            .expect("audit must name the requested domain");
        let message = first["message"].as_str().unwrap();
        assert!(message.contains("status=200"), "{message}");
        assert!(message.contains("bytes=11"), "{message}");
    }

    #[test]
    fn network_request_rejects_mismatched_hosts_and_url_forms() {
        let temp = TempRoot::new("network-whitelist");
        let fake = FakeTransport::new(Vec::new());
        let (service, token) = network_env(
            &temp,
            &["good.example.com", "*.example.org"],
            &["network.access"],
            fake.clone(),
        );

        // Exact mismatched host.
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://evil.example.net/x", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        assert!(error_message(response).contains("not allowed"));
        // The `*.` wildcard matches subdomains but never the bare base host.
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://example.org/", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        assert!(error_message(response).contains("not allowed"));
        // Non-http(s) scheme and credentials are policy rejections, not fetches.
        for (url, needle) in [
            ("ftp://good.example.com/x", "http:// and https://"),
            ("https://user:pass@good.example.com/x", "credentials"),
            ("http://[::1]:8080/x", "IPv6"),
        ] {
            let response = call(
                &service,
                &token,
                "networkRequest",
                network_request_params(url, None),
            );
            assert_eq!(error_code(response.clone()), -32003, "url: {url}");
            assert!(error_message(response).contains(needle), "url: {url}");
        }
        // None of the rejected URLs may have reached the transport.
        assert!(fake.requested_urls().is_empty());
    }

    #[test]
    fn network_request_matches_ported_whitelist_entries_exactly() {
        let temp = TempRoot::new("network-whitelist-port");
        let fake = FakeTransport::new(vec![Ok(http_response(204, &[], ""))]);
        let (service, token) = network_env(
            &temp,
            &["api.example.com:8443"],
            &["network.access"],
            fake.clone(),
        );

        // The same host on the default port does not match a ported entry.
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        assert!(error_message(response).contains("not allowed"));
        assert!(fake.requested_urls().is_empty());

        // An explicit matching port is allowed and 204 is relayed as data.
        let result = ok(call(
            &service,
            &token,
            "networkRequest",
            network_request_params("http://api.example.com:8443/", None),
        ));
        assert_eq!(result["status"], 204);
        assert_eq!(fake.requested_urls(), vec!["http://api.example.com:8443/".to_string()]);
    }

    #[test]
    fn network_request_fails_closed_when_domain_whitelist_is_empty() {
        let temp = TempRoot::new("network-whitelist-empty");
        let empty_fake = FakeTransport::new(vec![Ok(http_response(200, &[], "unused"))]);
        let (service, token) = network_env(&temp, &[], &["network.access"], empty_fake.clone());
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        assert!(error_message(response).contains("whitelist is empty"));
        assert!(empty_fake.requested_urls().is_empty());
    }

    #[test]
    fn network_request_enforces_request_caps() {
        let temp = TempRoot::new("network-request-caps");
        let fake = FakeTransport::new(Vec::new());
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            fake.clone(),
        );

        // More than 64 request headers.
        let many_headers: BTreeMap<String, String> = (0..65)
            .map(|i| (format!("x-header-{i:02}"), "v".to_string()))
            .collect();
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", Some(("headers", serde_json::to_value(&many_headers).unwrap()))),
        );
        assert_eq!(error_code(response.clone()), -32602);
        assert!(error_message(response).contains("64"));

        // Invalid / transport-controlled header names and newline injection.
        for bad_name in ["bad name", "hdr:colon", "connection", "HoSt"] {
            let params = serde_json::json!({
                "pluginId": "com.example.daemon",
                "url": "https://api.example.com/",
                "headers": { bad_name: "v" },
            });
            assert_eq!(
                error_code(call(&service, &token, "networkRequest", params)),
                -32602,
                "header `{bad_name}` must be rejected"
            );
        }
        let params = serde_json::json!({
            "pluginId": "com.example.daemon",
            "url": "https://api.example.com/",
            "headers": { "x-test": "a\r\nb" },
        });
        assert_eq!(error_code(call(&service, &token, "networkRequest", params)), -32602);

        // Request body > 1 MiB, and a body on GET.
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", Some(("body", serde_json::json!("x".repeat(1024 * 1024 + 1))))),
        );
        assert_eq!(error_code(response.clone()), -32602);
        assert!(error_message(response).contains("1 MiB"));
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", Some(("body", serde_json::json!("x")))),
        );
        assert_eq!(error_code(response.clone()), -32602);
        assert!(error_message(response).contains("GET or HEAD"));

        // Unsupported method.
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", Some(("method", serde_json::json!("TRACE")))),
        );
        assert_eq!(error_code(response.clone()), -32602);
        assert!(fake.requested_urls().is_empty());
    }

    #[test]
    fn network_request_enforces_response_and_redirect_caps() {
        // Response body over 1 MiB is rejected (-32004) without leaking the body.
        let temp = TempRoot::new("network-response-cap");
        let fake = FakeTransport::new(vec![Ok(OutboundResponse {
            status: 200,
            headers: vec![],
            body: vec![0_u8; 1024 * 1024 + 1],
        })]);
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            fake.clone(),
        );
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/", None),
        );
        assert_eq!(error_code(response.clone()), -32004);
        assert!(error_message(response).contains("1 MiB"));

        // More than 5 redirects is rejected after the 6th redirect is seen.
        let temp = TempRoot::new("network-redirect-cap");
        let many_redirects = (0..6)
            .map(|i| Ok(http_response(302, &[("location", &format!("/r{i}"))], "")))
            .collect();
        let fake = FakeTransport::new(many_redirects);
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            fake.clone(),
        );
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/start", None),
        );
        assert_eq!(error_code(response.clone()), -32004);
        assert!(error_message(response).contains("too many redirects"));
        assert_eq!(fake.requested_urls().len(), 6);

        // A redirect to a host outside the whitelist is rejected and never fetched.
        let temp = TempRoot::new("network-redirect-host");
        let fake = FakeTransport::new(vec![Ok(http_response(
            302,
            &[("location", "https://evil.example.net/steal")],
            "",
        ))]);
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            fake.clone(),
        );
        let response = call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/start", None),
        );
        assert_eq!(error_code(response.clone()), -32003);
        assert!(error_message(response).contains("redirect target host"));
        assert_eq!(fake.requested_urls().len(), 1);
    }

    #[test]
    fn network_request_follows_up_to_five_redirects_within_the_whitelist() {
        let temp = TempRoot::new("network-redirect-ok");
        let mut responses = (0..5)
            .map(|i| Ok(http_response(302, &[("location", &format!("/hop{i}"))], "")))
            .collect::<Vec<_>>();
        responses.push(Ok(http_response(200, &[("x-final", "yes")], "done")));
        let fake = FakeTransport::new(responses);
        let (service, token) = network_env(
            &temp,
            &["api.example.com"],
            &["network.access"],
            fake.clone(),
        );

        let result = ok(call(
            &service,
            &token,
            "networkRequest",
            network_request_params("https://api.example.com/start", None),
        ));
        assert_eq!(result["status"], 200);
        assert_eq!(result["body"], "done");
        // Five redirects -> six requests, each hop on the whitelisted host.
        let urls = fake.requested_urls();
        assert_eq!(urls.len(), 6);
        assert_eq!(urls[0], "https://api.example.com/start");
        assert_eq!(urls[1], "https://api.example.com/hop0");
        assert_eq!(urls[5], "https://api.example.com/hop4");

        // The successful exchange is audited once with the final hop's status/bytes.
        let control = std::fs::read_to_string(service.control_token_path()).unwrap();
        let logs = query_logs(&service, &control);
        let audits: Vec<&serde_json::Value> = logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["code"] == "network.request")
            .collect();
        assert_eq!(audits.len(), 1);
        let message = audits[0]["message"].as_str().unwrap();
        assert!(message.contains("host=api.example.com"), "{message}");
        assert!(message.contains("status=200"), "{message}");
        assert!(message.contains("bytes=4"), "{message}");
    }
}

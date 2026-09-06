//! `.thx` (ZIP) package format mechanics: pack, safe extraction, and manifest schema
//! validation. A support crate for the Core layer — it does NOT make permission decisions,
//! perform install orchestration, or register plugins.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const KNOWN_PERMISSIONS: &[&str] = &[
    "renderer.css",
    "renderer.script",
    "renderer.dom",
    "renderer.storage",
    "electron.window",
    "electron.webContents",
    "electron.session",
    "electron.ipc",
    "network.access",
    "network.proxy",
    "runtime.unsafe",
];

/// Maximum `manifest.json` size (bytes) read from a `.thx` archive.
const MAX_MANIFEST_SIZE: u64 = 1024 * 1024;
/// Archive hardening limits.
const MAX_ENTRIES: usize = 1000;
const MAX_SINGLE_FILE: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_SIZE: u64 = 64 * 1024 * 1024;
/// A compressed payload may not expand beyond this multiple of its compressed size (per entry and
/// cumulatively). Combined with the absolute byte caps above this stops a small zip bomb from
/// expanding far beyond a sane ratio even when it stays under the byte caps.
const MAX_COMPRESSION_RATIO: u64 = 100;

/// Current host runtime protocol version, in semver `major.minor.patch` form.
///
/// A plugin's `manifest.json` `tronhawk` field is a semver `VersionReq` over this *runtime
/// protocol* version (not the SDK/npm version). This constant is the single source of truth used
/// by the legacy [`extract`]/[`validate_manifest`] entry points. It mirrors the workspace release
/// version (`0.1.0`) and matches the `^0.1` ranges used by the repository's own plugin fixtures.
///
/// Callers that know a different host version should pass it explicitly via
/// [`extract_for_host`] / [`validate_manifest_schema_for_host`] / [`validate_tronhawk_protocol`]
/// instead of relying on this default; when the host runtime bumps its protocol version, update
/// this constant (and prefer migrating callers to the explicit-version variants).
pub const HOST_PROTOCOL_VERSION: &str = "0.1.0";

/// Declared value type of one plugin config field (see [`ConfigField`]). Only scalar types are
/// supported today; `object`/`array` config fields are rejected as reserved for a future schema
/// version.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConfigType {
    String,
    Number,
    Boolean,
}

impl ConfigType {
    /// Lowercase JSON name of this config type (`string`/`number`/`boolean`), for error messages.
    pub fn type_name(&self) -> &'static str {
        match self {
            ConfigType::String => "string",
            ConfigType::Number => "number",
            ConfigType::Boolean => "boolean",
        }
    }
}

/// One declared key of the per-plugin `config` schema in `manifest.json`:
/// `{ "type": "string"|"number"|"boolean", "default": <matching value>, "label": "…" }`.
///
/// Unknown keys inside a field declaration are rejected (`deny_unknown_fields`); the `default`,
/// when present, must match the declared `type` (enforced by the manifest schema validator).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConfigField {
    #[serde(rename = "type")]
    pub field_type: ConfigType,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub label: Option<String>,
}

/// The optional `network` allowlist a plugin declares for the `network.access` permission:
/// `"network": { "domains": ["example.com", "*.example.org:8443"] }`.
///
/// Every domain is a hostname or `host[:port]` (an explicitly-listed IPv4 is allowed; IPv6
/// literals, schemes, and paths are not), with an optional leading `*.` wildcard on a hostname
/// label. Entries are lowercased during manifest validation so Core's matching is
/// case-insensitive without any runtime normalization. A plugin granted `network.access` whose
/// manifest declares no `network` (or an empty `domains` list) is rejected at request time —
/// Core fails closed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkManifest {
    pub domains: Vec<String>,
}

/// A parsed plugin manifest and its execution plan (MVP: declared == granted).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub tronhawk: String,
    pub permissions: Vec<String>,
    /// CSS data to inject for `renderer.css` — injected via `insertCSS`, never executed as JS.
    pub css: Option<String>,
    /// Renderer JS source, gated at runtime by an effective `renderer.script` grant or the
    /// `runtime.unsafe` escape hatch (pack-time: `entry.renderer` must still declare
    /// `renderer.script`; see manifest validation and Core `core.renderer.script_required`).
    pub renderer: Option<String>,
    /// Main-process JS source for `electron.*` capabilities.
    pub main: Option<String>,
    /// Declared per-plugin config schema (`{ key: { type, default?, label? } }`). Values are
    /// stored per-application × per-plugin in the Core `PluginPolicy` and read at runtime via
    /// `ctx.config`; the Manager renders a settings form from this schema.
    #[serde(default)]
    pub config: BTreeMap<String, ConfigField>,
    /// Optional `network.domains` outbound allowlist backing the `network.access` permission.
    /// `#[serde(default)]` keeps manifests written before the field existed loadable.
    #[serde(default)]
    pub network: Option<NetworkManifest>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    author: String,
    tronhawk: String,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    entry: Option<Entry>,
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    network: serde_json::Value,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    renderer: Option<String>,
    #[serde(default)]
    main: Option<String>,
}

/// Validate a manifest's SCHEMA and semantic rules (no entry-file reads) against the default host
/// protocol version [`HOST_PROTOCOL_VERSION`]. Call this before extracting an archive so that an
/// invalid/unauthorized package never writes to disk.
pub fn validate_manifest_schema(manifest: &serde_json::Value) -> Result<(), String> {
    validate_manifest_schema_for_host(manifest, HOST_PROTOCOL_VERSION)
}

/// Validate a manifest's SCHEMA and semantic rules against an explicit host runtime protocol
/// version. Behaves exactly like [`validate_manifest_schema`] plus the [`tronhawk` protocol gate]
/// (validate_tronhawk_protocol): a plugin whose `tronhawk` range is not satisfied by the host's
/// protocol version is rejected here, i.e. before anything is written to disk or installed.
///
/// `host_version` is provided by the caller (in semver form, e.g. `"0.1.0"`); this crate never
/// hardcodes the host version inside the check itself.
pub fn validate_manifest_schema_for_host(
    manifest: &serde_json::Value,
    host_version: &str,
) -> Result<(), String> {
    // Parse into a strict typed DTO (rejects unknown fields and wrong types).
    let m: Manifest =
        serde_json::from_value(manifest.clone()).map_err(|e| format!("manifest schema: {e}"))?;

    validate_id(&m.id)?;
    if m.name.trim().is_empty() {
        return Err("`name` must not be empty".to_string());
    }
    if m.author.trim().is_empty() {
        return Err("`author` must not be empty".to_string());
    }
    semver::Version::parse(&m.version).map_err(|e| format!("invalid `version`: {e}"))?;
    validate_tronhawk_protocol(host_version, &m.tronhawk)?;

    // `config`: the optional per-plugin settings schema. Raw-value validation (before any typed
    // parse) so each rejection carries a precise, actionable message (object/array `type` values
    // get an explicit "reserved for a future schema" note). The `config` JSON value is still
    // carried in typed [`Plugin::config`] form by [`validate_manifest_for_host`].
    if !m.config.is_null() {
        validate_config_schema(&m.config)?;
    }

    // `network`: the optional `network.domains` outbound allowlist for `network.access`.
    // Raw-value validation (before any typed parse) so each rejection carries a precise message
    // naming the offending entry. The JSON value is carried in typed [`Plugin::network`] form by
    // [`validate_manifest_for_host`].
    if !m.network.is_null() {
        validate_network_schema(&m.network)?;
    }

    // Permissions: known + no duplicates.
    let mut seen = std::collections::HashSet::new();
    for p in &m.permissions {
        if !KNOWN_PERMISSIONS.contains(&p.as_str()) {
            return Err(format!("unknown permission `{p}`"));
        }
        if !seen.insert(p.clone()) {
            return Err(format!("duplicate permission `{p}`"));
        }
    }

    // Mutually exclusive CSS sources.
    if m.css.is_some() && m.entry.as_ref().and_then(|e| e.css.as_ref()).is_some() {
        return Err("`css` and `entry.css` are mutually exclusive".to_string());
    }

    // Entry-permission coherence.
    let has_css = m.css.is_some() || m.entry.as_ref().and_then(|e| e.css.as_ref()).is_some();
    if has_css && !m.permissions.iter().any(|p| p == "renderer.css") {
        return Err("a CSS entry requires the `renderer.css` permission".to_string());
    }
    // 0.1 unified contract, two layers: pack-time — an `entry.renderer` MUST declare
    // `renderer.script`. Runtime — Core `execution_plan` (see
    // `core.renderer.script_required`) runs renderer JS only with an effective
    // `renderer.script` grant or the Developer-mode `runtime.unsafe` escape hatch.
    // `renderer.dom` / `renderer.storage` / `renderer.css` are additional capabilities
    // only and never substitute for the gate at either layer, so accepting a
    // `renderer.dom`-only manifest here would be "packable but never runs". No new
    // permission name is introduced in 0.1 and no new required manifest field is added.
    let has_renderer = m.entry.as_ref().and_then(|e| e.renderer.as_ref()).is_some();
    if has_renderer && !m.permissions.iter().any(|p| p == "renderer.script") {
        return Err("an `entry.renderer` entry requires the `renderer.script` permission \
            (pack-time contract: `entry.renderer` must declare `renderer.script`; \
            runtime contract: `renderer.script` is the execution gate for renderer JS — \
            Core `execution_plan` drops the renderer payload without an effective \
            `renderer.script` grant or the `runtime.unsafe` escape hatch; \
            `renderer.dom`/`renderer.storage`/`renderer.css` are additional capabilities only, \
            see `core.renderer.script_required`)".to_string());
    }

    // Entry paths must be safe.
    if let Some(entry) = &m.entry {
        for rel in [
            entry.css.as_ref(),
            entry.renderer.as_ref(),
            entry.main.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            check_entry_path(rel)?;
        }
    }

    Ok(())
}

/// Check that a plugin's declared `tronhawk` protocol range is satisfied by the host runtime's
/// protocol version.
///
/// The `tronhawk` manifest field is the *runtime protocol* version the plugin was built against
/// (e.g. `^0.1`), expressed as a semver `VersionReq`; it is NOT the SDK/npm version. `host_version`
/// is the semver version of the `tronhawk` protocol the host runtime implements and is provided
/// explicitly by the caller (e.g. [`HOST_PROTOCOL_VERSION`]) — never hardcoded here. A well-formed
/// but incompatible range is rejected with a message naming both sides.
pub fn validate_tronhawk_protocol(host_version: &str, tronhawk: &str) -> Result<(), String> {
    let req = semver::VersionReq::parse(tronhawk)
        .map_err(|e| format!("invalid `tronhawk` range: {e}"))?;
    let host = semver::Version::parse(host_version)
        .map_err(|e| format!("invalid host protocol version `{host_version}`: {e}"))?;
    if !req.matches(&host) {
        return Err(format!(
            "plugin requires tronhawk protocol `{tronhawk}` but host protocol is {host_version}"
        ));
    }
    Ok(())
}

fn check_entry_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("entry path must not be empty".to_string());
    }
    let p = Path::new(rel);
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(format!("entry path must be a safe relative path: {rel}"));
        }
    }
    Ok(())
}

/// Validate a plugin ID: a safe identifier, not a filesystem path. Reverse-DNS-style ASCII
/// (lowercase letters, digits, `.`, `-`, `_`), no separators, no empty dot-segments.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("`id` must be 1-128 characters".to_string());
    }
    for c in id.chars() {
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_';
        if !ok {
            return Err(format!("`id` contains invalid character `{c}`"));
        }
    }
    for seg in id.split('.') {
        if seg.is_empty() {
            return Err("`id` must not contain empty dot-segments (e.g. `..`)".to_string());
        }
    }
    Ok(())
}

/// Validate the raw `manifest.json` `config` value (the per-plugin settings schema). Rules:
/// `config` must be an object of at most [`MAX_CONFIG_FIELDS`] field declarations, every key must
/// satisfy the plugin-id character rules, every field must be an object whose keys are limited to
/// `type`/`default`/`label`, `type` must be a supported scalar type (`object`/`array` are
/// rejected with a "future" note), and a present `default` must match the declared `type`.
const MAX_CONFIG_FIELDS: usize = 32;

fn validate_config_schema(config: &serde_json::Value) -> Result<(), String> {
    let fields = config
        .as_object()
        .ok_or_else(|| "`config` must be an object of config field declarations".to_string())?;
    if fields.len() > MAX_CONFIG_FIELDS {
        return Err(format!(
            "`config` declares {} fields; the maximum is {MAX_CONFIG_FIELDS}",
            fields.len()
        ));
    }
    for (key, field) in fields {
        validate_config_key(key)?;
        let declaration = field
            .as_object()
            .ok_or_else(|| format!("`config` field `{key}` must be an object with a `type`"))?;
        for field_key in declaration.keys() {
            if !matches!(field_key.as_str(), "type" | "default" | "label") {
                return Err(format!(
                    "`config` field `{key}` has an unknown key `{field_key}` \
                     (allowed: `type`, `default`, `label`)"
                ));
            }
        }
        // `label` (if present) must be a non-empty string limited to 64 chars — it is shown
        // verbatim in the Manager settings form, so reject non-string / over-long values early.
        if let Some(label) = declaration.get("label") {
            if !label.is_string() {
                return Err(format!(
                    "`config` field `{key}` `label` must be a string (got `{label}`)"
                ));
            }
            if label.as_str().is_some_and(|s| s.len() > 64) {
                return Err(format!(
                    "`config` field `{key}` `label` must be at most 64 characters"
                ));
            }
            if label.as_str().is_some_and(str::is_empty) {
                return Err(format!("`config` field `{key}` `label` must not be empty"));
            }
        }
        let declared = declaration
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("`config` field `{key}` requires a string `type`"))?;
        match declared {
            "string" | "number" | "boolean" => {}
            "object" | "array" => {
                return Err(format!(
                    "`config` field `{key}` type `{declared}` is reserved for a future schema \
                     version; supported types today: `string`, `number`, `boolean`"
                ));
            }
            other => {
                return Err(format!(
                    "`config` field `{key}` has an unsupported type `{other}`; \
                     supported types: `string`, `number`, `boolean`"
                ));
            }
        }
        match declaration.get("default") {
            // `null` is treated as "no default" (it deserializes to `Option::None`).
            Some(default) if !default.is_null() => {
                let matches_type = match declared {
                    "string" => default.is_string(),
                    "number" => default.is_number(),
                    "boolean" => default.is_boolean(),
                    _ => false,
                };
                if !matches_type {
                    return Err(format!(
                        "`config` field `{key}` `default` must be a {declared} (got `{default}`)"
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Validate one `config` schema key with the same character rules as a plugin id (reverse-DNS-safe
/// ASCII, lowercase letters/digits/`.`/`-`/`_`, no empty dot-segments).
fn validate_config_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 {
        return Err(format!(
            "`config` field name `{key}` must be 1-128 characters"
        ));
    }
    for c in key.chars() {
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_';
        if !ok {
            return Err(format!(
                "`config` field name `{key}` contains invalid character `{c}`"
            ));
        }
    }
    for segment in key.split('.') {
        if segment.is_empty() {
            return Err(format!(
                "`config` field name `{key}` must not contain empty dot-segments (e.g. `..`)"
            ));
        }
    }
    Ok(())
}

/// Validate the raw `manifest.json` `network` value (the `network.domains` allowlist). Rules:
/// `network` must be an object whose only key is `domains`, `domains` must be an array of at
/// most [`MAX_NETWORK_DOMAINS`] strings, each entry must be a valid lowercase hostname,
/// `host[:port]`, IPv4, or leading-`*.`-wildcard hostname (no scheme, path, credentials, IPv6
/// literal, or bare `*`), and no two entries may be equal after case-folding. An absent or
/// `null` `network` is fine (older manifests); plugins that then request `network.access` are
/// rejected at request time because their whitelist is empty (fail closed).
const MAX_NETWORK_DOMAINS: usize = 64;

fn validate_network_schema(network: &serde_json::Value) -> Result<(), String> {
    let object = network
        .as_object()
        .ok_or_else(|| "`network` must be an object with a `domains` array".to_string())?;
    for key in object.keys() {
        if key != "domains" {
            return Err(format!(
                "`network` has an unknown key `{key}` (allowed: `domains`)"
            ));
        }
    }
    let domains = object
        .get("domains")
        .ok_or_else(|| "`network` requires a `domains` array".to_string())?;
    let domains = domains
        .as_array()
        .ok_or_else(|| "`network.domains` must be an array of hostname strings".to_string())?;
    if domains.len() > MAX_NETWORK_DOMAINS {
        return Err(format!(
            "`network.domains` declares {} entries; the maximum is {MAX_NETWORK_DOMAINS}",
            domains.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for entry in domains {
        let entry = entry
            .as_str()
            .ok_or_else(|| "`network.domains` entries must be strings".to_string())?;
        let normalized = normalize_network_domain(entry)?;
        if !seen.insert(normalized) {
            return Err(format!(
                "`network.domains` contains a duplicate entry `{entry}`"
            ));
        }
    }
    Ok(())
}

/// Validate one `network.domains` entry and return its canonical lowercased form (`host` or
/// `host:port`, wildcard preserved). Rejects schemes, paths, credentials (`@`), IPv6
/// literals / bare IP-literal brackets, and anything that is not a hostname / wildcard
/// hostname / IPv4 with an optional decimal port.
fn normalize_network_domain(entry: &str) -> Result<String, String> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Err("`network.domains` entry must not be empty".to_string());
    }
    if entry.contains("://") {
        return Err(format!(
            "`network.domains` entry `{entry}` must not include a scheme (e.g. `http://`)"
        ));
    }
    if entry.contains('/') {
        return Err(format!(
            "`network.domains` entry `{entry}` must not include a path"
        ));
    }
    if entry.contains('@') {
        return Err(format!(
            "`network.domains` entry `{entry}` must not contain credentials"
        ));
    }
    if entry.starts_with('[') {
        return Err(format!(
            "`network.domains` entry `{entry}` must not be an IP-literal; use a hostname, a \
             leading `*.` wildcard, or a plain IPv4 address"
        ));
    }
    // At most one `:` (the port separator). More colons mean IPv6, which is not allowed.
    let mut segments = entry.split(':');
    let host = segments.next().unwrap_or("");
    let port = segments.next();
    if segments.next().is_some() {
        return Err(format!(
            "`network.domains` entry `{entry}` must not use IPv6 literal syntax"
        ));
    }
    if host.is_empty() {
        return Err(format!("`network.domains` entry `{entry}` has an empty host"));
    }
    let host = host.to_ascii_lowercase();
    let host = normalize_network_host(&host)
        .map_err(|message| format!("`network.domains` entry `{entry}`: {message}"))?;
    if let Some(port) = port {
        if port.is_empty() {
            return Err(format!(
                "`network.domains` entry `{entry}` has an empty port"
            ));
        }
        if port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!(
                "`network.domains` entry `{entry}` has an invalid port (must be 1-65535)"
            ));
        }
        let number: u16 = port.parse().map_err(|_| {
            format!("`network.domains` entry `{entry}` has an invalid port (must be 1-65535)")
        })?;
        if number == 0 {
            return Err(format!(
                "`network.domains` entry `{entry}` has an invalid port (must be 1-65535)"
            ));
        }
        return Ok(format!("{host}:{port}"));
    }
    Ok(host)
}

/// Validate the host part of a domain entry: a lowercased hostname (or leading-`*.` wildcard of
/// one) or an explicitly-listed IPv4 address. Returns it unchanged on success.
fn normalize_network_host(host: &str) -> Result<String, String> {
    let wildcard = host.starts_with("*.");
    let base = if wildcard { &host[2..] } else { host };
    if base.contains('*') {
        return Err("`*` is only allowed as a leading `*.` wildcard (e.g. `*.example.com`)".into());
    }
    if wildcard {
        if base.is_empty() {
            return Err("a `*.` wildcard must be followed by a hostname".into());
        }
        if !base.contains('.') {
            return Err(format!(
                "a `*.` wildcard must cover a full multi-label hostname, not a bare label \
                 (`*.{base}`)"
            ));
        }
    }
    // A dotted string made only of digits and dots must be a well-formed IPv4 address; reject
    // anything that merely looks numeric (5-label "1.2.3.4.5", octets over 255, ...) so no
    // ambiguous near-IP string slips into the allowlist.
    let ipv4_candidate = !wildcard
        && base.contains('.')
        && base
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.');
    if ipv4_candidate {
        let octets: Vec<&str> = base.split('.').collect();
        if octets.len() != 4 {
            return Err(format!("`{base}` is not a valid IPv4 address (needs four octets)"));
        }
        for octet in &octets {
            if octet.is_empty() || octet.len() > 3 || !octet.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!("`{base}` is not a valid IPv4 address"));
            }
            octet
                .parse::<u8>()
                .map_err(|_| format!("`{base}` is not a valid IPv4 address"))?;
        }
        return Ok(host.to_string());
    }
    validate_hostname_labels(base)?;
    Ok(host.to_string())
}

/// Validate that `host` is a plain hostname: total length <= 253, every label 1-63 chars of
/// ASCII letters/digits/hyphens, no label starting or ending with a hyphen, and no empty or
/// leading/trailing labels.
fn validate_hostname_labels(host: &str) -> Result<(), String> {
    if host.len() > 253 {
        return Err("hostname must be at most 253 characters".into());
    }
    if host.starts_with('.') || host.ends_with('.') || host.contains("..") {
        return Err("hostname must not contain empty labels".into());
    }
    for label in host.split('.') {
        if label.is_empty() {
            return Err("hostname must not contain empty labels".into());
        }
        if label.len() > 63 {
            return Err(format!("hostname label `{label}` is longer than 63 characters"));
        }
        let bytes = label.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
            return Err(format!(
                "hostname label `{label}` must start and end with an alphanumeric character"
            ));
        }
        if !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            return Err(format!(
                "hostname label `{label}` contains an invalid character \
                 (letters, digits, and hyphens only)"
            ));
        }
    }
    Ok(())
}

/// Parse a validated raw `network` JSON value into its typed form. Only call after
/// [`validate_network_schema`] succeeded, so the typed parse cannot fail. `null` (and absence)
/// map to `None`, matching the schema-validation gate.
fn parse_network_manifest(
    network: Option<&serde_json::Value>,
) -> Result<Option<NetworkManifest>, String> {
    match network {
        Some(value) if value.is_null() => Ok(None),
        Some(value) => {
            let mut manifest: NetworkManifest = serde_json::from_value(value.clone())
                .map_err(|e| format!("manifest network: {e}"))?;
            // Validation guaranteed well-formed entries; lowercase them so Core's allowlist
            // matching is case-insensitive without normalizing at request time.
            for domain in &mut manifest.domains {
                *domain = domain.to_ascii_lowercase();
            }
            Ok(Some(manifest))
        }
        None => Ok(None),
    }
}

/// Parse a validated raw `config` JSON value into its typed per-key schema
/// ([`ConfigField`] map). Only call after [`validate_config_schema`] succeeded, so the typed
/// parse cannot fail.
fn parse_plugin_config(
    config: Option<&serde_json::Value>,
) -> Result<BTreeMap<String, ConfigField>, String> {
    match config {
        // `null` is treated as "no config schema", matching the schema-validation gate
        // (`if !m.config.is_null()`), so a manifest with an explicit `"config": null` (accepted
        // before typed config landed) still installs with an empty schema.
        Some(value) if value.is_null() => Ok(BTreeMap::new()),
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|e| format!("manifest config: {e}"))
        }
        None => Ok(BTreeMap::new()),
    }
}

/// Crate (native engine) version, from `Cargo.toml` (`version.workspace`).
/// This is the *engine* version. It is managed independently from the CLI
/// (`@tronhawk/cli`) version and from the host runtime protocol version
/// ([`HOST_PROTOCOL_VERSION`]); never assume the three are equal.
pub fn engine_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Validate a `manifest.json` value and resolve its entry files against `root`, using the default
/// host protocol version [`HOST_PROTOCOL_VERSION`].
pub fn validate_manifest(manifest: &serde_json::Value, root: &Path) -> Result<Plugin, String> {
    validate_manifest_for_host(manifest, root, HOST_PROTOCOL_VERSION)
}

/// Validate a `manifest.json` value and resolve its entry files against `root` for an explicit
/// host runtime protocol version. See [`validate_manifest_schema_for_host`] for the protocol gate.
pub fn validate_manifest_for_host(
    manifest: &serde_json::Value,
    root: &Path,
    host_version: &str,
) -> Result<Plugin, String> {
    validate_manifest_schema_for_host(manifest, host_version)?;

    let id = require_str(manifest, "id")?.to_string();
    let name = require_str(manifest, "name")?.to_string();
    let version = require_str(manifest, "version")?.to_string();
    let author = require_str(manifest, "author")?.to_string();
    let tronhawk = require_str(manifest, "tronhawk")?.to_string();

    let permissions = manifest
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let css = match manifest.get("css") {
        Some(v) => Some(v.as_str().ok_or("`css` must be a string")?.to_string()),
        None => match manifest.get("entry").and_then(|e| e.get("css")) {
            Some(v) => {
                let rel = v.as_str().ok_or("`entry.css` must be a string")?;
                let p = resolve_within(root, rel)?;
                Some(std::fs::read_to_string(&p).map_err(|e| format!("read css: {e}"))?)
            }
            None => None,
        },
    };

    let renderer = match manifest.get("entry").and_then(|e| e.get("renderer")) {
        Some(v) => {
            let rel = v.as_str().ok_or("`entry.renderer` must be a string")?;
            let p = resolve_within(root, rel)?;
            Some(std::fs::read_to_string(&p).map_err(|e| format!("read renderer: {e}"))?)
        }
        None => None,
    };

    let main = match manifest.get("entry").and_then(|e| e.get("main")) {
        Some(v) => {
            let rel = v.as_str().ok_or("`entry.main` must be a string")?;
            let p = resolve_within(root, rel)?;
            Some(std::fs::read_to_string(&p).map_err(|e| format!("read main: {e}"))?)
        }
        None => None,
    };

    let config = parse_plugin_config(manifest.get("config"))?;
    let network = parse_network_manifest(manifest.get("network"))?;

    Ok(Plugin {
        id,
        name,
        version,
        author,
        tronhawk,
        permissions,
        css,
        renderer,
        main,
        config,
        network,
    })
}

/// Load a plugin from an unpacked directory containing `manifest.json`, using the default host
/// protocol version [`HOST_PROTOCOL_VERSION`].
pub fn load_plugin_dir(dir: &Path) -> Result<Plugin, String> {
    load_plugin_dir_for_host(dir, HOST_PROTOCOL_VERSION)
}

/// Load a plugin from an unpacked directory for an explicit host runtime protocol version.
pub fn load_plugin_dir_for_host(dir: &Path, host_version: &str) -> Result<Plugin, String> {
    let root = dir.canonicalize().map_err(|e| format!("plugin dir: {e}"))?;
    let manifest_path = root.join("manifest.json");
    let manifest: serde_json::Value = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}")))?;
    validate_manifest_for_host(&manifest, &root, host_version)
}

/// Pack a plugin directory into a `.thx` (ZIP) archive. Symlinks are refused, entries are
/// sorted, and ZIP names use `/` separators.
///
/// This is the default-host entry point: it delegates to [`pack_for_host`] with
/// [`HOST_PROTOCOL_VERSION`]. The archive is written to a temporary file in the output's
/// directory, round-tripped through [`extract_for_host`] (same crate, same host version), and
/// only then atomically renamed to `output`, so a failed pack never leaves a half-written `.thx`.
pub fn pack(dir: &Path, output: &Path) -> Result<(), String> {
    pack_for_host(dir, output, HOST_PROTOCOL_VERSION)
}

/// Pack a plugin directory into a `.thx` archive for an explicit host runtime protocol version.
///
/// This is the single authoritative atomic-publish implementation (build → round-trip
/// extract → atomic rename). Callers must invoke it exactly once per publish; no outer
/// retry/copy/rename wrapper is needed or allowed.
///
/// Guarantees (Gate 2):
/// - The plugin is validated with [`load_plugin_dir_for_host`] *before* anything is written.
/// - Every input file is checked against the same archive filename/size/conflict rules the
///   extract side enforces ([`validate_archive_entry_name`]/[`track_entry_name`], entry-count and
///   byte caps), so `pack` refuses inputs `extract` would reject.
/// - The ZIP is written to an unpredictable, exclusively-created temporary file beside
///   `output` (same directory ⇒ same filesystem ⇒ atomic rename), extracted back via
///   [`extract_for_host`] (same crate, same `host_version`) as a round-trip installability
///   proof, and only then atomically renamed to `output`.
/// - The output parent directory must already exist (never auto-created): a missing parent
///   is an explicit failure, so an output can never silently land in the source tree when
///   the intended parent failed to resolve. A pre-placed symlink at `output` is refused.
/// - Temp files/dirs use RAII guards: any failure (write, round-trip, publish) leaves
///   neither the final output (when it did not exist) nor any temp file/dir behind, and
///   never truncates or follows a pre-placed file/symlink.
pub fn pack_for_host(dir: &Path, output: &Path, host_version: &str) -> Result<(), String> {
    // Validate the plugin before packing (same schema + protocol gate as install).
    let source_plugin =
        load_plugin_dir_for_host(dir, host_version).map_err(|e| format!("invalid plugin: {e}"))?;
    // Re-check the protocol gate explicitly so the error names both sides even when the
    // directory loader already did (keeps `pack --host-version` failures actionable).
    let manifest_value = read_dir_manifest(dir)?;
    validate_manifest_schema_for_host(&manifest_value, host_version)
        .map_err(|e| format!("invalid plugin: {e}"))?;
    let dir_canon = dir.canonicalize().map_err(|e| format!("pack dir: {e}"))?;
    let file_name = output
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "output must have a file name".to_string())?
        .to_string();
    // Effective parent (bare `out.thx` ⇒ current dir `.`) must already exist; pack never
    // auto-creates it. This also closes the old bypass where a missing parent skipped the
    // inside-source check (`canonicalize` failing ⇒ `Ok` guard skipped) and then
    // `create_dir_all` silently created an output inside the source tree.
    let raw_parent: PathBuf = match output.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if !raw_parent.is_dir() {
        return Err(format!(
            "output parent directory does not exist: {}",
            raw_parent.display()
        ));
    }
    // Fail closed on a pre-placed symlink at the final output: the atomic rename would
    // replace the link itself (not its target), but refusing outright keeps symlink
    // attacks fail-closed with no residue and no ambiguity.
    if let Ok(meta) = std::fs::symlink_metadata(output) {
        if meta.file_type().is_symlink() {
            return Err("output must not be a symlink".to_string());
        }
    }
    let parent_canon = raw_parent
        .canonicalize()
        .map_err(|e| format!("output parent: {e}"))?;
    if parent_canon.starts_with(&dir_canon) {
        return Err("output must not be inside the source directory".to_string());
    }

    let mut entries = Vec::new();
    collect_files(&dir_canon, &mut entries)?;
    entries.sort();
    // Enforce the extract-side archive rules on the *input* (names, sizes, collisions).
    check_pack_entries(&dir_canon, &entries)?;

    // Temp file beside `output` (same filesystem) with a random name + exclusive create.
    // The guard removes it on every early return, so failures leave no temp behind.
    let (tmp_path, tmp_file, mut tmp_guard) =
        create_sibling_temp_file(output, &file_name)?;

    // Write the ZIP via the exclusively-created handle (no TOCTOU between create + open).
    let write_result = (|| -> Result<(), String> {
        let mut zip = zip::ZipWriter::new(tmp_file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for entry in &entries {
            let rel = entry
                .strip_prefix(&dir_canon)
                .map_err(|e| format!("strip prefix: {e}"))?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            zip.start_file(&rel_str, options)
                .map_err(|e| format!("zip start: {e}"))?;
            let mut f =
                File::open(entry).map_err(|e| format!("open {}: {e}", entry.display()))?;
            std::io::copy(&mut f, &mut zip).map_err(|e| format!("zip copy: {e}"))?;
        }
        let inner = zip.finish().map_err(|e| format!("zip finish: {e}"))?;
        // Close the write handle before the round-trip read (Windows share semantics).
        drop(inner);
        Ok(())
    })();
    if let Err(e) = write_result {
        // `tmp_guard` drops here and removes the temp file; `output` was never touched.
        return Err(e);
    }

    // Same-crate round-trip: the freshly written archive must extract cleanly for the same
    // host version. This proves installability before the atomic publish.
    // `tmp_guard` stays alive across this call, so a round-trip-dir creation failure
    // still cleans the temp `.thx` (the old leak). `_rt_guard` cleans the scratch dir.
    let (rt_path, _rt_guard) = create_roundtrip_dir()?;
    let roundtrip_result = extract_for_host(&tmp_path, &rt_path, host_version);
    match roundtrip_result {
        Ok(roundtripped) => {
            if roundtripped.id != source_plugin.id {
                return Err(format!(
                    "pack round-trip id mismatch: source `{}` vs archive `{}`",
                    source_plugin.id, roundtripped.id
                ));
            }
        }
        Err(e) => {
            return Err(format!("pack round-trip failed: {e}"));
        }
    }

    // Atomic publish: rename the verified temp file onto the final output.
    // On failure the guard removes the temp; the pre-existing output (if any) is untouched.
    std::fs::rename(&tmp_path, output).map_err(|e| format!("publish thx: {e}"))?;
    tmp_guard.disarm();
    Ok(())
}

/// Read and parse `manifest.json` from an unpacked plugin directory (no entry-file resolution).
fn read_dir_manifest(dir: &Path) -> Result<serde_json::Value, String> {
    let root = dir.canonicalize().map_err(|e| format!("plugin dir: {e}"))?;
    let manifest_path = root.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("invalid manifest: {e}"))
}

/// Enforce the extract-side archive rules on pack *inputs* so `pack` refuses what `extract`
/// would reject: entry-count cap, per-file and total uncompressed caps, Windows-safe entry
/// names ([`validate_archive_entry_name`]), and byte-identical / case-folding collisions
/// ([`track_entry_name`]). `entries` must already be sorted; ZIP names use `/` separators.
fn check_pack_entries(dir_canon: &Path, entries: &[PathBuf]) -> Result<(), String> {
    if entries.len() > MAX_ENTRIES {
        return Err(format!("plugin has too many files ({})", entries.len()));
    }
    // A `.thx` without `manifest.json` at its root would fail `extract` ("archive missing
    // manifest.json"); refuse it at pack time with the same actionable message.
    let has_manifest = entries.iter().any(|p| {
        p.strip_prefix(dir_canon)
            .map(|rel| rel.to_string_lossy().replace('\\', "/") == "manifest.json")
            .unwrap_or(false)
    });
    if !has_manifest {
        return Err("archive missing manifest.json".to_string());
    }
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut total: u64 = 0;
    for entry in entries {
        let rel = entry
            .strip_prefix(dir_canon)
            .map_err(|e| format!("strip prefix: {e}"))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let meta = std::fs::metadata(entry).map_err(|e| format!("metadata: {e}"))?;
        let size = meta.len();
        if size > MAX_SINGLE_FILE {
            return Err(format!("archive entry too large: {rel_str}"));
        }
        total += size;
        if total > MAX_TOTAL_SIZE {
            return Err("archive uncompressed size too large".to_string());
        }
        let key = validate_archive_entry_name(&rel_str)?;
        track_entry_name(&mut seen, key, &rel_str)?;
        // Path containment for the planned ZIP name (mirrors the extract-side `safe_join`).
        let _ = safe_join(Path::new("."), &rel_str)?;
    }
    Ok(())
}

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Try to fill `buf` from the OS RNG (`/dev/urandom` on Unix/MSYS2). Returns true only when
/// the full buffer was filled. Native Windows has no `/dev/urandom`; callers fall back to
/// the `RandomState` mixer below (whose keys are themselves OS-seeded inside std).
fn fill_os_random(buf: &mut [u8]) -> bool {
    if let Ok(mut f) = File::open("/dev/urandom") {
        use std::io::Read;
        let mut off = 0;
        while off < buf.len() {
            match f.read(&mut buf[off..]) {
                Ok(0) => break,
                Ok(n) => off += n,
                Err(_) => break,
            }
        }
        if off == buf.len() {
            return true;
        }
    }
    false
}

/// One unpredictable 64-bit value. Prefers OS randomness; falls back to mixing
/// process-unique inputs through a freshly-seeded `RandomState` (keys are OS-seeded inside
/// std via getrandom/RtlGenRandom), so the output is unpredictable per call without new
/// dependencies. `seed` guarantees uniqueness across calls even within one nanosecond.
fn os_random_u64(seed: u64) -> u64 {
    let mut buf = [0u8; 8];
    if fill_os_random(&mut buf) {
        return u64::from_le_bytes(buf);
    }
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};
    let rs = RandomState::new();
    let mut h = rs.build_hasher();
    h.write_u64(seed);
    h.write_u32(std::process::id());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    h.write_u128(nanos);
    let stack_byte = 0u8;
    h.write_usize(&stack_byte as *const u8 as usize);
    h.write(format!("{:?}", std::thread::current().id()).as_bytes());
    h.finish()
}

/// 128-bit unpredictable hex suffix for temp file/dir names. The per-call counter folded
/// into the seeds guarantees uniqueness even if two calls share a timestamp.
fn random_suffix() -> String {
    let c = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(
        "{:016x}{:016x}",
        os_random_u64(c),
        os_random_u64(c ^ 0x9e37_79b9_7f4a_7c15)
    )
}

/// RAII guard for the pack temp `.thx`: removes the temp file on drop unless disarmed.
/// Guarantees "failure leaves no temp" on every early return.
struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }
    #[allow(dead_code)]
    fn path(&self) -> &Path {
        self.path
            .as_ref()
            .expect("temp file guard was disarmed")
            .as_path()
    }
    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            std::fs::remove_file(&p).ok();
        }
    }
}

/// RAII guard for the pack round-trip scratch dir: removes it recursively on drop unless
/// disarmed.
struct TempDirGuard {
    path: Option<PathBuf>,
}

impl TempDirGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }
    #[allow(dead_code)]
    fn path(&self) -> &Path {
        self.path
            .as_ref()
            .expect("temp dir guard was disarmed")
            .as_path()
    }
    #[allow(dead_code)]
    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            std::fs::remove_dir_all(&p).ok();
        }
    }
}

/// Exclusively create `path` (`O_EXCL` / `CREATE_NEW`): fails with `AlreadyExists` instead
/// of truncating a pre-placed file or following a pre-placed symlink. This is the only way
/// pack creates its temp file (via [`create_sibling_temp_file`]).
fn create_exclusive_file(path: &Path) -> std::io::Result<File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Create an unpredictable, exclusively-created temp `.thx` beside `output` (same directory
/// ⇒ same filesystem ⇒ atomic rename). Retries on the (negligible) random collision.
/// The returned guard owns the temp path and removes it unless disarmed after publish.
fn create_sibling_temp_file(
    output: &Path,
    file_name: &str,
) -> Result<(PathBuf, File, TempFileGuard), String> {
    let mut last_err = String::new();
    for _ in 0..10 {
        let tmp_name = format!(".{file_name}.tmp-{}.thx", random_suffix());
        let tmp_path = match output.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.join(tmp_name),
            _ => PathBuf::from(tmp_name),
        };
        match create_exclusive_file(&tmp_path) {
            Ok(f) => {
                let guard = TempFileGuard::new(tmp_path.clone());
                return Ok((tmp_path, f, guard));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = format!("create thx temp: {e}");
                continue;
            }
            Err(e) => return Err(format!("create thx temp: {e}")),
        }
    }
    Err(if last_err.is_empty() {
        "create thx temp: too many collisions".to_string()
    } else {
        last_err
    })
}

/// Create an unpredictable, exclusively-created scratch directory for the pack round-trip
/// extract. Uses `create_dir` (not `create_dir_all`) so a pre-placed file/symlink/dir at
/// the chosen name fails closed instead of being reused. The guard removes it on drop.
fn create_roundtrip_dir() -> Result<(PathBuf, TempDirGuard), String> {
    let base = std::env::temp_dir();
    let mut last_err = String::new();
    for _ in 0..10 {
        let dir = base.join(format!("tronhawk-pack-rt-{}", random_suffix()));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                let guard = TempDirGuard::new(dir.clone());
                return Ok((dir, guard));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = format!("round-trip dir: {e}");
                continue;
            }
            Err(e) => return Err(format!("round-trip dir: {e}")),
        }
    }
    Err(if last_err.is_empty() {
        "round-trip dir: too many collisions".to_string()
    } else {
        last_err
    })
}

/// Machine-readable archive report for the `inspect` subcommand.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchiveInspect {
    /// Parsed `manifest.json` from the archive root.
    pub manifest: serde_json::Value,
    /// Sorted ZIP entry names (`/` separators, as stored).
    pub entries: Vec<String>,
    /// Number of entries.
    pub entry_count: usize,
    /// Total uncompressed bytes across entries.
    pub total_uncompressed: u64,
    /// Engine (crate) version that produced this report.
    pub engine_version: String,
    /// Host protocol version the manifest was validated against.
    pub host_protocol: String,
}

/// Inspect a `.thx` archive without extracting it: list entries, parse `manifest.json`, and
/// validate the manifest schema against the default host protocol version
/// ([`HOST_PROTOCOL_VERSION`]). No JS is executed and nothing is written to `dest`.
pub fn inspect_archive(thx: &Path) -> Result<ArchiveInspect, String> {
    inspect_archive_for_host(thx, HOST_PROTOCOL_VERSION)
}

/// Inspect a `.thx` archive for an explicit host runtime protocol version.
/// In addition to the manifest-schema + protocol gate, every entry is checked against the same
/// hardening the extract path enforces (count/size caps, safe names, collision rules), and
/// every manifest-declared entry file (`entry.css`/`entry.renderer`/`entry.main`) must be
/// present in the archive, so `inspect` agrees with `extract` on what is installable.
pub fn inspect_archive_for_host(thx: &Path, host_version: &str) -> Result<ArchiveInspect, String> {
    reject_duplicate_archive_entries(thx)?;
    let file = File::open(thx).map_err(|e| format!("open thx: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("archive has too many entries ({})", archive.len()));
    }
    let manifest = read_manifest(&mut archive)?;
    validate_manifest_schema_for_host(&manifest, host_version)?;
    let mut entries = Vec::with_capacity(archive.len());
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut total: u64 = 0;
    let mut total_compressed: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let name = entry.name().to_string();
        let size = entry.size();
        let compressed = entry.compressed_size();
        if size > MAX_SINGLE_FILE {
            return Err(format!("archive entry too large: {name}"));
        }
        total += size;
        if total > MAX_TOTAL_SIZE {
            return Err("archive uncompressed size too large".to_string());
        }
        if size > MAX_COMPRESSION_RATIO.saturating_mul(compressed.max(1)) {
            return Err(format!(
                "archive entry `{name}` has a suspicious compression ratio \
                 ({size} bytes uncompressed from {compressed} bytes compressed)"
            ));
        }
        total_compressed += compressed;
        if total_compressed > 0 && total > MAX_COMPRESSION_RATIO.saturating_mul(total_compressed) {
            return Err(format!(
                "archive compression ratio too high \
                 ({total} bytes uncompressed from {total_compressed} bytes compressed)"
            ));
        }
        let key = validate_archive_entry_name(&name)?;
        track_entry_name(&mut seen, key, &name)?;
        // Path containment (same `safe_join` the extract path uses).
        let _ = safe_join(Path::new("."), &name)?;
        entries.push(name);
    }
    entries.sort();
    // Manifest-declared entry files must really be in the archive (Gate 2): a manifest
    // pointing at a missing file is not installable (`extract` would fail at Phase 3
    // entry resolution), so `inspect` fails here for the CLI to pass through.
    check_inspect_entry_presence(&manifest, &entries)?;
    Ok(ArchiveInspect {
        manifest,
        entry_count: entries.len(),
        total_uncompressed: total,
        entries,
        engine_version: engine_version().to_string(),
        host_protocol: host_version.to_string(),
    })
}

/// Verify that every manifest-declared entry file (`entry.css`/`entry.renderer`/`entry.main`)
/// is present in the archive's entry list. Archive names use `/` separators (as stored);
/// manifest values are normalized the same way pack normalizes them (`\` → `/`) before the
/// exact-match lookup. A directory entry (`foo/`) never satisfies a file reference (`foo`).
fn check_inspect_entry_presence(
    manifest: &serde_json::Value,
    entries: &[String],
) -> Result<(), String> {
    let entry = match manifest.get("entry") {
        None => return Ok(()),
        Some(v) if v.is_null() => return Ok(()),
        Some(v) => v,
    };
    let obj = entry
        .as_object()
        .ok_or_else(|| "manifest schema: `entry` must be an object".to_string())?;
    // `entries` is sorted; a set gives O(1) exact lookups.
    let set: std::collections::HashSet<&str> =
        entries.iter().map(|s| s.as_str()).collect();
    for key in ["css", "renderer", "main"] {
        let rel = match obj.get(key) {
            None => continue,
            Some(v) if v.is_null() => continue,
            Some(v) => v
                .as_str()
                .ok_or_else(|| format!("`entry.{key}` must be a string"))?,
        };
        let normalized = rel.replace('\\', "/");
        if !set.contains(normalized.as_str()) {
            return Err(format!(
                "manifest entry `entry.{key}` file `{rel}` missing from archive"
            ));
        }
    }
    Ok(())
}

/// Extract a `.thx` archive into `dest`, validating the manifest schema (against the default host
/// protocol version [`HOST_PROTOCOL_VERSION`]) *before* any file is written, then performing full
/// validation after extraction. See [`extract_for_host`] to pass an explicit host version.
pub fn extract(thx: &Path, dest: &Path) -> Result<Plugin, String> {
    extract_for_host(thx, dest, HOST_PROTOCOL_VERSION)
}

/// Extract a `.thx` archive into `dest`, validating the manifest schema against an explicit host
/// runtime protocol version. Every rejection (bad schema, incompatible `tronhawk` protocol range,
/// too many/too large entries, unsafe names, zip-bomb ratios) happens in Phase 1 / Phase 1b —
/// before a single byte of the archive is written to `dest` (fail-at-start). Path containment is
/// enforced by [`safe_join`] for every entry in that same phase.
pub fn extract_for_host(thx: &Path, dest: &Path, host_version: &str) -> Result<Plugin, String> {
    // Byte-identical duplicate entry names are rejected before the archive is even parsed: the
    // `zip` reader silently collapses them (last-wins), which would let a hostile archive smuggle
    // ambiguous entries past the per-entry checks below.
    reject_duplicate_archive_entries(thx)?;

    let file = File::open(thx).map_err(|e| format!("open thx: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;

    // Phase 1: read + validate the manifest schema (including the `tronhawk` protocol gate)
    // before writing anything.
    let manifest = read_manifest(&mut archive)?;
    validate_manifest_schema_for_host(&manifest, host_version)?;

    // Phase 1b: enforce archive limits, entry-name hardening, compression-ratio limits, and path
    // containment for EVERY entry before any file is written (fail-at-start). The planned output
    // paths are precomputed here so Phase 2 can never discover a bad name mid-write.
    if archive.len() > MAX_ENTRIES {
        return Err(format!("archive has too many entries ({})", archive.len()));
    }
    let mut planned: Vec<PathBuf> = Vec::with_capacity(archive.len());
    let mut seen_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut total: u64 = 0;
    let mut total_compressed: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let name = entry.name();
        let size = entry.size();
        let compressed = entry.compressed_size();

        // Absolute byte caps (unchanged behavior).
        if size > MAX_SINGLE_FILE {
            return Err(format!("archive entry too large: {name}"));
        }
        total += size;
        if total > MAX_TOTAL_SIZE {
            return Err("archive uncompressed size too large".to_string());
        }

        // Compression-ratio guard: a tiny compressed payload must not expand beyond a sane ratio
        // even while staying under the absolute byte caps above.
        if size > MAX_COMPRESSION_RATIO.saturating_mul(compressed.max(1)) {
            return Err(format!(
                "archive entry `{name}` has a suspicious compression ratio \
                 ({size} bytes uncompressed from {compressed} bytes compressed)"
            ));
        }
        total_compressed += compressed;
        if total_compressed > 0 && total > MAX_COMPRESSION_RATIO.saturating_mul(total_compressed) {
            return Err(format!(
                "archive compression ratio too high \
                 ({total} bytes uncompressed from {total_compressed} bytes compressed)"
            ));
        }

        // Name hardening: duplicates, Windows reserved names, trailing dot/space, ADS syntax.
        let key = validate_archive_entry_name(name)?;
        track_entry_name(&mut seen_names, key, name)?;

        // Path containment (safe_join) — validated here so it fails before any write.
        planned.push(safe_join(dest, name)?);
    }

    // Phase 2: extract all pre-validated entries.
    for (i, out_path) in planned.iter().enumerate() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        if entry.is_dir() {
            std::fs::create_dir_all(out_path).map_err(|e| format!("mkdir: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
            }
            let mut out = File::create(out_path).map_err(|e| format!("create: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract: {e}"))?;
        }
    }

    // Phase 3: full validation (resolves + reads entry files) against the same host version.
    load_plugin_dir_for_host(dest, host_version)
}

// --- helpers ---

/// Scan a `.thx` archive's central directory for byte-identical duplicate entry names and reject
/// them before any parsing/extraction happens. Needed because the `zip` reader silently collapses
/// duplicate names (last-wins) instead of reporting them, so without this scan a duplicate-name
/// archive would pass the per-entry checks below and extract ambiguously.
fn reject_duplicate_archive_entries(thx: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let file = File::open(thx).map_err(|e| format!("open thx: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("thx metadata: {e}"))?
        .len();
    // A ZIP ends with an End-Of-Central-Directory record (22 bytes) plus an optional comment
    // (<= 65535 bytes). Locate it by scanning backwards from the end of the file.
    if len < 22 {
        return Ok(()); // too short to be a real ZIP; let ZipArchive produce the proper error
    }
    let tail_start = len.saturating_sub(22 + 65535);
    let mut file = file;
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|e| format!("thx seek: {e}"))?;
    let tail_len = (len - tail_start) as usize;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| format!("thx read: {e}"))?;

    let mut eocd = None;
    for i in (0..=tail.len() - 22).rev() {
        if &tail[i..i + 4] == b"PK\x05\x06" {
            eocd = Some(i);
            break;
        }
    }
    let eocd = match eocd {
        Some(i) => i,
        None => return Ok(()), // not a parseable ZIP; let ZipArchive report it
    };
    let cd_size = u32::from_le_bytes([
        tail[eocd + 12],
        tail[eocd + 13],
        tail[eocd + 14],
        tail[eocd + 15],
    ]) as u64;
    let cd_offset = u32::from_le_bytes([
        tail[eocd + 16],
        tail[eocd + 17],
        tail[eocd + 18],
        tail[eocd + 19],
    ]) as u64;
    if cd_offset + cd_size > len {
        return Ok(()); // malformed offsets; let ZipArchive report it
    }

    file.seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("thx seek: {e}"))?;
    let mut cd = vec![0u8; cd_size as usize];
    file.read_exact(&mut cd)
        .map_err(|e| format!("thx read: {e}"))?;

    let mut seen = std::collections::HashSet::new();
    let mut pos = 0usize;
    while pos + 46 <= cd.len() {
        if &cd[pos..pos + 4] != b"PK\x01\x02" {
            break;
        }
        let name_len = u16::from_le_bytes([cd[pos + 28], cd[pos + 29]]) as usize;
        let extra_len = u16::from_le_bytes([cd[pos + 30], cd[pos + 31]]) as usize;
        let comment_len = u16::from_le_bytes([cd[pos + 32], cd[pos + 33]]) as usize;
        let record = 46 + name_len + extra_len + comment_len;
        if pos + record > cd.len() {
            break;
        }
        let name = String::from_utf8_lossy(&cd[pos + 46..pos + 46 + name_len]).into_owned();
        if !seen.insert(name.clone()) {
            return Err(format!(
                "duplicate archive entry: `{name}` appears more than once"
            ));
        }
        pos += record;
    }
    Ok(())
}

fn read_manifest(archive: &mut zip::ZipArchive<File>) -> Result<serde_json::Value, String> {
    let mut idx = None;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| format!("zip entry: {e}"))?
            .name()
            .replace('\\', "/");
        if name == "manifest.json" {
            idx = Some(i);
            break;
        }
    }
    let i = idx.ok_or("archive missing manifest.json")?;
    let mut entry = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
    if entry.size() > MAX_MANIFEST_SIZE {
        return Err("manifest.json too large".to_string());
    }
    let mut s = String::new();
    entry
        .read_to_string(&mut s)
        .map_err(|e| format!("read manifest: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("invalid manifest: {e}"))
}

fn require_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("manifest missing `{key}`"))
}

fn resolve_within(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(format!("entry path must be relative: {rel}"));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("entry path must not escape the plugin dir: {rel}"));
    }
    let joined = root.join(p);
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("entry path does not resolve: {rel} ({e})"))?;
    if !canon.starts_with(root) {
        return Err(format!("entry path escapes the plugin dir: {rel}"));
    }
    Ok(canon)
}

/// Guard against zip-slip: allow only `Normal` path components. Reject absolute paths,
/// root-relative paths (`\foo`), drive-relative paths (`C:foo`), UNC, and `..`.
fn safe_join(dest: &Path, name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    let p = Path::new(&normalized);
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(format!("archive entry escapes dest: {name}"));
        }
    }
    Ok(dest.join(p))
}

/// Windows-filesystem hardening for a single archive entry name. Rejects, with a clear message:
/// empty names / empty path segments, NTFS alternate-data-stream (`:`) syntax, any path segment
/// ending in `.` or a space (Windows silently trims these, enabling collisions), and Windows
/// reserved device names (see [`is_windows_reserved_name`]).
///
/// On success returns a canonical key used for duplicate detection: separators normalized to `/`,
/// the trailing `/` directory marker removed, and everything lower-cased — mirroring how the name
/// resolves on a Windows case-insensitive filesystem. Collisions are detected by
/// [`track_entry_name`].
fn validate_archive_entry_name(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("archive entry has an empty name".to_string());
    }
    let normalized = name.replace('\\', "/");
    let mut segments: Vec<&str> = normalized.split('/').collect();
    // A trailing separator marks a directory entry; drop it for segment checks and the key.
    if segments.last() == Some(&"") {
        segments.pop();
    }
    if segments.is_empty() {
        return Err(format!("archive entry has an empty name: {name}"));
    }

    let mut key = String::new();
    for (i, seg) in segments.iter().enumerate() {
        if seg.is_empty() {
            return Err(format!("archive entry has an empty path segment: {name}"));
        }
        if seg.contains(':') {
            return Err(format!(
                "archive entry `{name}` uses `:` in a name segment \
                 (NTFS alternate data stream / path syntax is not supported)"
            ));
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err(format!(
                "archive entry `{name}`: path segment `{seg}` ends with '.' or a space \
                 (unsafe on Windows filesystems)"
            ));
        }
        if is_windows_reserved_name(seg) {
            return Err(format!(
                "archive entry `{name}` uses the Windows reserved device name `{seg}`"
            ));
        }
        if i > 0 {
            key.push('/');
        }
        key.push_str(&seg.to_ascii_lowercase());
    }
    Ok(key)
}

/// Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, and
/// `CONIN$`/`CONOUT$`), matched case-insensitively against the base name *before the first `.`* —
/// so `NUL`, `NUL.txt`, `con.log`, and directory segments like `COM1` are all rejected, while a
/// name such as `foo.con` (stem `foo`) is fine. NTFS also maps superscript-digit device names
/// (`COM¹`, `LPT²`, ...) to the plain device names, so those are rejected too.
fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    let upper: Vec<char> = stem.to_ascii_uppercase().chars().collect();
    let mut name: String = upper.iter().collect();
    // Normalize a trailing superscript digit on a COM*/LPT* stem to its ASCII digit.
    if upper.len() == 4 && (upper[..3] == ['C', 'O', 'M'] || upper[..3] == ['L', 'P', 'T']) {
        if let Some(d) = superscript_digit(upper[3]) {
            name = format!("{}{}", upper[..3].iter().collect::<String>(), d);
        }
    }
    matches!(
        name.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (name.len() == 4
        && (name.starts_with("COM") || name.starts_with("LPT"))
        && name.as_bytes()[3].is_ascii_digit()
        && name.as_bytes()[3] != b'0')
}

fn superscript_digit(c: char) -> Option<char> {
    match c {
        '¹' => Some('1'),
        '²' => Some('2'),
        '³' => Some('3'),
        '⁴' => Some('4'),
        '⁵' => Some('5'),
        '⁶' => Some('6'),
        '⁷' => Some('7'),
        '⁸' => Some('8'),
        '⁹' => Some('9'),
        _ => None,
    }
}

/// Record one archive entry name into the duplicate-detection set `seen`, whose keys are the
/// canonical case-folded names produced by [`validate_archive_entry_name`]. Rejects byte-identical
/// duplicates ("duplicate archive entry") and names that collide only after case-folding or path
/// normalization ("collides ... on a case-insensitive filesystem"), with a clear message.
fn track_entry_name(
    seen: &mut std::collections::HashMap<String, String>,
    key: String,
    name: &str,
) -> Result<(), String> {
    if let Some(prev) = seen.get(&key) {
        if prev.as_str() == name {
            return Err(format!(
                "duplicate archive entry: `{name}` appears more than once"
            ));
        }
        return Err(format!(
            "archive entry `{name}` collides with `{prev}` on a case-insensitive filesystem"
        ));
    }
    seen.insert(key, name.to_string());
    Ok(())
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("metadata: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("refusing to pack symlink: {}", path.display()));
        }
        if meta.is_dir() {
            collect_files(&path, out)?;
        } else if meta.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_ws() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("tronhawk-pkg-{}-{n}", std::process::id()))
    }

    fn manifest_json(tronhawk: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "com.example.test",
            "name": "Test",
            "version": "1.0.0",
            "author": "A",
            "tronhawk": tronhawk,
            "permissions": []
        })
    }

    fn manifest_bytes(tronhawk: &str) -> Vec<u8> {
        serde_json::to_vec(&manifest_json(tronhawk)).unwrap()
    }

    fn manifest_with_css_bytes() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "id": "com.example.test",
            "name": "Test",
            "version": "1.0.0",
            "author": "A",
            "tronhawk": "^0.1",
            "css": "body{}",
            "permissions": ["renderer.css"]
        }))
        .unwrap()
    }

    /// Build an in-memory ZIP (deflated) from name->content entries.
    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, data) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Run `extract` on an archive and assert it fails (before writing anything) with a message
    /// containing `expected`. Returns the error text.
    fn assert_extract_rejects(entries: &[(&str, &[u8])], expected: &str) -> String {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        std::fs::write(&thx, zip_bytes(entries)).unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract(&thx, &dest).unwrap_err();
        assert!(
            err.contains(expected),
            "expected error containing `{expected}` but got: {err}"
        );
        // Fail-at-start: the offending archive must not have written anything into dest.
        let wrote_anything = std::fs::read_dir(&dest).unwrap().next().is_some();
        assert!(
            !wrote_anything,
            "dest must stay empty on rejection, got: {err}"
        );
        std::fs::remove_dir_all(&ws).ok();
        err
    }

    /// Minimal STORED ZIP builder used for archives the `zip` writer refuses to create (e.g.
    /// byte-identical duplicate filenames). Computes CRC-32 so the reader can parse the payloads.
    fn raw_zip(names_data: &[(&str, &[u8])]) -> Vec<u8> {
        fn crc32(data: &[u8]) -> u32 {
            let mut table = [0u32; 256];
            for (i, item) in table.iter_mut().enumerate() {
                let mut c = i as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 {
                        0xEDB8_8320 ^ (c >> 1)
                    } else {
                        c >> 1
                    };
                }
                *item = c;
            }
            let mut crc = 0xFFFF_FFFFu32;
            for &b in data {
                crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
            }
            !crc
        }
        let mut out = Vec::new();
        let mut entries = Vec::new(); // (local header offset, name, data)
        for &(name, data) in names_data {
            let offset = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04"); // local file header signature
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc32(data).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // compressed size
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // uncompressed size
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra field length
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            entries.push((offset, name, data));
        }
        let cd_start = out.len() as u32;
        for (offset, name, data) in entries {
            out.extend_from_slice(b"PK\x01\x02"); // central directory header signature
            out.extend_from_slice(&20u16.to_le_bytes()); // version made by
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method: stored
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc32(data).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // compressed size
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // uncompressed size
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra field length
            out.extend_from_slice(&0u16.to_le_bytes()); // comment length
            out.extend_from_slice(&0u16.to_le_bytes()); // disk number start
            out.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
            out.extend_from_slice(&0u32.to_le_bytes()); // external attributes
            out.extend_from_slice(&offset.to_le_bytes()); // local header offset
            out.extend_from_slice(name.as_bytes());
        }
        let cd_size = (out.len() as u32) - cd_start;
        out.extend_from_slice(b"PK\x05\x06"); // end of central directory signature
        out.extend_from_slice(&0u16.to_le_bytes()); // this disk
        out.extend_from_slice(&0u16.to_le_bytes()); // central directory disk
        out.extend_from_slice(&(names_data.len() as u16).to_le_bytes()); // entries this disk
        out.extend_from_slice(&(names_data.len() as u16).to_le_bytes()); // total entries
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_start.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment length
        out
    }

    #[test]
    fn pack_extract_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("tronhawk-pkg-{}", std::process::id()));
        let dir = tmp.join("plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"id":"com.example.test","name":"Test","version":"1.0.0","author":"A","tronhawk":"^0.1","css":"body{}","permissions":["renderer.css"]}"#,
        )
        .unwrap();

        let thx = tmp.join("plugin.thx");
        pack(&dir, &thx).unwrap();

        let dest = tmp.join("extracted");
        std::fs::create_dir_all(&dest).unwrap();
        let plugin = extract(&thx, &dest).unwrap();
        assert_eq!(plugin.id, "com.example.test");
        assert!(plugin.css.is_some());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rejects_zip_slip_variants() {
        let dest = Path::new("C:/dest");
        assert!(safe_join(dest, "../evil").is_err());
        assert!(safe_join(dest, "a/../../b").is_err());
        assert!(safe_join(dest, "C:/abs").is_err());
        assert!(safe_join(dest, "\\root-relative").is_err());
        assert!(safe_join(dest, "/root-relative").is_err());
        assert!(safe_join(dest, "C:drive-relative").is_err());
        assert!(safe_join(dest, "//unc/path").is_err());
        assert!(safe_join(dest, "ok/file.txt").is_ok());
    }

    #[test]
    fn rejects_path_traversal_manifest() {
        assert!(resolve_within(Path::new("C:/x"), "../etc/passwd").is_err());
        assert!(resolve_within(Path::new("C:/x"), "C:/etc/passwd").is_err());
    }

    #[test]
    fn rejects_malicious_plugin_id() {
        for bad in ["..", ".", "a/../b", "a\\b", "C:\\x", "a..b", "UPPER", "a b"] {
            let m = serde_json::json!({
                "id": bad,
                "name": "x",
                "version": "1.0.0",
                "author": "a",
                "tronhawk": "^0.1",
                "permissions": []
            });
            assert!(
                validate_manifest_schema(&m).is_err(),
                "id `{bad}` should be rejected"
            );
        }
    }

    // --- `tronhawk` protocol gate -------------------------------------------------

    #[test]
    fn protocol_gate_accepts_compatible_range() {
        // Host 0.1.0 satisfies ranges that include 0.1.x.
        for range in ["^0.1", "0.1.0", ">=0.1.0, <0.2.0", "*"] {
            let m = manifest_json(range);
            validate_manifest_schema_for_host(&m, "0.1.0")
                .unwrap_or_else(|e| panic!("`{range}` must be compatible with host 0.1.0: {e}"));
        }
        // The default entry point delegates to HOST_PROTOCOL_VERSION.
        validate_manifest_schema(&manifest_json("^0.1")).unwrap();
        // Direct gate check.
        validate_tronhawk_protocol("0.1.0", "^0.1").unwrap();
    }

    #[test]
    fn protocol_gate_rejects_incompatible_range() {
        // A well-formed-but-incompatible range is rejected with a message naming both sides.
        let m = manifest_json("^2.0");
        let err = validate_manifest_schema_for_host(&m, "1.0.0").unwrap_err();
        assert!(
            err.contains("`^2.0`"),
            "message should name the range: {err}"
        );
        assert!(
            err.contains("1.0.0"),
            "message should name the host version: {err}"
        );

        // `~0.1.1` means >=0.1.1,<0.2.0 — host 0.1.0 does not satisfy it.
        let m2 = manifest_json("~0.1.1");
        let err2 = validate_manifest_schema_for_host(&m2, "0.1.0").unwrap_err();
        assert!(err2.contains("~0.1.1") && err2.contains("0.1.0"), "{err2}");

        // Direct gate check reports the same mismatch clearly.
        let err3 = validate_tronhawk_protocol("1.0.0", "^2.0").unwrap_err();
        assert!(err3.contains("^2.0") && err3.contains("1.0.0"), "{err3}");
    }

    #[test]
    fn protocol_gate_blocks_extract_before_write() {
        // Default host entry point: `^2.0` plugin vs HOST_PROTOCOL_VERSION (0.1.0) is rejected
        // before anything reaches disk.
        let m = manifest_bytes("^2.0");
        let err = assert_extract_rejects(&[("manifest.json", m.as_slice())], "host protocol is");
        assert!(err.contains("^2.0"), "{err}");

        // Explicit host version threading: a `^0.1` plugin is rejected against host 1.0.0.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        let m2 = manifest_bytes("^0.1");
        std::fs::write(&thx, zip_bytes(&[("manifest.json", m2.as_slice())])).unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err2 = extract_for_host(&thx, &dest, "1.0.0").unwrap_err();
        assert!(
            err2.contains("^0.1") && err2.contains("1.0.0"),
            "explicit host version must be honored: {err2}"
        );
        assert!(std::fs::read_dir(&dest).unwrap().next().is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    // --- Archive hardening --------------------------------------------------------

    #[test]
    fn extract_rejects_duplicate_entry_names() {
        // The `zip` writer refuses to build byte-identical duplicate filenames, so this archive is
        // assembled by hand. `extract`'s central-directory pre-scan must reject it before any
        // parsing or writes reach `dest`.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("dup.thx");
        let m = manifest_bytes("^0.1");
        std::fs::write(
            &thx,
            raw_zip(&[
                ("manifest.json", m.as_slice()),
                ("x.js", b"a"),
                ("x.js", b"b"),
            ]),
        )
        .unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let err = extract(&thx, &dest).unwrap_err();
        assert!(
            err.contains("duplicate archive entry") && err.contains("x.js"),
            "expected a clear duplicate-entry message, got: {err}"
        );
        assert!(std::fs::read_dir(&dest).unwrap().next().is_none());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn duplicate_name_tracking_messages() {
        // Unit-level coverage of the duplicate detector's two message branches.
        let mut seen = std::collections::HashMap::new();
        track_entry_name(&mut seen, "x.js".to_string(), "x.js").unwrap();
        let err = track_entry_name(&mut seen, "x.js".to_string(), "x.js").unwrap_err();
        assert!(err.contains("duplicate archive entry"), "{err}");
        track_entry_name(&mut seen, "foo.js".to_string(), "foo.js").unwrap();
        let err2 = track_entry_name(&mut seen, "foo.js".to_string(), "Foo.js").unwrap_err();
        assert!(err2.contains("case-insensitive"), "{err2}");

        // A file `a` and a directory entry `a/` resolve to the same path on disk.
        let mut seen2 = std::collections::HashMap::new();
        track_entry_name(&mut seen2, "a".to_string(), "a").unwrap();
        let err3 = track_entry_name(&mut seen2, "a".to_string(), "a/").unwrap_err();
        assert!(err3.contains("collides"), "{err3}");
    }

    #[test]
    fn extract_rejects_case_folding_collision() {
        let m = manifest_bytes("^0.1");
        let err = assert_extract_rejects(
            &[
                ("manifest.json", m.as_slice()),
                ("Foo.js", b"a"),
                ("foo.js", b"b"),
            ],
            "case-insensitive",
        );
        assert!(err.contains("Foo.js"), "{err}");
        // Nested names that collide only after case-folding are caught too.
        let m2 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[
                ("manifest.json", m2.as_slice()),
                ("src/Util.ts", b"a"),
                ("SRC/util.ts", b"b"),
            ],
            "case-insensitive",
        );
    }

    #[test]
    fn extract_rejects_windows_reserved_names() {
        // With extension (`NUL.txt`), bare (`CON`), lower-case (`con`), and as a directory
        // segment (`COM1/...`) — all rejected.
        let m = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("NUL.txt", b"x")],
            "reserved device name",
        );
        let m2 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m2.as_slice()), ("CON", b"x")],
            "reserved device name",
        );
        let m3 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m3.as_slice()), ("lib/con", b"x")],
            "reserved device name",
        );
        let m4 = manifest_bytes("^0.1");
        assert_extract_rejects(
            &[("manifest.json", m4.as_slice()), ("COM1/data.txt", b"x")],
            "reserved device name",
        );
    }

    #[test]
    fn extract_rejects_trailing_dot_or_space() {
        let m = manifest_bytes("^0.1");
        let err = assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("foo.", b"x")],
            "ends with '.'",
        );
        assert!(err.contains("foo."), "{err}");
        let m2 = manifest_bytes("^0.1");
        let err2 = assert_extract_rejects(
            &[("manifest.json", m2.as_slice()), ("foo ", b"x")],
            "ends with '.' or a space",
        );
        assert!(err2.contains("foo "), "{err2}");
    }

    #[test]
    fn extract_rejects_ntfs_ads_syntax() {
        let m = manifest_bytes("^0.1");
        let err = assert_extract_rejects(
            &[("manifest.json", m.as_slice()), ("file:ads", b"x")],
            "alternate data stream",
        );
        assert!(err.contains("file:ads"), "{err}");
    }

    #[test]
    fn extract_rejects_zip_bomb_compression_ratio() {
        // 8 MiB of zeros deflates to a few KiB: well under the 16 MiB single-file and 64 MiB total
        // byte caps, but far beyond the MAX_COMPRESSION_RATIO=100 guard.
        let m = manifest_bytes("^0.1");
        let zeros = vec![0u8; 8 * 1024 * 1024];
        let err = assert_extract_rejects(
            &[
                ("manifest.json", m.as_slice()),
                ("bomb.bin", zeros.as_slice()),
            ],
            "compression ratio",
        );
        assert!(err.contains("bomb.bin"), "{err}");
    }

    #[test]
    fn extract_accepts_wellformed_archive() {
        // Positive control: a normal manifest + content archive still extracts.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        let m = manifest_with_css_bytes();
        std::fs::write(
            &thx,
            zip_bytes(&[
                ("manifest.json", m.as_slice()),
                ("lib/main.js", b"console.log('hi')"),
            ]),
        )
        .unwrap();
        let dest = ws.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let plugin = extract(&thx, &dest).unwrap();
        assert_eq!(plugin.id, "com.example.test");
        assert_eq!(plugin.css.as_deref(), Some("body{}"));
        assert!(dest.join("lib/main.js").exists());
        std::fs::remove_dir_all(&ws).ok();
    }

    // --- `config` schema ------------------------------------------------------

    fn manifest_with_config(config: serde_json::Value) -> serde_json::Value {
        let mut manifest = manifest_json("^0.1");
        manifest["config"] = config;
        manifest
    }

    #[test]
    fn config_schema_accepts_valid_scalar_fields_and_defaults() {
        // A scalar schema with defaults and labels passes schema validation…
        let m = manifest_with_config(serde_json::json!({
            "opacity": { "type": "number", "default": 0.8, "label": "Opacity" },
            "title": { "type": "string", "default": "glass" },
            "vibrancy": { "type": "boolean", "default": true },
            "empty_default": { "type": "string", "default": null },
            "no_default": { "type": "number" },
        }));
        validate_manifest_schema(&m).unwrap();
        // …and is parsed into typed ConfigField entries by the value routes.
        let dir = tmp_ws().join("plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let plugin = load_plugin_dir(&dir).unwrap();
        assert_eq!(plugin.config.len(), 5);
        let opacity = &plugin.config["opacity"];
        assert_eq!(opacity.field_type, ConfigType::Number);
        assert_eq!(opacity.default.as_ref().unwrap(), &serde_json::json!(0.8));
        assert_eq!(opacity.label.as_deref(), Some("Opacity"));
        assert_eq!(plugin.config["title"].field_type, ConfigType::String);
        assert_eq!(plugin.config["vibrancy"].field_type, ConfigType::Boolean);
        // `default: null` is treated as "no default" (matches Option deserialization).
        assert_eq!(plugin.config["empty_default"].default, None);
        assert_eq!(plugin.config["no_default"].default, None);
        assert_eq!(plugin.config["no_default"].label, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn config_schema_rejects_object_and_array_types_with_a_future_note() {
        for declared in ["object", "array"] {
            let m = manifest_with_config(serde_json::json!({
                "nested": { "type": declared }
            }));
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(
                err.contains("reserved for a future schema"),
                "`{declared}` must be rejected with a future note, got: {err}"
            );
            assert!(err.contains(&format!("`{declared}`")), "{err}");
        }
    }

    #[test]
    fn config_schema_rejects_unknown_field_declaration_keys() {
        let m = manifest_with_config(serde_json::json!({
            "opacity": { "type": "number", "bogus": 1 }
        }));
        let err = validate_manifest_schema(&m).unwrap_err();
        assert!(err.contains("bogus"), "{err}");
    }

    #[test]
    fn config_schema_rejects_default_type_mismatch() {
        for (config, expected) in [
            (
                serde_json::json!({ "title": { "type": "string", "default": 42 } }),
                "must be a string",
            ),
            (
                serde_json::json!({ "opacity": { "type": "number", "default": "high" } }),
                "must be a number",
            ),
            (
                serde_json::json!({ "vibrancy": { "type": "boolean", "default": 1 } }),
                "must be a boolean",
            ),
            (
                serde_json::json!({ "title": { "type": "string", "default": ["a"] } }),
                "must be a string",
            ),
        ] {
            let m = manifest_with_config(config);
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(err.contains(expected), "expected `{expected}` in: {err}");
        }
    }

    #[test]
    fn config_schema_rejects_bad_config_keys() {
        for bad in ["UPPER", "a b", "a..b", ".lead", ".", "..", "trail."] {
            let mut fields = serde_json::Map::new();
            fields.insert(bad.to_string(), serde_json::json!({ "type": "string" }));
            let m = manifest_with_config(serde_json::Value::Object(fields));
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(
                err.contains("field name"),
                "config key `{bad}` should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn config_schema_rejects_more_than_32_fields() {
        let mut fields = serde_json::Map::new();
        for i in 0..33 {
            fields.insert(
                format!("key{i:02}"),
                serde_json::json!({ "type": "number" }),
            );
        }
        let m = manifest_with_config(serde_json::Value::Object(fields));
        let err = validate_manifest_schema(&m).unwrap_err();
        assert!(err.contains("maximum is 32"), "{err}");
        // Exactly 32 is fine.
        let mut fields = serde_json::Map::new();
        for i in 0..32 {
            fields.insert(
                format!("key{i:02}"),
                serde_json::json!({ "type": "number" }),
            );
        }
        validate_manifest_schema(&manifest_with_config(serde_json::Value::Object(fields))).unwrap();
    }

    #[test]
    fn config_null_is_treated_as_an_empty_schema_and_still_installs() {
        // A manifest with an explicit `"config": null` (accepted before typed config landed) must
        // pass schema validation AND the typed value route, yielding an empty schema — not fail
        // with "invalid type: null, expected a map".
        let m = manifest_with_config(serde_json::Value::Null);
        validate_manifest_schema(&m).unwrap();
        let dir = tmp_ws().join("config-null");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let plugin = load_plugin_dir(&dir).unwrap();
        assert!(plugin.config.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn config_label_must_be_a_bounded_string() {
        for label in [serde_json::json!(42), serde_json::json!("x".repeat(65)), serde_json::json!("")] {
            let m = manifest_with_config(serde_json::json!({
                "opacity": { "type": "number", "label": label }
            }));
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(
                err.contains("`label`"),
                "label `{label}` should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn plugin_dir_with_config_carries_the_schema_on_the_plugin() {
        let dir = tmp_ws().join("config-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "com.example.config",
                "name": "Config plugin",
                "version": "1.0.0",
                "author": "A",
                "tronhawk": "^0.1",
                "permissions": [],
                "config": {
                    "opacity": { "type": "number", "default": 0.5 },
                    "title": { "type": "string", "default": "hi" }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let plugin = load_plugin_dir(&dir).unwrap();
        assert_eq!(plugin.id, "com.example.config");
        assert_eq!(plugin.config.len(), 2);
        assert_eq!(plugin.config["opacity"].field_type, ConfigType::Number);
        assert_eq!(
            plugin.config["opacity"].default.as_ref().unwrap(),
            &serde_json::json!(0.5)
        );
        assert_eq!(plugin.config["title"].field_type, ConfigType::String);
        assert_eq!(
            plugin.config["title"].default.as_ref().unwrap(),
            &serde_json::json!("hi")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    // --- `network` schema ------------------------------------------------------

    fn manifest_with_network(domains: serde_json::Value) -> serde_json::Value {
        let mut manifest = manifest_json("^0.1");
        manifest["network"] = serde_json::json!({ "domains": domains });
        manifest
    }

    #[test]
    fn network_schema_accepts_valid_domains() {
        // Plain hostnames, subdomains, leading `*.` wildcards (with or without a port), an
        // explicitly-listed IPv4, and mixed-case entries all pass.
        let m = manifest_with_network(serde_json::json!([
            "example.com",
            "sub.example.com",
            "api.example.com:8443",
            "*.example.org",
            "*.deep.sub.example.net:443",
            "192.168.0.1",
            "10.0.0.1:8080",
            "UPPER.example.com",
        ]));
        validate_manifest_schema(&m).unwrap();
        // An empty `domains` array is schema-valid (Core rejects requests at runtime: fail
        // closed), and an absent `network` is valid for older manifests.
        validate_manifest_schema(&manifest_with_network(serde_json::json!([]))).unwrap();
        validate_manifest_schema(&manifest_json("^0.1")).unwrap();
        // Exactly 64 entries is the boundary; 64 is fine.
        let many: Vec<String> = (0..64).map(|i| format!("host{i:02}.example.com")).collect();
        validate_manifest_schema(&manifest_with_network(serde_json::json!(many))).unwrap();
    }

    #[test]
    fn network_schema_rejects_invalid_domains() {
        let cases: &[(&str, serde_json::Value)] = &[
            ("scheme", serde_json::json!("https://example.com")),
            ("scheme", serde_json::json!("ftp://example.com")),
            ("path", serde_json::json!("example.com/path")),
            ("path", serde_json::json!("*.example.com/x")),
            ("credentials", serde_json::json!("user@example.com")),
            ("IP-literal", serde_json::json!("[::1]")),
            ("IPv6", serde_json::json!("2001:db8::1")),
            ("IPv6", serde_json::json!("2001:db8::1:8080")),
            ("wildcard", serde_json::json!("*")),
            ("wildcard", serde_json::json!("*.com")),
            ("wildcard", serde_json::json!("foo*bar.com")),
            ("hostname", serde_json::json!("-bad.com")),
            ("hostname", serde_json::json!("bad-.com")),
            ("hostname", serde_json::json!("under_score.com")),
            ("hostname", serde_json::json!("exa mple.com")),
            ("empty labels", serde_json::json!("a..b.com")),
            ("empty labels", serde_json::json!(".example.com")),
            ("IPv4", serde_json::json!("1.2.3.999")),
            ("IPv4", serde_json::json!("1.2.3.4.5")),
            ("port", serde_json::json!("example.com:")),
            ("port", serde_json::json!("example.com:0")),
            ("port", serde_json::json!("example.com:65536")),
            ("port", serde_json::json!("example.com:abc")),
            ("port", serde_json::json!("example.com:8080.5")),
        ];
        for (needle, entry) in cases {
            let m = manifest_with_network(serde_json::json!([entry]));
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(
                err.contains(needle),
                "entry `{entry}` should be rejected with `{needle}`, got: {err}"
            );
        }
    }

    #[test]
    fn network_schema_rejects_duplicates_and_oversized_lists() {
        // Case-folded duplicates are duplicates.
        let dup = manifest_with_network(serde_json::json!([
            "example.com",
            "EXAMPLE.com",
        ]));
        let err = validate_manifest_schema(&dup).unwrap_err();
        assert!(err.contains("duplicate"), "{err}");
        // Identical duplicates and duplicate wildcards are duplicates too.
        let dup2 = manifest_with_network(serde_json::json!([
            "*.example.com",
            "*.EXAMPLE.com",
        ]));
        let err2 = validate_manifest_schema(&dup2).unwrap_err();
        assert!(err2.contains("duplicate"), "{err2}");
        // A wildcard and its concrete host are distinct entries and do not collide.
        let distinct = manifest_with_network(serde_json::json!([
            "example.com",
            "*.example.com",
        ]));
        validate_manifest_schema(&distinct).unwrap();
        // More than 64 entries is rejected.
        let many: Vec<String> = (0..65).map(|i| format!("host{i:02}.example.com")).collect();
        let oversized = manifest_with_network(serde_json::json!(many));
        let err3 = validate_manifest_schema(&oversized).unwrap_err();
        assert!(err3.contains("maximum is 64"), "{err3}");
    }

    #[test]
    fn network_schema_rejects_malformed_network_objects() {
        for (network, needle) in [
            (serde_json::json!("not-an-object"), "must be an object"),
            (serde_json::json!({ "domains": "x" }), "must be an array"),
            (serde_json::json!({ "domains": [42] }), "must be strings"),
            (serde_json::json!({ "bogus": [] }), "unknown key"),
            (serde_json::json!({}), "requires a `domains` array"),
            (
                serde_json::json!({ "domains": ["example.com"], "extra": [] }),
                "unknown key",
            ),
        ] {
            let mut m = manifest_json("^0.1");
            m["network"] = network;
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(err.contains(needle), "expected `{needle}` in: {err}");
        }
    }

    #[test]
    fn plugin_dir_with_network_carries_lowercased_domains_on_the_plugin() {
        let dir = tmp_ws().join("network-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "com.example.network",
                "name": "Network plugin",
                "version": "1.0.0",
                "author": "A",
                "tronhawk": "^0.1",
                "permissions": ["network.access"],
                "network": {
                    "domains": ["api.Example.com", "*.example.org:8443", "192.168.0.1"]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let plugin = load_plugin_dir(&dir).unwrap();
        let network = plugin.network.expect("network manifest must be carried on the Plugin");
        assert_eq!(
            network.domains,
            vec![
                "api.example.com".to_string(),
                "*.example.org:8443".to_string(),
                "192.168.0.1".to_string(),
            ],
            "domains must be lowercased for Core matching"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    // --- `entry.renderer` execution-gate contract (0.1 stage 0) -------------------

    fn manifest_with_renderer_entry(permissions: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": "com.example.test",
            "name": "Test",
            "version": "1.0.0",
            "author": "A",
            "tronhawk": "^0.1",
            "permissions": permissions,
            "entry": { "renderer": "renderer.js" }
        })
    }

    #[test]
    fn renderer_entry_requires_renderer_script_execution_gate() {
        // Positive: declaring `renderer.script` passes schema validation, alone and alongside
        // the additional capabilities.
        validate_manifest_schema(&manifest_with_renderer_entry(
            serde_json::json!(["renderer.script"]),
        ))
        .unwrap();
        validate_manifest_schema(&manifest_with_renderer_entry(serde_json::json!([
            "renderer.script",
            "renderer.dom",
            "renderer.storage",
            "renderer.css",
        ])))
        .unwrap();
        // Negative (pack-time layer): anything without a declared `renderer.script` is
        // rejected — including the pre-0.1 split (`renderer.dom`-only) that used to be
        // "packable but never runs", and `runtime.unsafe`-only (the escape hatch unlocks
        // the payload at runtime but never substitutes for the pack-time declaration).
        for permissions in [
            serde_json::json!([]),
            serde_json::json!(["renderer.dom"]),
            serde_json::json!(["renderer.dom", "renderer.storage"]),
            serde_json::json!(["renderer.css"]),
            serde_json::json!(["renderer.storage"]),
            serde_json::json!(["runtime.unsafe"]),
        ] {
            let m = manifest_with_renderer_entry(permissions);
            let err = validate_manifest_schema(&m).unwrap_err();
            assert!(
                err.contains("renderer.script"),
                "message must name the required gate, got: {err}"
            );
            assert!(
                err.contains("execution gate"),
                "message must explain the gate semantics, got: {err}"
            );
            assert!(
                err.contains("runtime.unsafe"),
                "message must state the two-layer contract (pack-time declaration vs \
                 runtime escape hatch), got: {err}"
            );
            assert!(
                err.contains("core.renderer.script_required"),
                "message must reference the Core execution_plan side, got: {err}"
            );
        }
        // No renderer entry needs no script gate.
        validate_manifest_schema(&manifest_json("^0.1")).unwrap();
    }

    #[test]
    fn renderer_entry_with_script_gate_loads_payload_via_plugin_dir() {
        // End-to-end through `load_plugin_dir`: renderer source is carried when the gate is
        // declared.
        let dir = tmp_ws().join("renderer-gate-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("renderer.js"), "console.log('renderer')").unwrap();
        let m = manifest_with_renderer_entry(serde_json::json!([
            "renderer.script",
            "renderer.dom",
        ]));
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let plugin = load_plugin_dir(&dir).unwrap();
        assert_eq!(plugin.renderer.as_deref(), Some("console.log('renderer')"));
        std::fs::remove_dir_all(&dir).ok();

        // And a `renderer.dom`-only directory is rejected at load with the same gate message
        // (pack/install share this path, so the packer refuses it too).
        let bad_dir = tmp_ws().join("renderer-gate-rejected");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("renderer.js"), "console.log('renderer')").unwrap();
        let bad = manifest_with_renderer_entry(serde_json::json!(["renderer.dom"]));
        std::fs::write(
            bad_dir.join("manifest.json"),
            serde_json::to_vec(&bad).unwrap(),
        )
        .unwrap();
        let err = load_plugin_dir(&bad_dir).unwrap_err();
        assert!(
            err.contains("renderer.script") && err.contains("execution gate"),
            "rejection must explain the gate, got: {err}"
        );
        std::fs::remove_dir_all(&bad_dir).ok();
    }

    // --- `pack_for_host` explicit protocol + atomic + round-trip (Gate 2) ---------------

    fn minimal_plugin_dir(ws: &Path, tronhawk: &str) -> PathBuf {
        let dir = ws.join("plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "com.example.test",
                "name": "Test",
                "version": "1.0.0",
                "author": "A",
                "tronhawk": tronhawk,
                "css": "body{}",
                "permissions": ["renderer.css"]
            }))
            .unwrap(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn pack_for_host_honors_explicit_protocol() {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = minimal_plugin_dir(&ws, "^0.1");
        // Compatible explicit host version packs.
        let ok_out = ws.join("ok.thx");
        pack_for_host(&dir, &ok_out, "0.1.0").unwrap();
        assert!(ok_out.exists());
        // Incompatible explicit host version is rejected before anything is written.
        let bad_out = ws.join("bad.thx");
        let err = pack_for_host(&dir, &bad_out, "1.0.0").unwrap_err();
        assert!(
            err.contains("^0.1") && err.contains("1.0.0"),
            "explicit host version must be honored: {err}"
        );
        assert!(
            !bad_out.exists(),
            "failed pack must not leave an output"
        );
        // No temp files leak beside the outputs.
        let leftovers: Vec<_> = std::fs::read_dir(&ws)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_failure_leaves_no_output_and_no_temp() {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        // Invalid plugin (renderer entry without the script gate).
        let dir = ws.join("bad-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("renderer.js"), "x").unwrap();
        let bad = manifest_with_renderer_entry(serde_json::json!(["renderer.dom"]));
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&bad).unwrap()).unwrap();
        let out = ws.join("out.thx");
        let err = pack(&dir, &out).unwrap_err();
        assert!(err.contains("renderer.script"), "{err}");
        assert!(!out.exists(), "failed pack must not leave an output");
        let leftovers: Vec<_> = std::fs::read_dir(&ws)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leaked: {leftovers:?}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_rejects_output_inside_source() {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = minimal_plugin_dir(&ws, "^0.1");
        let out = dir.join("nested.thx");
        let err = pack(&dir, &out).unwrap_err();
        assert!(err.contains("inside the source"), "{err}");
        assert!(!out.exists());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_roundtrip_is_installable_and_inspect_agrees() {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = minimal_plugin_dir(&ws, "^0.1");
        let thx = ws.join("pkg.thx");
        pack(&dir, &thx).unwrap();
        // Same-crate extract proves installability.
        let dest = ws.join("installed");
        std::fs::create_dir_all(&dest).unwrap();
        let plugin = extract(&thx, &dest).unwrap();
        assert_eq!(plugin.id, "com.example.test");
        // `inspect` agrees on the same archive without extracting.
        let info = inspect_archive(&thx).unwrap();
        assert_eq!(info.manifest["id"], serde_json::json!("com.example.test"));
        assert!(info.entries.contains(&"manifest.json".to_string()));
        assert_eq!(info.entry_count, info.entries.len());
        // Explicit-host inspect rejects a protocol mismatch.
        let err = inspect_archive_for_host(&thx, "1.0.0").unwrap_err();
        assert!(err.contains("host protocol"), "{err}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_enforces_extract_side_name_rules_on_inputs() {
        // Direct unit coverage of the shared validators `pack` now applies to inputs:
        // byte-identical and case-folding collisions are both rejected, mirroring extract.
        let mut seen = std::collections::HashMap::new();
        let key = validate_archive_entry_name("dist/renderer.js").unwrap();
        track_entry_name(&mut seen, key, "dist/renderer.js").unwrap();
        let dup = validate_archive_entry_name("dist/renderer.js").unwrap();
        assert!(track_entry_name(&mut seen, dup, "dist/renderer.js").is_err());
        let folded = validate_archive_entry_name("DIST/Renderer.js").unwrap();
        let err = track_entry_name(&mut seen, folded, "DIST/Renderer.js").unwrap_err();
        assert!(err.contains("case-insensitive"), "{err}");
        // Windows hardening shared with extract.
        assert!(validate_archive_entry_name("NUL.txt").is_err());
        assert!(validate_archive_entry_name("a/b:.js").is_err());
    }

    #[test]
    fn engine_version_matches_crate_version() {
        // The engine version is the crate version; it is independent from the CLI and
        // protocol versions (never assume equality, even when all three are `0.1.0` today).
        assert_eq!(engine_version(), env!("CARGO_PKG_VERSION"));
        assert_eq!(HOST_PROTOCOL_VERSION, "0.1.0");
    }

    // --- Gate 2 hardening regressions (temp-file safety + inspect entry presence) ---

    fn no_temp_leftovers(ws: &Path) -> Vec<String> {
        std::fs::read_dir(ws)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect()
    }

    #[test]
    fn pack_rejects_missing_parent_without_creating_it() {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = minimal_plugin_dir(&ws, "^0.1");
        let missing_parent = ws.join("no-such-dir");
        assert!(!missing_parent.exists());
        let out = missing_parent.join("out.thx");
        let err = pack(&dir, &out).unwrap_err();
        assert!(
            err.contains("parent") && err.contains("does not exist"),
            "missing parent must fail explicitly, got: {err}"
        );
        // Nothing was auto-created and nothing leaked.
        assert!(!missing_parent.exists(), "pack must never auto-create the parent");
        assert!(!out.exists());
        assert!(no_temp_leftovers(&ws).is_empty());
        // The source tree is untouched (only manifest.json inside).
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["manifest.json".to_string()]);
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_exclusive_temp_create_refuses_preplaced_file() {
        // The exact helper pack uses for its temp file must fail closed (AlreadyExists)
        // instead of truncating a pre-placed file.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let blocked = ws.join("blocked.tmp");
        std::fs::write(&blocked, b"sentinel").unwrap();
        let err = create_exclusive_file(&blocked).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists, "{err}");
        assert_eq!(
            std::fs::read(&blocked).unwrap(),
            b"sentinel",
            "pre-placed file must not be truncated"
        );
        // Fresh names still succeed exclusively.
        let fresh = ws.join("fresh.tmp");
        create_exclusive_file(&fresh).unwrap();
        assert!(fresh.exists());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_exclusive_temp_create_refuses_preplaced_symlink() {
        // Cross-platform: on Windows symlink creation may need privileges; skip gracefully.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let victim = ws.join("victim.txt");
        std::fs::write(&victim, b"victim").unwrap();
        let link = ws.join("link.tmp");
        #[cfg(unix)]
        let symlink_ok = std::os::unix::fs::symlink(&victim, &link).is_ok();
        #[cfg(windows)]
        let symlink_ok = std::os::windows::fs::symlink_file(&victim, &link).is_ok();
        #[cfg(not(any(unix, windows)))]
        let symlink_ok = false;
        if !symlink_ok {
            eprintln!("skip symlink test: cannot create symlink on this host");
            std::fs::remove_dir_all(&ws).ok();
            return;
        }
        let err = create_exclusive_file(&link).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists, "{err}");
        // The symlink was neither followed nor replaced; the target is intact.
        assert_eq!(std::fs::read(&victim).unwrap(), b"victim");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_temp_names_are_unpredictable_and_exclusive() {
        // Random suffixes must differ call-to-call (no predictable pid-counter name) and
        // sibling temp creation must use exclusive create (no truncation on collision).
        let a = random_suffix();
        let b = random_suffix();
        assert_eq!(a.len(), 32, "suffix must be 128-bit hex, got: {a}");
        assert_eq!(b.len(), 32, "suffix must be 128-bit hex, got: {b}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "{a}");
        assert_ne!(a, b, "successive temp names must not be predictable");
        // End-to-end: two packs to different outputs leave no temp files behind.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = minimal_plugin_dir(&ws, "^0.1");
        let out_a = ws.join("a.thx");
        let out_b = ws.join("b.thx");
        pack(&dir, &out_a).unwrap();
        pack(&dir, &out_b).unwrap();
        assert!(out_a.exists() && out_b.exists());
        assert!(no_temp_leftovers(&ws).is_empty());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_failed_run_preserves_existing_output_and_leaves_no_temp() {
        // A failed pack must neither truncate a pre-existing output nor leak a temp file.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = ws.join("bad-plugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("renderer.js"), "x").unwrap();
        let bad = manifest_with_renderer_entry(serde_json::json!(["renderer.dom"]));
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&bad).unwrap()).unwrap();
        let out = ws.join("out.thx");
        std::fs::write(&out, b"sentinel-output").unwrap();
        let err = pack(&dir, &out).unwrap_err();
        assert!(err.contains("renderer.script"), "{err}");
        assert_eq!(
            std::fs::read(&out).unwrap(),
            b"sentinel-output",
            "failed pack must not truncate the existing output"
        );
        assert!(no_temp_leftovers(&ws).is_empty());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn pack_rejects_symlink_output_without_touching_target() {
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let dir = minimal_plugin_dir(&ws, "^0.1");
        let victim = ws.join("victim.bin");
        std::fs::write(&victim, b"victim").unwrap();
        let out_link = ws.join("out.thx");
        #[cfg(unix)]
        let symlink_ok = std::os::unix::fs::symlink(&victim, &out_link).is_ok();
        #[cfg(windows)]
        let symlink_ok = std::os::windows::fs::symlink_file(&victim, &out_link).is_ok();
        #[cfg(not(any(unix, windows)))]
        let symlink_ok = false;
        if !symlink_ok {
            eprintln!("skip symlink test: cannot create symlink on this host");
            std::fs::remove_dir_all(&ws).ok();
            return;
        }
        let err = pack(&dir, &out_link).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        // Neither the link nor its target was followed/replaced; no temp leaked.
        assert_eq!(std::fs::read(&victim).unwrap(), b"victim");
        assert!(std::fs::symlink_metadata(&out_link).unwrap().file_type().is_symlink());
        assert!(no_temp_leftovers(&ws).is_empty());
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn inspect_rejects_manifest_entry_missing_from_archive() {
        // Each `entry.*` reference must really be in the archive; otherwise the package is
        // not installable and `inspect` must fail for the CLI to pass through.
        for (key, rel) in [
            ("renderer", "missing-renderer.js"),
            ("main", "missing-main.js"),
            ("css", "missing.css"),
        ] {
            let ws = tmp_ws();
            std::fs::create_dir_all(&ws).unwrap();
            let thx = ws.join("pkg.thx");
            // Manifest declares the entry file but the archive omits it (only manifest).
            // `renderer` needs the script gate; give it so the failure is the missing
            // file, not the gate. For `css`/`main` the same manifest shape still parses.
            let mut entry = serde_json::Map::new();
            entry.insert(key.to_string(), serde_json::json!(rel));
            let m = if key == "renderer" {
                serde_json::json!({
                    "id": "com.example.test",
                    "name": "Test",
                    "version": "1.0.0",
                    "author": "A",
                    "tronhawk": "^0.1",
                    "permissions": ["renderer.script"],
                    "entry": entry,
                })
            } else if key == "css" {
                serde_json::json!({
                    "id": "com.example.test",
                    "name": "Test",
                    "version": "1.0.0",
                    "author": "A",
                    "tronhawk": "^0.1",
                    "permissions": ["renderer.css"],
                    "entry": entry,
                })
            } else {
                serde_json::json!({
                    "id": "com.example.test",
                    "name": "Test",
                    "version": "1.0.0",
                    "author": "A",
                    "tronhawk": "^0.1",
                    "permissions": [],
                    "entry": entry,
                })
            };
            std::fs::write(
                &thx,
                zip_bytes(&[("manifest.json", serde_json::to_vec(&m).unwrap().as_slice())]),
            )
            .unwrap();
            let err = inspect_archive(&thx).unwrap_err();
            assert!(
                err.contains("missing from archive") && err.contains(rel),
                "`entry.{key}` -> `{rel}` must be reported, got: {err}"
            );
            // Explicit-host variant agrees.
            let err2 = inspect_archive_for_host(&thx, "0.1.0").unwrap_err();
            assert!(err2.contains(rel), "{err2}");
            std::fs::remove_dir_all(&ws).ok();
        }
    }

    #[test]
    fn inspect_accepts_present_entry_files_and_inline_css() {
        // Positive controls for the new presence check: declared files that ARE in the
        // archive pass, and an inline `css` string needs no file.
        let ws = tmp_ws();
        std::fs::create_dir_all(&ws).unwrap();
        let thx = ws.join("pkg.thx");
        let m = serde_json::json!({
            "id": "com.example.test",
            "name": "Test",
            "version": "1.0.0",
            "author": "A",
            "tronhawk": "^0.1",
            "permissions": ["renderer.script"],
            "entry": { "renderer": "renderer.js" },
        });
        std::fs::write(
            &thx,
            zip_bytes(&[
                ("manifest.json", serde_json::to_vec(&m).unwrap().as_slice()),
                ("renderer.js", b"console.log(1)" as &[u8]),
            ]),
        )
        .unwrap();
        let info = inspect_archive(&thx).unwrap();
        assert!(info.entries.contains(&"renderer.js".to_string()));

        // Inline `css` (no `entry`) still inspects fine.
        let thx2 = ws.join("css.thx");
        std::fs::write(&thx2, zip_bytes(&[("manifest.json", manifest_with_css_bytes().as_slice())]))
            .unwrap();
        inspect_archive(&thx2).unwrap();
        std::fs::remove_dir_all(&ws).ok();
    }

    // --- Conformance corpus (tests/plugin-conformance/index.json, Gate 3) -----------
    // Rust owns the `validate` + `extract` expectations. These tests consume the SAME
    // index.json the JS sandbox runner consumes, so the 4 validate-negative + 3
    // hostile-ZIP cases are really executed here (not just declared in JSON).
    // Runner map (see tests/plugin-conformance/README.md):
    // - `validate` (ok/reject) -> `load_plugin_dir` below (schema + protocol + entry resolve).
    // - `extract` (reject) -> `extract` on a zip materialized from `zip-spec.json`.
    // - `sandbox` -> JS canonical harness (`conformance.test.js`); Rust never judges it.
    // There is no `core-plan` runner; it is intentionally absent from index.json `runners`.

    fn conformance_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/plugin-conformance")
    }

    fn read_conformance_index() -> serde_json::Value {
        let path = conformance_root().join("index.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read conformance index {}: {e}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse conformance index: {e}"))
    }

    /// Build a `.thx` archive for a `zip-spec` case. Unique names go through the `zip`
    /// crate (Stored, no compression surprises); byte-identical duplicates — which the
    /// `zip` writer refuses to emit — fall back to the hand-rolled stored archive (same
    /// helper style as `extract_rejects_duplicate_entry_names`), so the duplicate case
    /// really reaches `extract`'s central-directory pre-scan.
    fn materialize_zip_spec(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut seen = std::collections::HashSet::new();
        let has_dup = entries.iter().any(|(n, _)| !seen.insert(n.clone()));
        if has_dup {
            let refs: Vec<(&str, &[u8])> = entries
                .iter()
                .map(|(n, d)| (n.as_str(), d.as_slice()))
                .collect();
            raw_zip(&refs)
        } else {
            use std::io::Write;
            let mut buf = std::io::Cursor::new(Vec::new());
            {
                let mut w = zip::ZipWriter::new(&mut buf);
                let opts = zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored);
                for (name, data) in entries {
                    w.start_file(name, opts).unwrap();
                    w.write_all(data).unwrap();
                }
                w.finish().unwrap();
            }
            buf.into_inner()
        }
    }

    #[test]
    fn conformance_validate_corpus() {
        let index = read_conformance_index();
        // Lock the honest runner set: no `core-plan` declaration without a runner.
        let runners: Vec<String> = index["runners"]
            .as_array()
            .expect("index.runners must be an array")
            .iter()
            .map(|v| v.as_str().expect("runner must be a string").to_string())
            .collect();
        assert!(
            runners.contains(&"rust-validate".to_string()),
            "runners {runners:?} must declare rust-validate"
        );
        assert!(
            runners.contains(&"rust-extract".to_string()),
            "runners {runners:?} must declare rust-extract"
        );
        assert!(
            runners.contains(&"cli-sandbox".to_string()),
            "runners {runners:?} must declare cli-sandbox"
        );
        assert!(
            !runners.iter().any(|r| r == "core-plan"),
            "runners {runners:?} must not declare core-plan without a runner"
        );

        let cases = index["cases"].as_array().expect("index.cases must be an array");
        let mut ok_count = 0;
        let mut reject_count = 0;
        for c in cases {
            let Some(validate) = c.get("validate") else {
                continue;
            };
            let id = c["id"].as_str().unwrap_or("?");
            let dir = c["dir"]
                .as_str()
                .unwrap_or_else(|| panic!("case {id} missing dir"));
            let expect = validate["expect"]
                .as_str()
                .unwrap_or_else(|| panic!("case {id} validate missing expect"));
            let fixture = conformance_root().join(dir);
            assert!(
                fixture.is_dir(),
                "case {id}: fixture dir missing: {}",
                fixture.display()
            );
            match expect {
                "ok" => {
                    ok_count += 1;
                    if let Err(e) = load_plugin_dir(&fixture) {
                        panic!("case {id}: expected validate ok, got reject: {e}");
                    }
                }
                "reject" => {
                    reject_count += 1;
                    let needle = validate["needle"]
                        .as_str()
                        .unwrap_or_else(|| panic!("case {id} reject missing needle"));
                    assert!(!needle.is_empty(), "case {id}: needle must not be empty");
                    match load_plugin_dir(&fixture) {
                        Ok(_) => panic!(
                            "case {id}: expected validate reject containing `{needle}`, got ok"
                        ),
                        Err(e) => assert!(
                            e.contains(needle),
                            "case {id}: error `{e}` must contain needle `{needle}`"
                        ),
                    }
                }
                other => panic!("case {id}: unknown validate expect `{other}`"),
            }
        }
        assert_eq!(
            ok_count, 14,
            "validate-ok corpus size changed; update this test + README counts consciously"
        );
        assert_eq!(
            reject_count, 4,
            "validate-negative corpus size changed; update this test + README counts consciously"
        );
    }

    #[test]
    fn conformance_extract_corpus() {
        let index = read_conformance_index();
        let cases = index["cases"].as_array().expect("index.cases must be an array");
        let mut reject_count = 0;
        for c in cases {
            let Some(exp) = c.get("extract") else {
                continue;
            };
            let id = c["id"].as_str().unwrap_or("?");
            let dir = c["dir"]
                .as_str()
                .unwrap_or_else(|| panic!("case {id} missing dir"));
            let expect = exp["expect"]
                .as_str()
                .unwrap_or_else(|| panic!("case {id} extract missing expect"));
            assert_eq!(expect, "reject", "case {id}: Rust only owns reject extract cases");
            let needle = exp["needle"].as_str().expect("reject needs needle");
            assert!(!needle.is_empty(), "case {id}: needle must not be empty");
            reject_count += 1;

            let fixture = conformance_root().join(dir);
            let spec_text = std::fs::read_to_string(fixture.join("zip-spec.json"))
                .unwrap_or_else(|e| panic!("case {id}: read zip-spec.json: {e}"));
            let spec: serde_json::Value = serde_json::from_str(&spec_text)
                .unwrap_or_else(|e| panic!("case {id}: parse zip-spec.json: {e}"));
            // Cross-check the spec's own extract needle agrees with index.json.
            let spec_needle = spec["extract"]["needle"].as_str().unwrap_or("");
            assert_eq!(
                spec_needle, needle,
                "case {id}: zip-spec.json needle must agree with index.json"
            );

            let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
            for e in spec["entries"].as_array().expect("entries must be an array") {
                let name = e["name"]
                    .as_str()
                    .expect("entry.name must be a string")
                    .to_string();
                if let Some(content) = e.get("content").and_then(|v| v.as_str()) {
                    entries.push((name, content.as_bytes().to_vec()));
                } else if let Some(f) = e.get("contentFile").and_then(|v| v.as_str()) {
                    let data = std::fs::read(fixture.join(f))
                        .unwrap_or_else(|e| panic!("case {id}: read contentFile {f}: {e}"));
                    entries.push((name, data));
                } else {
                    panic!("case {id}: entry `{name}` needs content or contentFile");
                }
            }
            assert!(!entries.is_empty(), "case {id}: no archive entries");

            let ws = tmp_ws().join(format!("conformance-{id}"));
            std::fs::create_dir_all(&ws).unwrap();
            let thx = ws.join("pkg.thx");
            std::fs::write(&thx, materialize_zip_spec(&entries)).unwrap();
            let dest = ws.join("out");
            std::fs::create_dir_all(&dest).unwrap();
            match extract(&thx, &dest) {
                Ok(_) => panic!(
                    "case {id}: expected extract reject containing `{needle}`, got ok"
                ),
                Err(e) => assert!(
                    e.contains(needle),
                    "case {id}: error `{e}` must contain needle `{needle}`"
                ),
            }
            assert!(
                std::fs::read_dir(&dest).unwrap().next().is_none(),
                "case {id}: dest must stay empty on rejection"
            );
            std::fs::remove_dir_all(&ws).ok();
        }
        assert_eq!(
            reject_count, 3,
            "hostile-ZIP corpus size changed; update this test + README counts consciously"
        );
    }
}

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u32 = 1;
const MAX_MESSAGE_BYTES: usize = 1024;
const MAX_RECORD_BYTES: usize = 3072;
const MAX_ACTIVE_BYTES: u64 = 1024 * 1024;
const ARCHIVE_COUNT: usize = 4;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogStream {
    Core,
    Runtime,
    Plugin,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LogRecord {
    schema_version: u32,
    pub(crate) sequence: u64,
    timestamp_ms: u64,
    pub(crate) stream: LogStream,
    level: LogLevel,
    code: String,
    pub(crate) application_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_id: Option<String>,
    message: String,
}

pub(crate) struct NewLogRecord<'a> {
    pub(crate) stream: LogStream,
    pub(crate) level: LogLevel,
    pub(crate) code: &'static str,
    pub(crate) application_id: &'a str,
    pub(crate) plugin_id: Option<&'a str>,
    pub(crate) message: &'a str,
}

pub(crate) struct LogQuery<'a> {
    pub(crate) application_id: Option<&'a str>,
    pub(crate) stream: Option<LogStream>,
    pub(crate) before_sequence: Option<u64>,
    pub(crate) limit: usize,
}

pub(crate) struct LogStore {
    directory: PathBuf,
    active: PathBuf,
    next_sequence: u64,
    max_active_bytes: u64,
}

impl LogStore {
    pub(crate) fn new(root: &Path) -> Result<Self, String> {
        Self::with_max_size(root, MAX_ACTIVE_BYTES)
    }

    fn with_max_size(root: &Path, max_active_bytes: u64) -> Result<Self, String> {
        let directory = root.join("logs");
        create_secure_directory(&directory)?;
        let active = directory.join("events.jsonl");
        for index in 0..=ARCHIVE_COUNT {
            let path = if index == 0 {
                active.clone()
            } else {
                directory.join(format!("events.jsonl.{index}"))
            };
            if entry_exists(&path)? {
                validate_regular_file(&path)?;
            }
        }
        let mut maximum = 0;
        for index in 0..=ARCHIVE_COUNT {
            let path = if index == 0 {
                active.clone()
            } else {
                directory.join(format!("events.jsonl.{index}"))
            };
            // Best-effort recovery: a corrupt or partially written archive is quarantined,
            // and a corrupt active file is truncated at its last valid record, so auxiliary
            // log data can never brick daemon startup.
            for record in recover_records(&path, index == 0)? {
                maximum = maximum.max(record.sequence);
            }
        }
        repair_active_tail(&active)?;
        Ok(Self {
            directory,
            active,
            next_sequence: maximum.saturating_add(1).max(1),
            max_active_bytes,
        })
    }

    pub(crate) fn append(&mut self, event: NewLogRecord<'_>) -> Result<LogRecord, String> {
        let message = normalize_message(event.message)?;
        let record = LogRecord {
            schema_version: SCHEMA_VERSION,
            sequence: self.next_sequence,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "system clock is before Unix epoch".to_owned())?
                .as_millis()
                .try_into()
                .map_err(|_| "system timestamp is out of range".to_owned())?,
            stream: event.stream,
            level: event.level,
            code: event.code.to_owned(),
            application_id: event.application_id.to_owned(),
            plugin_id: event.plugin_id.map(str::to_owned),
            message,
        };
        let mut encoded = serde_json::to_vec(&record).map_err(|e| format!("encode log: {e}"))?;
        if encoded.len() > MAX_RECORD_BYTES {
            return Err("serialized log record exceeds the size limit".into());
        }
        encoded.push(b'\n');
        let current_size = self.active.metadata().map(|m| m.len()).unwrap_or(0);
        if current_size > 0 && current_size + encoded.len() as u64 > self.max_active_bytes {
            self.rotate()?;
        }
        let mut file = secure_append(&self.active)?;
        file.write_all(&encoded)
            .map_err(|e| format!("write log event: {e}"))?;
        file.sync_data()
            .map_err(|e| format!("sync log event: {e}"))?;
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(record)
    }

    pub(crate) fn query(&self, query: LogQuery<'_>) -> Result<Vec<LogRecord>, String> {
        let mut records = Vec::new();
        for index in 0..=ARCHIVE_COUNT {
            let path = if index == 0 {
                self.active.clone()
            } else {
                self.directory.join(format!("events.jsonl.{index}"))
            };
            records.extend(read_records(&path)?);
        }
        records.retain(|record| {
            query
                .application_id
                .map(|id| record.application_id == id)
                .unwrap_or(true)
                && query
                    .stream
                    .map(|stream| record.stream == stream)
                    .unwrap_or(true)
                && query
                    .before_sequence
                    .map(|before| record.sequence < before)
                    .unwrap_or(true)
        });
        records.sort_by(|left, right| right.sequence.cmp(&left.sequence));
        records.truncate(query.limit);
        Ok(records)
    }

    fn rotate(&self) -> Result<(), String> {
        let oldest = self.directory.join(format!("events.jsonl.{ARCHIVE_COUNT}"));
        if entry_exists(&oldest)? {
            validate_regular_file(&oldest)?;
            std::fs::remove_file(&oldest).map_err(|e| format!("remove oldest log: {e}"))?;
        }
        for index in (1..ARCHIVE_COUNT).rev() {
            let from = self.directory.join(format!("events.jsonl.{index}"));
            if entry_exists(&from)? {
                validate_regular_file(&from)?;
                std::fs::rename(
                    &from,
                    self.directory.join(format!("events.jsonl.{}", index + 1)),
                )
                .map_err(|e| format!("rotate log archive: {e}"))?;
            }
        }
        if entry_exists(&self.active)? {
            validate_regular_file(&self.active)?;
            std::fs::rename(&self.active, self.directory.join("events.jsonl.1"))
                .map_err(|e| format!("rotate active log: {e}"))?;
        }
        Ok(())
    }
}

fn normalize_message(message: &str) -> Result<String, String> {
    let normalized: String = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    if normalized.as_bytes().len() > MAX_MESSAGE_BYTES {
        return Err("log message exceeds the size limit".into());
    }
    Ok(normalized)
}

fn read_records(path: &Path) -> Result<Vec<LogRecord>, String> {
    if !entry_exists(path)? {
        return Ok(Vec::new());
    }
    validate_regular_file(path)?;
    let file = secure_read(path)?;
    let mut records = Vec::new();
    let mut reader = BufReader::new(file);
    loop {
        let mut line = Vec::new();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("read log: {e}"))?;
        if bytes == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            break;
        }
        line.pop();
        if line.len() > MAX_RECORD_BYTES {
            return Err("serialized log record exceeds the size limit".into());
        }
        let record: LogRecord =
            serde_json::from_slice(&line).map_err(|e| format!("invalid log record: {e}"))?;
        validate_record(&record)?;
        records.push(record);
    }
    Ok(records)
}

/// Startup-time best-effort scan of one log file. Parses every valid complete record. On the
/// first anomaly (an unparseable or oversized record, an invalid record, or a partial tail):
///
/// * the active file (`is_active`) is repaired by truncating it after the last valid record;
/// * an archive is quarantined aside (renamed with a `.corrupt` suffix) and skipped whole.
///
/// Access/security problems still surface as errors; content problems never do.
fn recover_records(path: &Path, is_active: bool) -> Result<Vec<LogRecord>, String> {
    if !entry_exists(path)? {
        return Ok(Vec::new());
    }
    validate_regular_file(path)?;
    let mut reader = BufReader::new(secure_read(path)?);
    let mut records = Vec::new();
    let mut valid_bytes = 0_u64;
    loop {
        let mut line = Vec::new();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("read log: {e}"))?;
        if bytes == 0 {
            break; // clean EOF
        }
        let terminated = line.ends_with(b"\n");
        let content_len = if terminated {
            line.len() - 1
        } else {
            line.len()
        };
        let record = if terminated && content_len <= MAX_RECORD_BYTES {
            serde_json::from_slice::<LogRecord>(&line[..content_len])
                .ok()
                .filter(|record| validate_record(record).is_ok())
        } else {
            None
        };
        match record {
            Some(record) => {
                valid_bytes += bytes as u64;
                records.push(record);
            }
            None => {
                if is_active {
                    truncate_log(path, valid_bytes)?;
                } else {
                    let _ = quarantine_log(path);
                    records.clear();
                }
                break;
            }
        }
    }
    Ok(records)
}

/// Truncate a log file to `length` bytes (dropping any content from the first corrupt record
/// onward) with the same reparse/permission hardening used elsewhere.
fn truncate_log(path: &Path, length: u64) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("open log for recovery: {e}"))?;
    validate_open_file(&file)?;
    file.set_len(length)
        .map_err(|e| format!("truncate corrupt log: {e}"))?;
    file.sync_data()
        .map_err(|e| format!("sync recovered log: {e}"))
}

/// Move a corrupt archive aside to `<name>.corrupt`. Best-effort: failure to quarantine still
/// only drops the offending records; it never fails startup.
fn quarantine_log(path: &Path) -> Result<(), String> {
    let mut quarantine_name = path.as_os_str().to_os_string();
    quarantine_name.push(".corrupt");
    let quarantine_path = PathBuf::from(quarantine_name);
    if quarantine_path.exists() {
        let _ = std::fs::remove_file(&quarantine_path);
    }
    std::fs::rename(path, &quarantine_path).map_err(|e| format!("quarantine corrupt log: {e}"))
}

fn create_secure_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("create log directory: {e}"))?;
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("inspect log directory: {e}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("log directory must be a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("secure log directory: {e}"))?;
        }
    }
    #[cfg(windows)]
    reject_reparse(&metadata, "log directory")?;
    Ok(())
}

fn validate_regular_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("inspect log file: {e}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("log path must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return Err("log file permissions must be owner-only".into());
        }
    }
    #[cfg(windows)]
    reject_reparse(&metadata, "log file")?;
    Ok(())
}

fn entry_exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("inspect log path: {error}")),
    }
}

fn validate_record(record: &LogRecord) -> Result<(), String> {
    if record.schema_version != SCHEMA_VERSION || record.sequence == 0 || record.timestamp_ms == 0 {
        return Err("invalid log record metadata".into());
    }
    if normalize_message(&record.message)? != record.message {
        return Err("log record contains unnormalized controls".into());
    }
    let valid_shape = match record.stream {
        LogStream::Runtime => record.code == "runtime.message" && record.plugin_id.is_none(),
        LogStream::Plugin => {
            // `plugin.message` is written by `appendPluginLogs`; `network.request` is Core's
            // outbound-HTTP audit trail (Tier-2 `networkRequest`). Both are attributed to a
            // plugin stream record carrying a plugin id.
            matches!(
                record.code.as_str(),
                "plugin.message" | "network.request"
            ) && record.plugin_id.is_some()
        }
        LogStream::Core => {
            matches!(
                record.code.as_str(),
                "core.application.registered"
                    | "core.application.removed"
                    | "core.plugin.installed"
                    | "core.plugin.removed"
                    | "core.plugin.scan_failed"
                    | "core.plugin_config.updated"
                    | "core.policy.updated"
                    | "core.developerMode.updated"
                    | "core.launch_session.created"
                    | "core.storage.migrate_failed"
                    | "core.autostart.register_failed"
                    | "core.iefo.registered"
                    | "core.iefo.unregistered"
                    | "core.iefo.write_failed"
            )
        }
    };
    if !valid_shape || record.application_id.is_empty() {
        return Err("invalid log record attribution".into());
    }
    Ok(())
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

fn secure_append(path: &Path) -> Result<File, String> {
    if entry_exists(path)? {
        validate_regular_file(path)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("open log for append: {e}"))?;
    validate_open_file(&file)?;
    Ok(file)
}

fn secure_read(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
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
    let file = options
        .open(path)
        .map_err(|e| format!("open log for read: {e}"))?;
    validate_open_file(&file)?;
    Ok(file)
}

fn repair_active_tail(path: &Path) -> Result<(), String> {
    if !entry_exists(path)? {
        return Ok(());
    }
    validate_regular_file(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
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
        .map_err(|e| format!("open active log for recovery: {e}"))?;
    validate_open_file(&file)?;
    let mut contents = Vec::new();
    file.read_to_end(&mut contents)
        .map_err(|e| format!("read active log for recovery: {e}"))?;
    let complete_length = contents
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    if complete_length != contents.len() {
        file.set_len(complete_length as u64)
            .map_err(|e| format!("truncate partial log tail: {e}"))?;
        file.sync_data()
            .map_err(|e| format!("sync recovered log: {e}"))?;
    }
    Ok(())
}

fn validate_open_file(file: &File) -> Result<(), String> {
    let metadata = file
        .metadata()
        .map_err(|e| format!("inspect open log: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err("log path must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return Err("log file permissions must be owner-only".into());
        }
    }
    #[cfg(windows)]
    reject_reparse(&metadata, "log file")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("tronhawk-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn event(message: &str) -> NewLogRecord<'_> {
        NewLogRecord {
            stream: LogStream::Runtime,
            level: LogLevel::Info,
            code: "runtime.message",
            application_id: "app",
            plugin_id: None,
            message,
        }
    }

    #[test]
    fn persists_rotates_recovers_sequence_and_ignores_partial_tail() {
        let root = root("rotation");
        let mut store = LogStore::with_max_size(&root, 350).unwrap();
        for index in 0..12 {
            store
                .append(event(&format!("message {index} {}", "x".repeat(80))))
                .unwrap();
        }
        assert!(root.join("logs/events.jsonl.1").exists());
        assert!(root.join("logs/events.jsonl.4").exists());
        assert!(!root.join("logs/events.jsonl.5").exists());
        let mut file = OpenOptions::new()
            .append(true)
            .open(root.join("logs/events.jsonl"))
            .unwrap();
        file.write_all(b"{partial").unwrap();
        drop(file);
        let mut reopened = LogStore::with_max_size(&root, 350).unwrap();
        let record = reopened.append(event("after restart")).unwrap();
        assert_eq!(record.sequence, 13);
        assert_eq!(
            reopened
                .query(LogQuery {
                    application_id: None,
                    stream: None,
                    before_sequence: None,
                    limit: 20
                })
                .unwrap()[0]
                .sequence,
            13
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn normalizes_controls_and_rejects_oversized_messages() {
        let root = root("bounds");
        let mut store = LogStore::new(&root).unwrap();
        let record = store.append(event("line\nwith\u{0}controls")).unwrap();
        assert_eq!(record.message, "line with controls");
        assert!(store.append(event(&"x".repeat(1025))).is_err());
        let encoded = std::fs::read_to_string(root.join("logs/events.jsonl")).unwrap();
        assert!(!encoded.contains("source"));
        assert!(!encoded.contains("path"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn partial_active_tail_is_removed_before_the_next_append() {
        let root = root("tail-repair");
        let mut store = LogStore::new(&root).unwrap();
        store.append(event("before crash")).unwrap();
        let path = root.join("logs/events.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{partial").unwrap();
        drop(file);

        let mut reopened = LogStore::new(&root).unwrap();
        assert_eq!(reopened.append(event("after crash")).unwrap().sequence, 2);
        let records = reopened
            .query(LogQuery {
                application_id: None,
                stream: None,
                before_sequence: None,
                limit: 20,
            })
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(!std::fs::read_to_string(path).unwrap().contains("partial"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn query_is_newest_first_filtered_and_exclusive() {
        let root = root("query");
        let mut store = LogStore::new(&root).unwrap();
        store.append(event("one")).unwrap();
        store.append(event("two")).unwrap();
        store.append(event("three")).unwrap();
        let first = store
            .query(LogQuery {
                application_id: Some("app"),
                stream: Some(LogStream::Runtime),
                before_sequence: None,
                limit: 2,
            })
            .unwrap();
        assert_eq!(
            first.iter().map(|event| event.sequence).collect::<Vec<_>>(),
            [3, 2]
        );
        let second = store
            .query(LogQuery {
                application_id: Some("app"),
                stream: Some(LogStream::Runtime),
                before_sequence: Some(2),
                limit: 2,
            })
            .unwrap();
        assert_eq!(second[0].sequence, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    fn encoded_record(sequence: u64) -> Vec<u8> {
        let record = LogRecord {
            schema_version: SCHEMA_VERSION,
            sequence,
            timestamp_ms: 1_000_000 + sequence,
            stream: LogStream::Runtime,
            level: LogLevel::Info,
            code: "runtime.message".into(),
            application_id: "app".into(),
            plugin_id: None,
            message: "message".into(),
        };
        let mut encoded = serde_json::to_vec(&record).unwrap();
        encoded.push(b'\n');
        encoded
    }

    #[test]
    fn garbage_archive_does_not_block_startup_and_is_quarantined() {
        let root = root("garbage-archive");
        std::fs::create_dir_all(root.join("logs")).unwrap();
        let archive = root.join("logs/events.jsonl.1");
        let mut garbage = b"this is not json\n".to_vec();
        garbage.extend(encoded_record(5));
        garbage.extend(encoded_record(6));
        std::fs::write(&archive, garbage).unwrap();

        // Startup must succeed despite the unparseable archive.
        let mut store = LogStore::new(&root).unwrap();
        assert!(!archive.exists());
        assert!(root.join("logs/events.jsonl.1.corrupt").exists());
        // The corrupt archive's records are dropped, but appending continues cleanly.
        assert_eq!(store.append(event("after")).unwrap().sequence, 1);
        // A second startup over the same root is equally unaffected.
        assert!(LogStore::new(&root).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn archive_partial_tail_is_quarantined_but_does_not_block_startup() {
        let root = root("archive-partial");
        std::fs::create_dir_all(root.join("logs")).unwrap();
        let archive = root.join("logs/events.jsonl.1");
        let mut partial = encoded_record(3);
        partial.extend_from_slice(b"{interrupted tail");
        std::fs::write(&archive, partial).unwrap();

        let mut store = LogStore::new(&root).unwrap();
        assert!(!archive.exists());
        assert!(root.join("logs/events.jsonl.1.corrupt").exists());
        assert_eq!(store.append(event("after")).unwrap().sequence, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_nonregular_active_log() {
        let root = root("nonregular");
        std::fs::create_dir_all(root.join("logs/events.jsonl")).unwrap();
        assert!(LogStore::new(&root).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_log_symlink() {
        use std::os::unix::fs::symlink;
        let root = root("symlink");
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("target"), b"").unwrap();
        symlink(root.join("target"), root.join("logs/events.jsonl")).unwrap();
        assert!(LogStore::new(&root).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn rejects_log_symlink_when_supported() {
        use std::os::windows::fs::symlink_file;
        let root = root("symlink");
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("target"), b"").unwrap();
        if symlink_file(root.join("target"), root.join("logs/events.jsonl")).is_ok() {
            assert!(LogStore::new(&root).is_err());
        }
        let _ = std::fs::remove_dir_all(root);
    }
}

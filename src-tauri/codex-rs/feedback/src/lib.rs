//! 用户反馈收集与上传模块。
//!
//! 本 crate 负责收集 Codex 运行时的日志、诊断信息和结构化标签，
//! 并将它们打包上传至 Sentry。核心能力包括：
//! - 基于 `RingBuffer` 的全量日志环形缓冲（默认 4 MiB）
//! - `tracing` subscriber layer 集成（日志层 + 元数据层）
//! - 结构化请求/鉴权标签收集（通过 `tracing` 事件触发）
//! - 诊断信息附件生成（connectivity diagnostics、doctor report 等）
//! - Sentry envelope 上传（含附件、标签、分类、会话来源）
//!
//! 核心类型：
//! - [`CodexFeedback`]：反馈收集器入口，提供 layer 工厂与快照能力
//! - [`FeedbackSnapshot`]：某一时刻的反馈快照（日志字节 + 标签 + 诊断）
//! - [`FeedbackUploadOptions`]：控制单次上传行为的参数集合
//! - [`FeedbackAttachment`] / [`FeedbackAttachmentPath`]：附件（内存 / 磁盘路径）

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::collections::btree_map::Entry;
use std::fs;
use std::io::Write;
use std::io::{self};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Result;
use anyhow::anyhow;
use codex_login::AuthEnvTelemetry;
use codex_protocol::ThreadId;
use codex_protocol::protocol::SessionSource;
use tracing::Event;
use tracing::Level;
use tracing::field::Visit;
use tracing_subscriber::Layer;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::fmt::writer::MakeWriter;
use tracing_subscriber::registry::LookupSpan;

pub(crate) mod feedback_diagnostics;
/// 反馈诊断附件的文件名常量。
pub use feedback_diagnostics::FEEDBACK_DIAGNOSTICS_ATTACHMENT_FILENAME;
/// 单条反馈诊断信息（标题 + 详情列表）。
pub use feedback_diagnostics::FeedbackDiagnostic;
/// 反馈诊断集合，包含多条 `FeedbackDiagnostic`。
pub use feedback_diagnostics::FeedbackDiagnostics;

/// 脱敏后的 `codex doctor --json` 报告附件所使用的文件名。
pub const DOCTOR_REPORT_ATTACHMENT_FILENAME: &str = "codex-doctor-report.json";
/// Windows 沙箱日志附件所使用的文件名。
pub const WINDOWS_SANDBOX_LOG_ATTACHMENT_FILENAME: &str = "windows-sandbox.log";
const DEFAULT_MAX_BYTES: usize = 4 * 1024 * 1024; // 4 MiB
const SENTRY_DSN: &str =
    "https://ae32ed50620d7a7792c1ce5df38b3e3e@o33249.ingest.us.sentry.io/4510195390611458";
const UPLOAD_TIMEOUT_SECS: u64 = 10;
const FEEDBACK_TAGS_TARGET: &str = "feedback_tags";
const MAX_FEEDBACK_TAGS: usize = 64;

/// 应附加到反馈上传中的结构化请求/鉴权字段。
///
/// 这些字段记录了最近一次 API 请求的端点、鉴权模式、错误信息等，
/// 便于在用户提交反馈时排查连接与鉴权问题。
pub struct FeedbackRequestTags<'a> {
    /// API 请求端点 URL。
    pub endpoint: &'a str,
    /// 请求是否携带了鉴权 header。
    pub auth_header_attached: bool,
    /// 鉴权 header 的名称（如 `Authorization`）。
    pub auth_header_name: Option<&'a str>,
    /// 当前鉴权模式（如 `apikey`、`chatgpt` 等）。
    pub auth_mode: Option<&'a str>,
    /// 在收到 401 后是否进行了重试。
    pub auth_retry_after_unauthorized: Option<bool>,
    /// 鉴权恢复模式。
    pub auth_recovery_mode: Option<&'a str>,
    /// 鉴权恢复阶段。
    pub auth_recovery_phase: Option<&'a str>,
    /// 请求是否复用了已有连接。
    pub auth_connection_reused: Option<bool>,
    /// 请求 ID。
    pub auth_request_id: Option<&'a str>,
    /// Cloudflare Ray ID（用于追踪 CDN 层请求）。
    pub auth_cf_ray: Option<&'a str>,
    /// 鉴权错误信息。
    pub auth_error: Option<&'a str>,
    /// 鉴权错误码。
    pub auth_error_code: Option<&'a str>,
    /// 鉴权恢复后后续请求是否成功。
    pub auth_recovery_followup_success: Option<bool>,
    /// 鉴权恢复后后续请求的 HTTP 状态码。
    pub auth_recovery_followup_status: Option<u16>,
}

struct FeedbackRequestSnapshot<'a> {
    endpoint: &'a str,
    auth_header_attached: bool,
    auth_header_name: &'a str,
    auth_mode: &'a str,
    auth_retry_after_unauthorized: String,
    auth_recovery_mode: &'a str,
    auth_recovery_phase: &'a str,
    auth_connection_reused: String,
    auth_request_id: &'a str,
    auth_cf_ray: &'a str,
    auth_error: &'a str,
    auth_error_code: &'a str,
    auth_recovery_followup_success: String,
    auth_recovery_followup_status: String,
}

impl<'a> FeedbackRequestSnapshot<'a> {
    fn from_tags(tags: &'a FeedbackRequestTags<'a>) -> Self {
        Self {
            endpoint: tags.endpoint,
            auth_header_attached: tags.auth_header_attached,
            auth_header_name: tags.auth_header_name.unwrap_or(""),
            auth_mode: tags.auth_mode.unwrap_or(""),
            auth_retry_after_unauthorized: tags
                .auth_retry_after_unauthorized
                .map_or_else(String::new, |value| value.to_string()),
            auth_recovery_mode: tags.auth_recovery_mode.unwrap_or(""),
            auth_recovery_phase: tags.auth_recovery_phase.unwrap_or(""),
            auth_connection_reused: tags
                .auth_connection_reused
                .map_or_else(String::new, |value| value.to_string()),
            auth_request_id: tags.auth_request_id.unwrap_or(""),
            auth_cf_ray: tags.auth_cf_ray.unwrap_or(""),
            auth_error: tags.auth_error.unwrap_or(""),
            auth_error_code: tags.auth_error_code.unwrap_or(""),
            auth_recovery_followup_success: tags
                .auth_recovery_followup_success
                .map_or_else(String::new, |value| value.to_string()),
            auth_recovery_followup_status: tags
                .auth_recovery_followup_status
                .map_or_else(String::new, |value| value.to_string()),
        }
    }
}

/// 将请求/鉴权标签作为 `tracing` 事件发射到 `feedback_tags` target。
///
/// 这些标签会被 [`CodexFeedback::metadata_layer`] 捕获并存储，
/// 最终在用户上传反馈时附加到 Sentry envelope。
pub fn emit_feedback_request_tags(tags: &FeedbackRequestTags<'_>) {
    let snapshot = FeedbackRequestSnapshot::from_tags(tags);
    tracing::info!(
        target: FEEDBACK_TAGS_TARGET,
        endpoint = tracing::field::debug(snapshot.endpoint),
        auth_header_attached = tracing::field::debug(snapshot.auth_header_attached),
        auth_header_name = tracing::field::debug(snapshot.auth_header_name),
        auth_mode = tracing::field::debug(snapshot.auth_mode),
        auth_retry_after_unauthorized = tracing::field::debug(&snapshot.auth_retry_after_unauthorized),
        auth_recovery_mode = tracing::field::debug(snapshot.auth_recovery_mode),
        auth_recovery_phase = tracing::field::debug(snapshot.auth_recovery_phase),
        auth_connection_reused = tracing::field::debug(&snapshot.auth_connection_reused),
        auth_request_id = tracing::field::debug(snapshot.auth_request_id),
        auth_cf_ray = tracing::field::debug(snapshot.auth_cf_ray),
        auth_error = tracing::field::debug(snapshot.auth_error),
        auth_error_code = tracing::field::debug(snapshot.auth_error_code),
        auth_recovery_followup_success = tracing::field::debug(&snapshot.auth_recovery_followup_success),
        auth_recovery_followup_status = tracing::field::debug(&snapshot.auth_recovery_followup_status),
    );
}

/// 将请求/鉴权标签连同鉴权环境遥测信息一起发射到 `feedback_tags` target。
///
/// 与 [`emit_feedback_request_tags`] 类似，但额外附加了 `AuthEnvTelemetry`
/// 字段（如 API key 是否存在、自定义 provider 的 env key 名称等），
/// 便于排查与鉴权环境配置相关的问题。
pub fn emit_feedback_request_tags_with_auth_env(
    tags: &FeedbackRequestTags<'_>,
    auth_env: &AuthEnvTelemetry,
) {
    let snapshot = FeedbackRequestSnapshot::from_tags(tags);
    tracing::info!(
        target: FEEDBACK_TAGS_TARGET,
        endpoint = tracing::field::debug(snapshot.endpoint),
        auth_header_attached = tracing::field::debug(snapshot.auth_header_attached),
        auth_header_name = tracing::field::debug(snapshot.auth_header_name),
        auth_mode = tracing::field::debug(snapshot.auth_mode),
        auth_retry_after_unauthorized = tracing::field::debug(&snapshot.auth_retry_after_unauthorized),
        auth_recovery_mode = tracing::field::debug(snapshot.auth_recovery_mode),
        auth_recovery_phase = tracing::field::debug(snapshot.auth_recovery_phase),
        auth_connection_reused = tracing::field::debug(&snapshot.auth_connection_reused),
        auth_request_id = tracing::field::debug(snapshot.auth_request_id),
        auth_cf_ray = tracing::field::debug(snapshot.auth_cf_ray),
        auth_error = tracing::field::debug(snapshot.auth_error),
        auth_error_code = tracing::field::debug(snapshot.auth_error_code),
        auth_recovery_followup_success = tracing::field::debug(&snapshot.auth_recovery_followup_success),
        auth_recovery_followup_status = tracing::field::debug(&snapshot.auth_recovery_followup_status),
        auth_env_openai_api_key_present = tracing::field::debug(auth_env.openai_api_key_env_present),
        auth_env_codex_api_key_present = tracing::field::debug(auth_env.codex_api_key_env_present),
        auth_env_codex_api_key_enabled = tracing::field::debug(auth_env.codex_api_key_env_enabled),
        // 自定义 provider 的 `env_key` 是任意配置文本，因此只发射一个安全的桶值。
        auth_env_provider_key_name = tracing::field::debug(
            auth_env.provider_env_key_name.as_deref().unwrap_or("")
        ),
        auth_env_provider_key_present = tracing::field::debug(
            &auth_env.provider_env_key_present.map_or_else(String::new, |value| value.to_string())
        ),
        auth_env_refresh_token_url_override_present = tracing::field::debug(
            auth_env.refresh_token_url_override_present
        ),
    );
}

/// Codex 反馈收集器，持有日志环形缓冲与标签存储。
///
/// 该结构体是反馈系统的入口，通过 [`make_writer`]、[`logger_layer`] 和
/// [`metadata_layer`] 与 `tracing` subscriber 集成，收集全量日志与结构化标签。
/// 收集到的数据可通过 [`snapshot`] 导出为 [`FeedbackSnapshot`]，再上传至 Sentry。
///
/// [`make_writer`]: CodexFeedback::make_writer
/// [`logger_layer`]: CodexFeedback::logger_layer
/// [`metadata_layer`]: CodexFeedback::metadata_layer
/// [`snapshot`]: CodexFeedback::snapshot
#[derive(Clone)]
pub struct CodexFeedback {
    inner: Arc<FeedbackInner>,
}

impl Default for CodexFeedback {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexFeedback {
    /// 创建一个使用默认容量（4 MiB）的反馈收集器。
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_MAX_BYTES)
    }

    /// 创建一个指定最大字节数的反馈收集器。
    pub(crate) fn with_capacity(max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(FeedbackInner::new(max_bytes)),
        }
    }

    /// 创建一个 `MakeWriter` 实例，供 `tracing_subscriber::fmt::layer()` 使用。
    ///
    /// 写入该 writer 的数据会被追加到内部环形缓冲中。
    pub fn make_writer(&self) -> FeedbackMakeWriter {
        FeedbackMakeWriter {
            inner: self.inner.clone(),
        }
    }

    /// 返回一个 [`tracing_subscriber`] layer，将全量日志捕获到此反馈环形缓冲中。
    ///
    /// 专为初始化代码设计，使调用方无需重复配置 `fmt::layer()` 的细节与过滤逻辑。
    pub fn logger_layer<S>(&self) -> impl Layer<S> + Send + Sync + 'static
    where
        S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    {
        tracing_subscriber::fmt::layer()
            .with_writer(self.make_writer())
            .with_timer(tracing_subscriber::fmt::time::SystemTime)
            .with_ansi(false)
            .with_target(false)
            // 捕获所有级别的日志（忽略调用方的 `RUST_LOG` 设置），
            // 确保用户上传反馈时包含完整的追踪记录。
            .with_filter(Targets::new().with_default(Level::TRACE))
    }

    /// 返回一个 [`tracing_subscriber`] layer，收集结构化元数据用于反馈。
    ///
    /// `target: "feedback_tags"` 的事件会被视为键值对标签，
    /// 后续在上传反馈时附加到 Sentry envelope。
    pub fn metadata_layer<S>(&self) -> impl Layer<S> + Send + Sync + 'static
    where
        S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    {
        FeedbackMetadataLayer {
            inner: self.inner.clone(),
        }
        .with_filter(Targets::new().with_target(FEEDBACK_TAGS_TARGET, Level::TRACE))
    }

    /// 生成当前反馈状态的快照，包含日志字节、标签集合与诊断信息。
    ///
    /// - `session_id`：当前会话 ID，用于在 Sentry 中标识反馈来源。
    ///   若为 `None`，则生成一个带 `no-active-thread-` 前缀的临时 ID。
    pub fn snapshot(&self, session_id: Option<ThreadId>) -> FeedbackSnapshot {
        let bytes = {
            #[allow(clippy::expect_used)]
            let guard = self.inner.ring.lock().expect("mutex poisoned");
            guard.snapshot_bytes()
        };
        let tags = {
            #[allow(clippy::expect_used)]
            let guard = self.inner.tags.lock().expect("mutex poisoned");
            guard.clone()
        };
        FeedbackSnapshot {
            bytes,
            tags,
            feedback_diagnostics: FeedbackDiagnostics::collect_from_env(),
            thread_id: session_id
                .map(|id| id.to_string())
                .unwrap_or("no-active-thread-".to_string() + &ThreadId::new().to_string()),
        }
    }
}

struct FeedbackInner {
    ring: Mutex<RingBuffer>,
    tags: Mutex<BTreeMap<String, String>>,
}

impl FeedbackInner {
    fn new(max_bytes: usize) -> Self {
        Self {
            ring: Mutex::new(RingBuffer::new(max_bytes)),
            tags: Mutex::new(BTreeMap::new()),
        }
    }
}

/// `MakeWriter` 实现，为 `tracing_subscriber::fmt::layer()` 提供写入目标。
///
/// 每次调用 [`make_writer`] 会创建一个新的 [`FeedbackWriter`]，
/// 共享同一个 [`FeedbackInner`] 环形缓冲。
///
/// [`make_writer`]: FeedbackMakeWriter::make_writer
#[derive(Clone)]
pub struct FeedbackMakeWriter {
    inner: Arc<FeedbackInner>,
}

impl<'a> MakeWriter<'a> for FeedbackMakeWriter {
    type Writer = FeedbackWriter;

    fn make_writer(&'a self) -> Self::Writer {
        FeedbackWriter {
            inner: self.inner.clone(),
        }
    }
}

/// 反馈日志 writer，实现 `std::io::Write` trait。
///
/// 写入的数据会被追加到共享的环形缓冲中。`flush` 为空操作，
/// 因为环形缓冲不需要显式刷新。
pub struct FeedbackWriter {
    inner: Arc<FeedbackInner>,
}

impl Write for FeedbackWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut guard = self.inner.ring.lock().map_err(|_| io::ErrorKind::Other)?;
        guard.push_bytes(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct RingBuffer {
    max: usize,
    buf: VecDeque<u8>,
}

impl RingBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            max: capacity,
            buf: VecDeque::with_capacity(capacity),
        }
    }

    fn len(&self) -> usize {
        self.buf.len()
    }

    fn push_bytes(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }

        // 若 incoming chunk 大于容量，仅保留尾部字节。
        if data.len() >= self.max {
            self.buf.clear();
            let start = data.len() - self.max;
            self.buf.extend(data[start..].iter().copied());
            return;
        }

        // 若写入后会超出容量，从头部驱逐旧字节。
        let needed = self.len() + data.len();
        if needed > self.max {
            let to_drop = needed - self.max;
            for _ in 0..to_drop {
                let _ = self.buf.pop_front();
            }
        }

        self.buf.extend(data.iter().copied());
    }

    fn snapshot_bytes(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}

/// 反馈快照，包含某一时刻的日志字节、标签集合、诊断信息与会话 ID。
///
/// 由 [`CodexFeedback::snapshot`] 生成，可通过 [`upload_feedback`] 上传至 Sentry，
/// 或通过 [`save_to_temp_file`] 写入临时文件。
pub struct FeedbackSnapshot {
    bytes: Vec<u8>,
    tags: BTreeMap<String, String>,
    feedback_diagnostics: FeedbackDiagnostics,
    /// 反馈来源的会话 ID（或临时 ID）。
    pub thread_id: String,
}

/// 磁盘路径形式的反馈附件。
///
/// 与 [`FeedbackAttachment`]（内存附件）不同，路径附件在上传时才读取文件内容，
/// 读取失败会被记录为警告并跳过该附件，不会中断整个上传流程。
pub struct FeedbackAttachmentPath {
    /// 附件文件的磁盘路径。
    pub path: PathBuf,
    /// 上传时使用的附件文件名（可选）。若为 `None`，则使用 `path` 的 basename。
    pub attachment_filename_override: Option<String>,
}

/// 内存形式的反馈附件。
///
/// 适用于不应落盘的生成式诊断数据（如脱敏后的 doctor report）。
/// 磁盘文件应使用 [`FeedbackAttachmentPath`]，这样上传时的读取失败
/// 可以被独立记录并跳过，不影响整体上传流程。
pub struct FeedbackAttachment {
    /// 在 Sentry 与反馈授权界面中显示的附件文件名。
    pub filename: String,
    /// 可选的 MIME 类型，供渲染或分类附件的消费者使用。
    pub content_type: Option<String>,
    /// 上传前捕获的附件字节。
    pub buffer: Vec<u8>,
}

/// 控制单次 Sentry 反馈上传的参数集合。
///
/// 调用方负责在设置 `include_logs` 或传递诊断附件之前执行用户授权检查。
/// 本类型仅描述在授权决定后要上传的内容。
pub struct FeedbackUploadOptions<'a> {
    /// 反馈分类（如 `bug`、`bad_result`、`good_result`、`safety_check` 等）。
    pub classification: &'a str,
    /// 反馈原因（可选）。
    pub reason: Option<&'a str>,
    /// 附加到上传的客户端标签（可选）。
    pub tags: Option<&'a BTreeMap<String, String>>,
    /// 是否包含全量日志。
    pub include_logs: bool,
    /// 已缓冲且可安全上传的生成式附件。
    ///
    /// 这些附件在 `codex-logs.log` 之后、路径附件之前包含。
    /// 仅在用户授权决定上传日志和诊断后，才由调用方传入。
    pub extra_attachments: &'a [FeedbackAttachment],
    /// 磁盘路径形式的额外附件列表。
    pub extra_attachment_paths: &'a [FeedbackAttachmentPath],
    /// 会话来源（CLI、UI 等），用于在 Sentry 中标识反馈入口。
    pub session_source: Option<SessionSource>,
    /// 覆盖默认日志内容的自定义字节（可选）。
    pub logs_override: Option<Vec<u8>>,
}

impl FeedbackSnapshot {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// 返回快照中收集的诊断信息引用。
    pub fn feedback_diagnostics(&self) -> &FeedbackDiagnostics {
        &self.feedback_diagnostics
    }

    /// 消费自身并替换诊断信息，返回新的快照。
    pub fn with_feedback_diagnostics(mut self, feedback_diagnostics: FeedbackDiagnostics) -> Self {
        self.feedback_diagnostics = feedback_diagnostics;
        self
    }

    /// 返回诊断信息的附件文本（仅当 `include_logs` 为 `true` 时）。
    pub fn feedback_diagnostics_attachment_text(&self, include_logs: bool) -> Option<String> {
        if !include_logs {
            return None;
        }

        self.feedback_diagnostics.attachment_text()
    }

    /// 将快照字节写入系统临时目录，返回文件路径。
    pub fn save_to_temp_file(&self) -> io::Result<PathBuf> {
        let dir = std::env::temp_dir();
        let filename = format!("codex-feedback-{}.log", self.thread_id);
        let path = dir.join(filename);
        fs::write(&path, self.as_bytes())?;
        Ok(path)
    }

    /// 将反馈上传至 Sentry，可附带附件。
    ///
    /// 根据 [`FeedbackUploadOptions`] 构建 Sentry envelope，包含事件、标签和附件，
    /// 然后通过 Sentry client 发送。发送后会等待最多 `UPLOAD_TIMEOUT_SECS` 秒刷新。
    pub fn upload_feedback(&self, options: FeedbackUploadOptions<'_>) -> Result<()> {
        use std::str::FromStr;
        use std::sync::Arc;

        use sentry::Client;
        use sentry::ClientOptions;
        use sentry::protocol::Envelope;
        use sentry::protocol::EnvelopeItem;
        use sentry::protocol::Event;
        use sentry::protocol::Level;
        use sentry::transports::DefaultTransportFactory;
        use sentry::types::Dsn;

        // 构建 Sentry client
        let client = Client::from_config(ClientOptions {
            dsn: Some(Dsn::from_str(SENTRY_DSN).map_err(|e| anyhow!("invalid DSN: {e}"))?),
            transport: Some(Arc::new(DefaultTransportFactory {})),
            ..Default::default()
        });

        let tags = self.upload_tags(
            options.classification,
            options.reason,
            options.tags,
            options.session_source.as_ref(),
        );

        let level = match options.classification {
            "bug" | "bad_result" | "safety_check" => Level::Error,
            _ => Level::Info,
        };

        let mut envelope = Envelope::new();
        let title = format!(
            "[{}]: Codex session {}",
            display_classification(options.classification),
            self.thread_id
        );

        let mut event = Event {
            level,
            message: Some(title.clone()),
            tags,
            ..Default::default()
        };
        if let Some(r) = options.reason {
            use sentry::protocol::Exception;
            use sentry::protocol::Values;

            event.exception = Values::from(vec![Exception {
                ty: title,
                value: Some(r.to_string()),
                ..Default::default()
            }]);
        }
        envelope.add_item(EnvelopeItem::Event(event));

        for attachment in self.feedback_attachments(
            options.include_logs,
            options.extra_attachments,
            options.extra_attachment_paths,
            options.logs_override,
        ) {
            envelope.add_item(EnvelopeItem::Attachment(attachment));
        }

        client.send_envelope(envelope);
        client.flush(Some(Duration::from_secs(UPLOAD_TIMEOUT_SECS)));
        Ok(())
    }

    fn upload_tags(
        &self,
        classification: &str,
        reason: Option<&str>,
        client_tags: Option<&BTreeMap<String, String>>,
        session_source: Option<&SessionSource>,
    ) -> BTreeMap<String, String> {
        let cli_version = env!("CARGO_PKG_VERSION");
        let mut tags = BTreeMap::from([
            (String::from("thread_id"), self.thread_id.to_string()),
            (String::from("classification"), classification.to_string()),
            (String::from("cli_version"), cli_version.to_string()),
        ]);
        if let Some(source) = session_source {
            tags.insert(String::from("session_source"), source.to_string());
        }
        if let Some(r) = reason {
            tags.insert(String::from("reason"), r.to_string());
        }

        let reserved = [
            "thread_id",
            "classification",
            "cli_version",
            "session_source",
            "reason",
        ];
        if let Some(client_tags) = client_tags {
            for (key, value) in client_tags {
                if reserved.contains(&key.as_str()) {
                    continue;
                }
                if let Entry::Vacant(entry) = tags.entry(key.clone()) {
                    entry.insert(value.clone());
                }
            }
        }
        for (key, value) in &self.tags {
            if reserved.contains(&key.as_str()) {
                continue;
            }
            if let Entry::Vacant(entry) = tags.entry(key.clone()) {
                entry.insert(value.clone());
            }
        }

        tags
    }

    fn feedback_attachments(
        &self,
        include_logs: bool,
        extra_attachments: &[FeedbackAttachment],
        extra_attachment_paths: &[FeedbackAttachmentPath],
        logs_override: Option<Vec<u8>>,
    ) -> Vec<sentry::protocol::Attachment> {
        use sentry::protocol::Attachment;

        let mut attachments = Vec::new();

        if include_logs {
            attachments.push(Attachment {
                buffer: logs_override.unwrap_or_else(|| self.bytes.clone()),
                filename: String::from("codex-logs.log"),
                content_type: Some("text/plain".to_string()),
                ty: None,
            });
        }

        attachments.extend(extra_attachments.iter().map(|attachment| Attachment {
            buffer: attachment.buffer.clone(),
            filename: attachment.filename.clone(),
            content_type: attachment.content_type.clone(),
            ty: None,
        }));

        if let Some(text) = self.feedback_diagnostics_attachment_text(include_logs) {
            attachments.push(Attachment {
                buffer: text.into_bytes(),
                filename: FEEDBACK_DIAGNOSTICS_ATTACHMENT_FILENAME.to_string(),
                content_type: Some("text/plain".to_string()),
                ty: None,
            });
        }

        for attachment_path in extra_attachment_paths {
            let data = match fs::read(&attachment_path.path) {
                Ok(data) => data,
                Err(err) => {
                    tracing::warn!(
                        path = %attachment_path.path.display(),
                        error = %err,
                        "failed to read log attachment; skipping"
                    );
                    continue;
                }
            };
            let filename = attachment_path
                .attachment_filename_override
                .clone()
                .unwrap_or_else(|| {
                    attachment_path
                        .path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "extra-log.log".to_string())
                });
            attachments.push(Attachment {
                buffer: data,
                filename,
                content_type: Some("text/plain".to_string()),
                ty: None,
            });
        }

        attachments
    }
}

fn display_classification(classification: &str) -> String {
    match classification {
        "bug" => "Bug".to_string(),
        "bad_result" => "Bad result".to_string(),
        "good_result" => "Good result".to_string(),
        "safety_check" => "Safety check".to_string(),
        _ => "Other".to_string(),
    }
}

#[derive(Clone)]
struct FeedbackMetadataLayer {
    inner: Arc<FeedbackInner>,
}

impl<S> Layer<S> for FeedbackMetadataLayer
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        // 本 layer 已被 `Targets` 过滤，但保留此守卫以防在无过滤器的场景下使用。
        if event.metadata().target() != FEEDBACK_TAGS_TARGET {
            return;
        }

        let mut visitor = FeedbackTagsVisitor::default();
        event.record(&mut visitor);
        if visitor.tags.is_empty() {
            return;
        }

        #[allow(clippy::expect_used)]
        let mut guard = self.inner.tags.lock().expect("mutex poisoned");
        for (key, value) in visitor.tags {
            if guard.len() >= MAX_FEEDBACK_TAGS && !guard.contains_key(&key) {
                continue;
            }
            guard.insert(key, value);
        }
    }
}

#[derive(Default)]
struct FeedbackTagsVisitor {
    tags: BTreeMap<String, String>,
}

impl Visit for FeedbackTagsVisitor {
    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.tags
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.tags
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.tags
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.tags
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.tags
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.tags
            .insert(field.name().to_string(), format!("{value:?}"));
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::fs;

    use super::*;
    use crate::FeedbackDiagnostic;
    use pretty_assertions::assert_eq;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    #[test]
    fn ring_buffer_drops_front_when_full() {
        let fb = CodexFeedback::with_capacity(/*max_bytes*/ 8);
        {
            let mut w = fb.make_writer().make_writer();
            w.write_all(b"abcdefgh").unwrap();
            w.write_all(b"ij").unwrap();
        }
        let snap = fb.snapshot(/*session_id*/ None);
        // Capacity 8: after writing 10 bytes, we should keep the last 8.
        pretty_assertions::assert_eq!(std::str::from_utf8(snap.as_bytes()).unwrap(), "cdefghij");
    }

    #[test]
    fn metadata_layer_records_tags_from_feedback_target() {
        let fb = CodexFeedback::new();
        let _guard = tracing_subscriber::registry()
            .with(fb.metadata_layer())
            .set_default();

        tracing::info!(target: FEEDBACK_TAGS_TARGET, model = "gpt-5", cached = true, "tags");

        let snap = fb.snapshot(/*session_id*/ None);
        pretty_assertions::assert_eq!(snap.tags.get("model").map(String::as_str), Some("gpt-5"));
        pretty_assertions::assert_eq!(snap.tags.get("cached").map(String::as_str), Some("true"));
    }

    #[test]
    fn feedback_attachments_gate_connectivity_diagnostics() {
        let extra_filename = format!("codex-feedback-extra-{}.jsonl", ThreadId::new());
        let extra_path = std::env::temp_dir().join(&extra_filename);
        let extra_attachment_path = FeedbackAttachmentPath {
            path: extra_path.clone(),
            attachment_filename_override: None,
        };
        fs::write(&extra_path, "rollout").expect("extra attachment should be written");

        let snapshot_with_diagnostics = CodexFeedback::new()
            .snapshot(/*session_id*/ None)
            .with_feedback_diagnostics(FeedbackDiagnostics::new(vec![FeedbackDiagnostic {
                headline: "Proxy environment variables are set and may affect connectivity."
                    .to_string(),
                details: vec!["HTTPS_PROXY = https://example.com:443".to_string()],
            }]));

        let attachments_with_diagnostics = snapshot_with_diagnostics.feedback_attachments(
            /*include_logs*/ true,
            &[FeedbackAttachment {
                filename: DOCTOR_REPORT_ATTACHMENT_FILENAME.to_string(),
                content_type: Some("application/json".to_string()),
                buffer: b"{\"overallStatus\":\"ok\"}".to_vec(),
            }],
            std::slice::from_ref(&extra_attachment_path),
            Some(vec![1]),
        );

        assert_eq!(
            attachments_with_diagnostics
                .iter()
                .map(|attachment| attachment.filename.as_str())
                .collect::<Vec<_>>(),
            vec![
                "codex-logs.log",
                DOCTOR_REPORT_ATTACHMENT_FILENAME,
                FEEDBACK_DIAGNOSTICS_ATTACHMENT_FILENAME,
                extra_filename.as_str()
            ]
        );
        assert_eq!(attachments_with_diagnostics[0].buffer, vec![1]);
        assert_eq!(
            attachments_with_diagnostics[1].buffer,
            b"{\"overallStatus\":\"ok\"}".to_vec()
        );
        assert_eq!(
            attachments_with_diagnostics[2].buffer,
            b"Connectivity diagnostics\n\n- Proxy environment variables are set and may affect connectivity.\n  - HTTPS_PROXY = https://example.com:443".to_vec()
        );
        assert_eq!(attachments_with_diagnostics[3].buffer, b"rollout".to_vec());
        assert_eq!(
            OsStr::new(attachments_with_diagnostics[3].filename.as_str()),
            OsStr::new(extra_filename.as_str())
        );
        let attachments_without_diagnostics = CodexFeedback::new()
            .snapshot(/*session_id*/ None)
            .with_feedback_diagnostics(FeedbackDiagnostics::default())
            .feedback_attachments(/*include_logs*/ true, &[], &[], Some(vec![1]));

        assert_eq!(
            attachments_without_diagnostics
                .iter()
                .map(|attachment| attachment.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["codex-logs.log"]
        );
        assert_eq!(attachments_without_diagnostics[0].buffer, vec![1]);
        fs::remove_file(extra_path).expect("extra attachment should be removed");
    }

    #[test]
    fn upload_tags_include_client_tags_and_preserve_reserved_fields() {
        let mut tags = BTreeMap::new();
        tags.insert("thread_id".to_string(), "wrong-thread".to_string());
        tags.insert("turn_id".to_string(), "wrong-turn".to_string());
        tags.insert(
            "classification".to_string(),
            "wrong-classification".to_string(),
        );
        tags.insert("cli_version".to_string(), "wrong-version".to_string());
        tags.insert("session_source".to_string(), "wrong-source".to_string());
        tags.insert("reason".to_string(), "wrong-reason".to_string());
        tags.insert("account_id".to_string(), "actual-account".to_string());
        tags.insert("model".to_string(), "gpt-5".to_string());
        let snapshot = FeedbackSnapshot {
            bytes: Vec::new(),
            tags,
            feedback_diagnostics: FeedbackDiagnostics::default(),
            thread_id: "thread-123".to_string(),
        };
        let mut client_tags = BTreeMap::new();
        client_tags.insert("thread_id".to_string(), "wrong-client-thread".to_string());
        client_tags.insert("turn_id".to_string(), "turn-456".to_string());
        client_tags.insert(
            "classification".to_string(),
            "wrong-client-classification".to_string(),
        );
        client_tags.insert(
            "cli_version".to_string(),
            "wrong-client-version".to_string(),
        );
        client_tags.insert(
            "session_source".to_string(),
            "wrong-client-source".to_string(),
        );
        client_tags.insert("reason".to_string(), "wrong-client-reason".to_string());
        client_tags.insert("client_tag".to_string(), "from-client".to_string());

        let upload_tags = snapshot.upload_tags(
            "bug",
            Some("actual reason"),
            Some(&client_tags),
            Some(&SessionSource::Cli),
        );

        assert_eq!(
            upload_tags.get("thread_id").map(String::as_str),
            Some("thread-123")
        );
        assert_eq!(
            upload_tags.get("turn_id").map(String::as_str),
            Some("turn-456")
        );
        assert_eq!(
            upload_tags.get("classification").map(String::as_str),
            Some("bug")
        );
        assert_eq!(
            upload_tags.get("session_source").map(String::as_str),
            Some("cli")
        );
        assert_eq!(
            upload_tags.get("reason").map(String::as_str),
            Some("actual reason")
        );
        assert_eq!(
            upload_tags.get("account_id").map(String::as_str),
            Some("actual-account")
        );
        assert_eq!(
            upload_tags.get("client_tag").map(String::as_str),
            Some("from-client")
        );
        assert_eq!(upload_tags.get("model").map(String::as_str), Some("gpt-5"));
    }
}

//! Codex 核心错误类型。
//!
//! 定义 sandbox 错误（[`SandboxErr`]）与 codex 顶层错误（[`CodexErr`]），
//! 以及若干面向用户展示的错误辅助类型。这些类型在协议层用于统一表达
//! 执行失败、网络异常、配额耗尽等情形，并支持转换为客户端协议错误。

use crate::ThreadId;
use crate::auth::KnownPlan;
use crate::auth::PlanType;
pub use crate::auth::RefreshTokenFailedError;
pub use crate::auth::RefreshTokenFailedReason;
use crate::exec_output::ExecToolCallOutput;
use crate::network_policy::NetworkPolicyDecisionPayload;
use crate::protocol::CodexErrorInfo;
use crate::protocol::ErrorEvent;
use crate::protocol::RateLimitReachedType;
use crate::protocol::RateLimitSnapshot;
use crate::protocol::TruncationPolicy;
use chrono::DateTime;
use chrono::Datelike;
use chrono::Local;
use chrono::Utc;
use codex_async_utils::CancelErr;
use codex_utils_string::truncate_middle_chars;
use codex_utils_string::truncate_middle_with_token_budget;
use reqwest::StatusCode;
use serde_json;
use std::io;
use std::time::Duration;
use thiserror::Error;
use tokio::task::JoinError;

/// crate 内统一的 `Result` 别名。
pub type Result<T> = std::result::Result<T, CodexErr>;

/// Limit UI error messages to a reasonable size while keeping useful context.
///
/// UI 错误消息的最大字节数，超过则截断并保留有用上下文。
const ERROR_MESSAGE_UI_MAX_BYTES: usize = 2 * 1024;

/// Sandbox 执行相关错误。
#[derive(Error, Debug)]
pub enum SandboxErr {
    /// Error from sandbox execution
    ///
    /// sandbox 拒绝执行命令，附带执行输出与可能的网络策略决策。
    #[error(
        "sandbox denied exec error, exit code: {}, stdout: {}, stderr: {}",
        .output.exit_code, .output.stdout.text, .output.stderr.text
    )]
    Denied {
        output: Box<ExecToolCallOutput>,
        network_policy_decision: Option<NetworkPolicyDecisionPayload>,
    },

    /// Error from linux seccomp filter setup
    ///
    /// Linux seccomp 过滤器安装失败。
    #[cfg(target_os = "linux")]
    #[error("seccomp setup error")]
    SeccompInstall(#[from] seccompiler::Error),

    /// Error from linux seccomp backend
    ///
    /// Linux seccomp 后端错误。
    #[cfg(target_os = "linux")]
    #[error("seccomp backend error")]
    SeccompBackend(#[from] seccompiler::BackendError),

    /// Command timed out
    ///
    /// 命令执行超时，附带部分输出。
    #[error("command timed out")]
    Timeout { output: Box<ExecToolCallOutput> },

    /// Command was killed by a signal
    ///
    /// 命令被信号杀死，携带信号编号。
    #[error("command was killed by a signal")]
    Signal(i32),

    /// Error from linux landlock
    ///
    /// Landlock 未能完全强制执行所有 sandbox 规则。
    #[error("Landlock was not able to fully enforce all sandbox rules")]
    LandlockRestrict,
}

/// Codex 顶层错误枚举。
///
/// 涵盖 turn 中止、上下文超限、网络异常、配额耗尽、sandbox 错误等所有
/// codex 运行时可能出现的错误情形。每个变体对应一种可观测的失败模式，
/// 并通过 `is_retryable` 等方法支持上层重试决策。
#[derive(Error, Debug)]
pub enum CodexErr {
    #[error("turn aborted. Something went wrong? Hit `/feedback` to report the issue.")]
    /// Turn 被中止。
    TurnAborted,

    #[error("shared rollout token budget exhausted")]
    /// 共享 rollout token 预算耗尽。
    SessionBudgetExceeded,

    /// Returned by ResponsesClient when the SSE stream disconnects or errors out **after** the HTTP
    /// handshake has succeeded but **before** it finished emitting `response.completed`.
    ///
    /// The Session loop treats this as a transient error and will automatically retry the turn.
    ///
    /// Optionally includes the requested delay before retrying the turn.
    ///
    /// SSE 流在 HTTP 握手成功后、`response.completed` 完成前断开或出错。
    /// Session 循环将其视为瞬时错误并自动重试。可选携带建议的重试延迟。
    #[error("stream disconnected before completion: {0}")]
    Stream(String, Option<Duration>),
    #[error(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
    )]
    /// 模型上下文窗口耗尽。
    ContextWindowExceeded,
    #[error("no thread with id: {0}")]
    /// 找不到指定 ID 的 thread。
    ThreadNotFound(ThreadId),
    #[error("agent thread limit reached")]
    /// Agent thread 数量达到上限。
    AgentLimitReached { max_threads: usize },
    #[error("session configured event was not the first event in the stream")]
    /// `session configured` 事件未出现在流的首位。
    SessionConfiguredNotFirstEvent,
    /// Returned by run_command_stream when the spawned child process timed out (10s).
    ///
    /// 子进程等待退出超时（10s）。
    #[error("timeout waiting for child process to exit")]
    Timeout,
    #[error("request timed out")]
    /// 请求超时。
    RequestTimeout,
    /// Returned by run_command_stream when the child could not be spawned (its stdout/stderr pipes
    /// could not be captured). Analogous to the previous `CodexError::Spawn` variant.
    ///
    /// 子进程无法启动（无法捕获 stdout/stderr 管道）。
    #[error("spawn failed: child stdout/stderr not captured")]
    Spawn,
    /// Returned by run_command_stream when the user pressed Ctrl-C (SIGINT). Session uses this to
    /// surface a polite FunctionCallOutput back to the model instead of crashing the CLI.
    ///
    /// 用户按下 Ctrl-C（SIGINT）中断。Session 据此向模型返回一个友好的
    /// FunctionCallOutput，而非让 CLI 崩溃。
    #[error("interrupted (Ctrl-C). Something went wrong? Hit `/feedback` to report the issue.")]
    Interrupted,
    /// Unexpected HTTP status code.
    ///
    /// 收到意外的 HTTP 状态码。
    #[error("{0}")]
    UnexpectedStatus(UnexpectedResponseError),
    /// Invalid request.
    ///
    /// 请求非法。
    #[error("{0}")]
    InvalidRequest(String),
    /// Invalid image.
    ///
    /// 非法图片请求。
    #[error("Image poisoning")]
    InvalidImageRequest(),
    #[error("{0}")]
    /// 用量额度耗尽。
    UsageLimitReached(UsageLimitReachedError),
    #[error("Selected model is at capacity. Please try a different model.")]
    /// 所选模型容量已满。
    ServerOverloaded,
    #[error("{message}")]
    /// Cyber policy 拒绝。
    CyberPolicy { message: String },
    #[error("{0}")]
    /// 响应流失败。
    ResponseStreamFailed(ResponseStreamFailed),
    #[error("{0}")]
    /// 连接失败。
    ConnectionFailed(ConnectionFailedError),
    #[error("Quota exceeded. Check your plan and billing details.")]
    /// 配额超限。
    QuotaExceeded,
    #[error(
        "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus."
    )]
    /// 当前 ChatGPT 计划不包含 Codex 使用权限。
    UsageNotIncluded,
    #[error("We're currently experiencing high demand, which may cause temporary errors.")]
    /// 服务端高负载，可能产生临时错误。
    InternalServerError,
    /// Retry limit exceeded.
    ///
    /// 重试次数达到上限。
    #[error("{0}")]
    RetryLimit(RetryLimitReachedError),
    /// Agent loop died unexpectedly
    ///
    /// Agent 主循环意外终止。
    #[error("internal error; agent loop died unexpectedly")]
    InternalAgentDied,
    /// Sandbox error
    ///
    /// Sandbox 错误。
    #[error("sandbox error: {0}")]
    Sandbox(#[from] SandboxErr),
    #[error("codex-linux-sandbox was required but not provided")]
    /// 需要但未提供 codex-linux-sandbox 可执行文件。
    LandlockSandboxExecutableNotProvided,
    #[error("unsupported operation: {0}")]
    /// 不支持的操作。
    UnsupportedOperation(String),
    #[error("{0}")]
    /// Refresh token 失败。
    RefreshTokenFailed(RefreshTokenFailedError),
    #[error("Fatal error: {0}")]
    /// 致命错误。
    Fatal(String),
    // -----------------------------------------------------------------
    // Automatic conversions for common external error types
    // 通用外部错误类型的自动转换
    // -----------------------------------------------------------------
    #[error(transparent)]
    /// IO 错误。
    Io(#[from] io::Error),
    #[error(transparent)]
    /// JSON 序列化 / 反序列化错误。
    Json(#[from] serde_json::Error),
    #[cfg(target_os = "linux")]
    #[error(transparent)]
    /// Landlock ruleset 错误。
    LandlockRuleset(#[from] landlock::RulesetError),
    #[cfg(target_os = "linux")]
    #[error(transparent)]
    /// Landlock PathFd 错误。
    LandlockPathFd(#[from] landlock::PathFdError),
    #[error(transparent)]
    /// Tokio join 错误。
    TokioJoin(#[from] JoinError),
    #[error("{0}")]
    /// 环境变量错误。
    EnvVar(EnvVarError),
}

impl From<CancelErr> for CodexErr {
    fn from(_: CancelErr) -> Self {
        CodexErr::TurnAborted
    }
}

impl CodexErr {
    /// 是否为可重试错误。
    ///
    /// 瞬时错误（如流断开、超时、网络异常）返回 `true`；确定性错误（如配额
    /// 耗尽、非法请求）返回 `false`。
    pub fn is_retryable(&self) -> bool {
        match self {
            CodexErr::TurnAborted
            | CodexErr::SessionBudgetExceeded
            | CodexErr::Interrupted
            | CodexErr::EnvVar(_)
            | CodexErr::Fatal(_)
            | CodexErr::UsageNotIncluded
            | CodexErr::QuotaExceeded
            | CodexErr::InvalidImageRequest()
            | CodexErr::InvalidRequest(_)
            | CodexErr::RefreshTokenFailed(_)
            | CodexErr::UnsupportedOperation(_)
            | CodexErr::Sandbox(_)
            | CodexErr::LandlockSandboxExecutableNotProvided
            | CodexErr::RetryLimit(_)
            | CodexErr::ContextWindowExceeded
            | CodexErr::ThreadNotFound(_)
            | CodexErr::AgentLimitReached { .. }
            | CodexErr::Spawn
            | CodexErr::SessionConfiguredNotFirstEvent
            | CodexErr::UsageLimitReached(_)
            | CodexErr::ServerOverloaded
            | CodexErr::CyberPolicy { .. } => false,
            CodexErr::Stream(..)
            | CodexErr::Timeout
            | CodexErr::RequestTimeout
            | CodexErr::UnexpectedStatus(_)
            | CodexErr::ResponseStreamFailed(_)
            | CodexErr::ConnectionFailed(_)
            | CodexErr::InternalServerError
            | CodexErr::InternalAgentDied
            | CodexErr::Io(_)
            | CodexErr::Json(_)
            | CodexErr::TokioJoin(_) => true,
            #[cfg(target_os = "linux")]
            CodexErr::LandlockRuleset(_) | CodexErr::LandlockPathFd(_) => false,
        }
    }

    /// Minimal shim so that existing `e.downcast_ref::<CodexErr>()` checks continue to compile
    /// after replacing `anyhow::Error` in the return signature. This mirrors the behavior of
    /// `anyhow::Error::downcast_ref` but works directly on our concrete enum.
    ///
    /// 兼容性垫片：在用具体枚举替换 `anyhow::Error` 返回签名后，让既有的
    /// `e.downcast_ref::<CodexErr>()` 调用继续可用。
    pub fn downcast_ref<T: std::any::Any>(&self) -> Option<&T> {
        (self as &dyn std::any::Any).downcast_ref::<T>()
    }

    /// Translate core error to client-facing protocol error.
    ///
    /// 将核心错误转换为面向客户端的协议错误 [`CodexErrorInfo`]。
    pub fn to_codex_protocol_error(&self) -> CodexErrorInfo {
        match self {
            CodexErr::ContextWindowExceeded => CodexErrorInfo::ContextWindowExceeded,
            CodexErr::SessionBudgetExceeded => CodexErrorInfo::SessionBudgetExceeded,
            CodexErr::UsageLimitReached(_)
            | CodexErr::QuotaExceeded
            | CodexErr::UsageNotIncluded => CodexErrorInfo::UsageLimitExceeded,
            CodexErr::ServerOverloaded => CodexErrorInfo::ServerOverloaded,
            CodexErr::CyberPolicy { .. } => CodexErrorInfo::CyberPolicy,
            CodexErr::RetryLimit(_) => CodexErrorInfo::ResponseTooManyFailedAttempts {
                http_status_code: self.http_status_code_value(),
            },
            CodexErr::ConnectionFailed(_) => CodexErrorInfo::HttpConnectionFailed {
                http_status_code: self.http_status_code_value(),
            },
            CodexErr::ResponseStreamFailed(_) => CodexErrorInfo::ResponseStreamConnectionFailed {
                http_status_code: self.http_status_code_value(),
            },
            CodexErr::RefreshTokenFailed(_) => CodexErrorInfo::Unauthorized,
            CodexErr::SessionConfiguredNotFirstEvent
            | CodexErr::InternalServerError
            | CodexErr::InternalAgentDied => CodexErrorInfo::InternalServerError,
            CodexErr::UnsupportedOperation(_)
            | CodexErr::ThreadNotFound(_)
            | CodexErr::AgentLimitReached { .. } => CodexErrorInfo::BadRequest,
            CodexErr::Sandbox(_) => CodexErrorInfo::SandboxError,
            _ => CodexErrorInfo::Other,
        }
    }

    /// 转换为客户端可见的错误事件，可选附加前缀。
    pub fn to_error_event(&self, message_prefix: Option<String>) -> ErrorEvent {
        let error_message = self.to_string();
        let message: String = match message_prefix {
            Some(prefix) => format!("{prefix}: {error_message}"),
            None => error_message,
        };
        ErrorEvent {
            message,
            codex_error_info: Some(self.to_codex_protocol_error()),
        }
    }

    /// 返回该错误关联的 HTTP 状态码（若存在）。
    pub fn http_status_code_value(&self) -> Option<u16> {
        let http_status_code = match self {
            CodexErr::RetryLimit(err) => Some(err.status),
            CodexErr::UnexpectedStatus(err) => Some(err.status),
            CodexErr::ConnectionFailed(err) => err.source.status(),
            CodexErr::ResponseStreamFailed(err) => err.source.status(),
            _ => None,
        };
        http_status_code.as_ref().map(StatusCode::as_u16)
    }
}

/// 连接失败错误。
///
/// 包裹 `reqwest::Error`，提供独立的 `Display` 实现。
#[derive(Debug)]
pub struct ConnectionFailedError {
    /// 原始 reqwest 错误。
    pub source: reqwest::Error,
}

impl std::fmt::Display for ConnectionFailedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Connection failed: {}", self.source)
    }
}

/// 响应流读取失败错误。
///
/// 在读取服务端响应流过程中发生错误时返回，携带原始 reqwest 错误与可选的
/// request id 以便追踪。
#[derive(Debug)]
pub struct ResponseStreamFailed {
    /// 原始 reqwest 错误。
    pub source: reqwest::Error,
    /// 关联的 request id（若可用）。
    pub request_id: Option<String>,
}

impl std::fmt::Display for ResponseStreamFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Error while reading the server response: {}{}",
            self.source,
            self.request_id
                .as_ref()
                .map(|id| format!(", request id: {id}"))
                .unwrap_or_default()
        )
    }
}

/// 意外 HTTP 响应错误。
///
/// 当收到非预期状态码时构造，保留状态码、响应体及若干诊断字段（url、cf-ray、
/// request id、身份认证错误等）便于排查。
#[derive(Debug)]
pub struct UnexpectedResponseError {
    /// HTTP 状态码。
    pub status: StatusCode,
    /// 响应体原文。
    pub body: String,
    /// 面向用户的友好消息（若服务端提供）。
    pub user_message: Option<String>,
    /// 请求 URL（若可用）。
    pub url: Option<String>,
    /// Cloudflare cf-ray 标识（若可用）。
    pub cf_ray: Option<String>,
    /// request id（若可用）。
    pub request_id: Option<String>,
    /// 身份认证错误描述（若可用）。
    pub identity_authorization_error: Option<String>,
    /// 身份认证错误码（若可用）。
    pub identity_error_code: Option<String>,
}

const UNEXPECTED_RESPONSE_BODY_MAX_BYTES: usize = 1000;

impl UnexpectedResponseError {
    /// 生成用于展示的响应体摘要，优先提取结构化错误消息，否则截断原文。
    fn display_body(&self) -> String {
        if let Some(message) = self.extract_error_message() {
            return message;
        }

        let trimmed_body = self.body.trim();
        if trimmed_body.is_empty() {
            return "Unknown error".to_string();
        }

        truncate_with_ellipsis(trimmed_body, UNEXPECTED_RESPONSE_BODY_MAX_BYTES)
    }

    /// 尝试从 JSON 响应体中提取 `error.message` 字段。
    fn extract_error_message(&self) -> Option<String> {
        let json = serde_json::from_str::<serde_json::Value>(&self.body).ok()?;
        let message = json
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(serde_json::Value::as_str)?;
        let message = message.trim();
        if message.is_empty() {
            None
        } else {
            Some(message.to_string())
        }
    }
}

impl std::fmt::Display for UnexpectedResponseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut message = if let Some(user_message) = &self.user_message {
            user_message.clone()
        } else {
            let status = self.status;
            let body = self.display_body();
            format!("unexpected status {status}: {body}")
        };
        if let Some(url) = &self.url {
            message.push_str(&format!(", url: {url}"));
        }
        if let Some(cf_ray) = &self.cf_ray {
            message.push_str(&format!(", cf-ray: {cf_ray}"));
        }
        if let Some(id) = &self.request_id {
            message.push_str(&format!(", request id: {id}"));
        }
        if let Some(auth_error) = &self.identity_authorization_error {
            message.push_str(&format!(", auth error: {auth_error}"));
        }
        if let Some(error_code) = &self.identity_error_code {
            message.push_str(&format!(", auth error code: {error_code}"));
        }
        write!(f, "{message}")
    }
}

impl std::error::Error for UnexpectedResponseError {}

/// 将文本截断到指定字节长度并追加省略号，确保不切断 UTF-8 字符边界。
fn truncate_with_ellipsis(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }

    let mut cut = max_bytes;
    while !text.is_char_boundary(cut) {
        cut = cut.saturating_sub(1);
    }
    let mut truncated = text[..cut].to_string();
    truncated.push_str("...");
    truncated
}

/// 按截断策略截断文本，用于 UI 错误展示。
fn truncate_text(content: &str, policy: TruncationPolicy) -> String {
    match policy {
        TruncationPolicy::Bytes(bytes) => truncate_middle_chars(content, bytes),
        TruncationPolicy::Tokens(tokens) => truncate_middle_with_token_budget(content, tokens).0,
    }
}

/// 重试次数达到上限错误。
///
/// 携带最后一次响应的状态码与可选 request id。
#[derive(Debug)]
pub struct RetryLimitReachedError {
    /// 最后一次响应的 HTTP 状态码。
    pub status: StatusCode,
    /// 关联的 request id（若可用）。
    pub request_id: Option<String>,
}

impl std::fmt::Display for RetryLimitReachedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "exceeded retry limit, last status: {}{}",
            self.status,
            self.request_id
                .as_ref()
                .map(|id| format!(", request id: {id}"))
                .unwrap_or_default()
        )
    }
}

/// 用量额度耗尽错误。
///
/// 携带计划类型、重置时间、速率限制快照等诊断信息，`Display` 实现会根据
/// 计划类型与限流类型生成面向用户的提示文案。
#[derive(Debug)]
pub struct UsageLimitReachedError {
    /// 用户当前的订阅计划类型。
    pub plan_type: Option<PlanType>,
    /// 限额重置时间（UTC）。
    pub resets_at: Option<DateTime<Utc>>,
    /// 速率限制快照。
    pub rate_limits: Option<Box<RateLimitSnapshot>>,
    /// 促销或附加提示信息。
    pub promo_message: Option<String>,
    /// 触发限流的具体类型。
    pub rate_limit_reached_type: Option<RateLimitReachedType>,
}

impl std::fmt::Display for UsageLimitReachedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(limit_name) = self
            .rate_limits
            .as_ref()
            .and_then(|snapshot| snapshot.limit_name.as_deref())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            && !limit_name.eq_ignore_ascii_case("codex")
        {
            return write!(
                f,
                "You've hit your usage limit for {limit_name}. Switch to another model now,{}",
                retry_suffix_after_or(self.resets_at.as_ref())
            );
        }

        if let Some(rate_limit_reached_type) = self.rate_limit_reached_type {
            match rate_limit_reached_type {
                RateLimitReachedType::WorkspaceOwnerCreditsDepleted => {
                    return write!(
                        f,
                        "Your workspace is out of credits. Add credits to continue."
                    );
                }
                RateLimitReachedType::WorkspaceMemberCreditsDepleted => {
                    return write!(
                        f,
                        "Your workspace is out of credits. Ask your workspace owner to refill in order to continue."
                    );
                }
                RateLimitReachedType::WorkspaceOwnerUsageLimitReached => {
                    return write!(
                        f,
                        "You hit your spend cap set in your workspace. Increase your spend cap to continue."
                    );
                }
                RateLimitReachedType::WorkspaceMemberUsageLimitReached => {
                    return write!(
                        f,
                        "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue."
                    );
                }
                RateLimitReachedType::RateLimitReached => {
                    // Generic limits intentionally use the existing promo or plan copy below.
                }
            }
        }

        if let Some(promo_message) = &self.promo_message {
            return write!(
                f,
                "You've hit your usage limit. {promo_message},{}",
                retry_suffix_after_or(self.resets_at.as_ref())
            );
        }

        let message = match self.plan_type.as_ref() {
            Some(PlanType::Known(KnownPlan::Plus)) => format!(
                "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits{}",
                retry_suffix_after_or(self.resets_at.as_ref())
            ),
            Some(PlanType::Known(
                KnownPlan::Team
                | KnownPlan::SelfServeBusinessUsageBased
                | KnownPlan::Business
                | KnownPlan::EnterpriseCbpUsageBased,
            )) => {
                format!(
                    "You've hit your usage limit. To get more access now, send a request to your admin{}",
                    retry_suffix_after_or(self.resets_at.as_ref())
                )
            }
            Some(PlanType::Known(KnownPlan::Free)) | Some(PlanType::Known(KnownPlan::Go)) => {
                format!(
                    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),{}",
                    retry_suffix_after_or(self.resets_at.as_ref())
                )
            }
            Some(PlanType::Known(KnownPlan::Pro | KnownPlan::ProLite)) => format!(
                "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits{}",
                retry_suffix_after_or(self.resets_at.as_ref())
            ),
            Some(PlanType::Known(KnownPlan::Enterprise))
            | Some(PlanType::Known(KnownPlan::Edu)) => format!(
                "You've hit your usage limit.{}",
                retry_suffix(self.resets_at.as_ref())
            ),
            Some(PlanType::Unknown(_)) | None => format!(
                "You've hit your usage limit.{}",
                retry_suffix(self.resets_at.as_ref())
            ),
        };

        write!(f, "{message}")
    }
}

fn retry_suffix(resets_at: Option<&DateTime<Utc>>) -> String {
    if let Some(resets_at) = resets_at {
        let formatted = format_retry_timestamp(resets_at);
        format!(" Try again at {formatted}.")
    } else {
        " Try again later.".to_string()
    }
}

fn retry_suffix_after_or(resets_at: Option<&DateTime<Utc>>) -> String {
    if let Some(resets_at) = resets_at {
        let formatted = format_retry_timestamp(resets_at);
        format!(" or try again at {formatted}.")
    } else {
        " or try again later.".to_string()
    }
}

fn format_retry_timestamp(resets_at: &DateTime<Utc>) -> String {
    let local_reset = resets_at.with_timezone(&Local);
    let local_now = now_for_retry().with_timezone(&Local);
    if local_reset.date_naive() == local_now.date_naive() {
        local_reset.format("%-I:%M %p").to_string()
    } else {
        let suffix = day_suffix(local_reset.day());
        local_reset
            .format(&format!("%b %-d{suffix}, %Y %-I:%M %p"))
            .to_string()
    }
}

fn day_suffix(day: u32) -> &'static str {
    match day {
        11..=13 => "th",
        _ => match day % 10 {
            1 => "st",
            2 => "nd", // codespell:ignore
            3 => "rd",
            _ => "th",
        },
    }
}

#[cfg(test)]
thread_local! {
    static NOW_OVERRIDE: std::cell::RefCell<Option<DateTime<Utc>>> =
        const { std::cell::RefCell::new(None) };
}

fn now_for_retry() -> DateTime<Utc> {
    #[cfg(test)]
    {
        if let Some(now) = NOW_OVERRIDE.with(|cell| *cell.borrow()) {
            return now;
        }
    }
    Utc::now()
}

/// 环境变量错误。
///
/// 表示缺失必需的环境变量，可附带面向用户的设置指引。
#[derive(Debug)]
pub struct EnvVarError {
    /// Name of the environment variable that is missing.
    ///
    /// 缺失的环境变量名称。
    pub var: String,
    /// Optional instructions to help the user get a valid value for the
    /// variable and set it.
    ///
    /// 可选的用户指引，帮助用户获取合法值并设置该变量。
    pub instructions: Option<String>,
}

impl std::fmt::Display for EnvVarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Missing environment variable: `{}`.", self.var)?;
        if let Some(instructions) = &self.instructions {
            write!(f, " {instructions}")?;
        }
        Ok(())
    }
}

/// 生成面向 UI 展示的错误消息。
///
/// 针对 sandbox 与超时错误做特殊处理以提供更友好的输出；其余错误直接使用
/// `Display` 实现。最终消息会按 `ERROR_MESSAGE_UI_MAX_BYTES` 截断。
pub fn get_error_message_ui(e: &CodexErr) -> String {
    let message = match e {
        CodexErr::Sandbox(SandboxErr::Denied { output, .. }) => {
            let aggregated = output.aggregated_output.text.trim();
            if !aggregated.is_empty() {
                output.aggregated_output.text.clone()
            } else {
                let stderr = output.stderr.text.trim();
                let stdout = output.stdout.text.trim();
                match (stderr.is_empty(), stdout.is_empty()) {
                    (false, false) => format!("{stderr}\n{stdout}"),
                    (false, true) => output.stderr.text.clone(),
                    (true, false) => output.stdout.text.clone(),
                    (true, true) => format!(
                        "command failed inside sandbox with exit code {}",
                        output.exit_code
                    ),
                }
            }
        }
        // Timeouts are not sandbox errors from a UX perspective; present them plainly.
        CodexErr::Sandbox(SandboxErr::Timeout { output }) => {
            format!(
                "error: command timed out after {} ms",
                output.duration.as_millis()
            )
        }
        _ => e.to_string(),
    };

    truncate_text(
        &message,
        TruncationPolicy::Bytes(ERROR_MESSAGE_UI_MAX_BYTES),
    )
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod tests;

//! Thread 域 Tauri 命令。
//!
//! 提供线程生命周期管理：创建、列表、读取、取消订阅。
//! 每个命令只做参数验证 + 调用 bridge 层 + 返回结果，
//! 不包含业务逻辑（业务逻辑在 codex-rs 内部）。
//!
//! ## 设计说明
//!
//! ### 输入：DTO（Data Transfer Object）
//!
//! codex-rs 的 Params 类型只实现了 `ts_rs::TS`，没有实现 `specta::Type`，
//! 因此无法直接用作 tauri-specta 命令参数。我们为每个命令创建轻量级
//! DTO 结构体，只包含简单类型 + `specta::Type` derive。
//! 命令内部将 DTO 转换为 codex-rs 的 Params。
//!
//! ### 输出：`String`（JSON 字符串）
//!
//! codex-rs 的 Response 类型包含大量复杂嵌套类型（`Thread`、`SandboxPolicy`
//! 等），镜像这些类型到 specta 类型工作量巨大且容易过时。
//! 因此命令返回序列化后的 JSON 字符串（`String`），而非 `serde_json::Value`。
//!
//! **为什么不用 `serde_json::Value`？** `serde_json::Value` 是递归类型
//!（`Object(Map<String, Value>)`、`Array(Vec<Value>)`），会导致 tauri-specta
//! TypeScript 代码生成时栈溢出（即使 128MB 栈也不够）。使用 `String` 完全
//! 避免了递归类型展开，前端调用后 `JSON.parse()` 即可得到结构化数据。

use codex_app_server_protocol::ClientRequest;
use serde::Deserialize;
use serde::Serialize;
use specta::Type;

#[cfg(test)]
use crate::bridge::request::RequestIdSequencer;
use crate::bridge::request::send_request;
use crate::error::AppError;
use crate::state;

// =============================================================================
// DTO — 命令参数（实现 specta::Type，用于生成 TypeScript 绑定）
// =============================================================================

/// `thread/start` 命令的参数。
///
/// 对应 codex-rs 的 `v2::ThreadStartParams`，但只暴露桌面端常用的字段。
/// 其余字段使用默认值。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartArgs {
    /// 模型名称（如 `"gpt-4o"`）。为空时使用配置文件中的默认模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 模型提供商名称。为空时使用默认提供商。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    /// 工作目录路径。为空时使用用户主目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// `thread/list` 命令的参数。
///
/// 对应 codex-rs 的 `v2::ThreadListParams`，简化为桌面端常用字段。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListArgs {
    /// 分页游标（上一次调用返回的 `nextCursor`）。为空时从第一页开始。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。为空时使用服务器默认值（通常 20）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `thread/read` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadArgs {
    /// 要读取的线程 ID（必填）。
    pub thread_id: String,
    /// 是否包含 turn 和 item 历史。默认 false。
    #[serde(default)]
    pub include_turns: bool,
}

/// `thread/unsubscribe` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUnsubscribeArgs {
    /// 要取消订阅的线程 ID（必填）。
    pub thread_id: String,
}

// =============================================================================
// 新增 DTO — 对齐协议层全量 thread 域命令（32 个）
// =============================================================================
//
// 设计原则：
// 1. 简单命令（字段全为 String/u32/bool/Option<T>）：完整结构化 DTO
// 2. 复杂命令（含 AskForApproval/SandboxPolicy 等协议类型）：
//    DTO 只含核心字段 + `params_json: Option<String>` 承载完整协议参数
//    前端可传 params_json 覆盖任何协议字段
// 3. 所有 DTO 只用 specta::Type 支持的简单类型，避免递归类型栈溢出

// --- 生命周期命令 ---

/// `thread/resume` 命令的参数。
///
/// 协议层 ThreadResumeParams 有 17 个字段（含 ResponseItem/SandboxMode 等），
/// DTO 只暴露桌面端常用字段，其余通过 `params_json` 透传。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeArgs {
    /// 要恢复的线程 ID。
    pub thread_id: String,
    /// 模型名称（覆盖线程默认模型）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 模型提供商。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    /// 工作目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 线程文件路径（thread_id 为空时使用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 完整协议参数 JSON（覆盖上述字段，用于传递复杂字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params_json: Option<String>,
}

/// `thread/fork` 命令的参数。
///
/// 协议层 ThreadForkParams 有 17 个字段，DTO 暴露常用字段 + params_json。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkArgs {
    /// 要分叉的源线程 ID。
    pub thread_id: String,
    /// 分叉点 turn ID（为空时取最后一个 turn）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
    /// 模型名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 模型提供商。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    /// 工作目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 是否为临时线程（不持久化到磁盘）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ephemeral: bool,
    /// 完整协议参数 JSON。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params_json: Option<String>,
}

/// `thread/archive` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadArchiveArgs {
    /// 要归档的线程 ID。
    pub thread_id: String,
}

/// `thread/unarchive` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUnarchiveArgs {
    /// 要取消归档的线程 ID。
    pub thread_id: String,
}

/// `thread/delete` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDeleteArgs {
    /// 要删除的线程 ID。
    pub thread_id: String,
}

/// `thread/rollback` 命令的参数。
///
/// 注意：后端标记为 DEPRECATED，未来可能移除。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRollbackArgs {
    /// 要回滚的线程 ID。
    pub thread_id: String,
    /// 回滚的 turn 数量。
    pub num_turns: u32,
}

/// `thread/name/set` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSetNameArgs {
    /// 要重命名的线程 ID。
    pub thread_id: String,
    /// 新名称。
    pub name: String,
}

// --- 元数据命令 ---

/// `thread/metadata/update` 命令的参数。
///
/// 协议层支持 git_info 等复杂字段，DTO 用 JSON 字符串承载。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadataUpdateArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// Git 信息 JSON（对应 ThreadMetadataGitInfoUpdateParams）。
    /// 格式：`{ "sha": "...", "branch": "...", "originUrl": "..." }`，
    /// 每个字段可为 null 表示清除。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_info_json: Option<String>,
}

// --- Goal 子域命令 ---

/// `thread/goal/set` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 目标描述。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    /// 目标状态（active/paused/blocked/usageLimited/budgetLimited/complete）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Token 预算（null 表示清除）。
    ///
    /// 注意：使用 `f64` 而非 `i64`，因为 tauri-specta 禁止导出 BigInt 类型
    ///（i64/u64 等）到 TypeScript。serde_json 在反序列化为协议层的 `i64` 时
    /// 会自动转换整数值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<f64>,
}

/// `thread/goal/get` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalGetArgs {
    /// 线程 ID。
    pub thread_id: String,
}

/// `thread/goal/clear` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalClearArgs {
    /// 线程 ID。
    pub thread_id: String,
}

// --- 列表查询命令 ---

/// `thread/loaded/list` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLoadedListArgs {
    /// 分页游标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `thread/search` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchArgs {
    /// 搜索关键词。
    pub search_term: String,
    /// 分页游标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// 排序键（createdAt/updatedAt/recencyAt）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_key: Option<String>,
    /// 排序方向（asc/desc）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<String>,
    /// 源类型过滤（cli/vscode/exec/appServer/subAgent/...）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kinds: Option<Vec<String>>,
    /// 归档状态过滤。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

/// `thread/turns/list` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnsListArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 分页游标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// 排序方向（asc/desc）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<String>,
    /// item 详情级别（notLoaded/summary/full）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items_view: Option<String>,
}

/// `thread/items/list` 命令的参数（experimental）。
///
/// **核心命令**：用于分页拉取线程消息项，替代前端 mock。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItemsListArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 按 turn ID 过滤（为空时返回线程内所有 item）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// 分页游标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// 排序方向（asc/desc，默认 asc）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<String>,
}

/// `thread/inject_items` 命令的参数。
///
/// 用于向线程追加原始 Responses API items。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInjectItemsArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// items 的 JSON 数组字符串（每个元素是 Responses API item 对象）。
    pub items_json: String,
}

// --- 操作命令 ---

/// `thread/compact/start` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCompactStartArgs {
    /// 线程 ID。
    pub thread_id: String,
}

/// `thread/shellCommand` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadShellCommandArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 要执行的 shell 命令。
    pub command: String,
}

/// `thread/approveGuardianDeniedAction` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadApproveGuardianDeniedActionArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// GuardianAssessmentEvent 的 JSON 字符串。
    pub event_json: String,
}

// --- Experimental 命令 ---

/// `thread/increment_elicitation` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIncrementElicitationArgs {
    /// 线程 ID。
    pub thread_id: String,
}

/// `thread/decrement_elicitation` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDecrementElicitationArgs {
    /// 线程 ID。
    pub thread_id: String,
}

/// `thread/settings/update` 命令的参数（experimental）。
///
/// 协议层 ThreadSettingsUpdateParams 有 13 个字段（含 AskForApproval/SandboxPolicy 等），
/// DTO 用 `params_json` 承载完整协议参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSettingsUpdateArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 完整协议参数 JSON（对应 ThreadSettingsUpdateParams）。
    /// 支持字段：cwd/approvalPolicy/approvalsReviewer/sandboxPolicy/permissions/
    /// model/serviceTier/effort/summary/collaborationMode/personality 等。
    pub params_json: String,
}

/// `thread/memoryMode/set` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMemoryModeSetArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 记忆模式（enabled/disabled）。
    pub mode: String,
}

// --- Background Terminals 命令（experimental） ---

/// `thread/backgroundTerminals/clean` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBackgroundTerminalsCleanArgs {
    /// 线程 ID。
    pub thread_id: String,
}

/// `thread/backgroundTerminals/list` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBackgroundTerminalsListArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 分页游标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 每页数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `thread/backgroundTerminals/terminate` 命令的参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBackgroundTerminalsTerminateArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 要终止的进程 ID。
    pub process_id: String,
}

// --- Realtime 命令（experimental） ---

/// `thread/realtime/start` 命令的参数（experimental）。
///
/// 协议层 ThreadRealtimeStartParams 有 13 个字段（含 RealtimeOutputModality 等），
/// DTO 用 `params_json` 承载完整协议参数。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeStartArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 完整协议参数 JSON（对应 ThreadRealtimeStartParams）。
    /// 必填字段：outputModality（text/audio）。
    /// 可选字段：model/voice/transport/version/prompt/... 等。
    pub params_json: String,
}

/// `thread/realtime/appendAudio` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeAppendAudioArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 音频块的 JSON 字符串（对应 ThreadRealtimeAudioChunk）。
    /// 格式：`{ "data": "<base64>", "sampleRate": 24000, "numChannels": 1, ... }`。
    pub audio_json: String,
}

/// `thread/realtime/appendText` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeAppendTextArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 要追加的文本。
    pub text: String,
    /// 角色（user/developer/assistant，默认 user）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// `thread/realtime/appendSpeech` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeAppendSpeechArgs {
    /// 线程 ID。
    pub thread_id: String,
    /// 要合成的文本。
    pub text: String,
}

/// `thread/realtime/stop` 命令的参数（experimental）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeStopArgs {
    /// 线程 ID。
    pub thread_id: String,
}

/// `thread/realtime/listVoices` 命令的参数（experimental）。
///
/// 协议层为空结构体，DTO 也为空（specta 要求至少有占位）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRealtimeListVoicesArgs {}

// =============================================================================
// 命令实现
// =============================================================================

/// 创建新线程。
///
/// 调用 codex-rs 的 `thread/start` 方法，使用指定的模型和工作目录
/// 初始化一个新的会话线程。
///
/// # 参数
///
/// - `args` — 线程启动参数（模型、工作目录等）
///
/// # 返回
///
/// 返回 `thread/start` 的 JSON 字符串，包含 `thread`、`model`、
/// `cwd` 等字段。前端 `JSON.parse()` 后通过 TypeScript 类型断言使用。
///
/// # 错误
///
/// - [`AppError::NotInitialized`] — codex 运行时未初始化
/// - [`AppError::TypedRequestError`] — 请求失败（传输/服务器/反序列化）
/// - [`AppError::Serialization`] — 响应序列化为 JSON 字符串失败
#[tauri::command]
#[specta::specta]
pub async fn thread_start(args: ThreadStartArgs) -> Result<String, AppError> {
    // 1. 获取全局 sender
    let sender = state::handle()?;

    // 2. 构造 codex-rs 的 ThreadStartParams
    //    使用 serde_json::Value 构造，因为 ThreadStartParams 包含大量
    //    ExperimentalApi 字段，直接构造会非常冗长。
    let params = serde_json::json!({
        "model": args.model,
        "modelProvider": args.model_provider,
        "cwd": args.cwd,
    });

    // 3. 构造 ClientRequest
    let request = ClientRequest::ThreadStart {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadStartParams: {e}"))
        })?,
    };

    // 4. 发送请求并将响应序列化为 JSON 字符串
    //    返回 String 而非 serde_json::Value，避免 tauri-specta 栈溢出
    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出所有线程。
///
/// 调用 codex-rs 的 `thread/list` 方法，分页返回线程列表。
///
/// # 参数
///
/// - `args` — 分页参数（游标、每页数量）
///
/// # 返回
///
/// 返回 `thread/list` 的 JSON 字符串，包含 `threads` 数组和
/// `nextCursor` 分页游标。
#[tauri::command]
#[specta::specta]
pub async fn thread_list(args: ThreadListArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({
        "cursor": args.cursor,
        "limit": args.limit,
    });

    let request = ClientRequest::ThreadList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadListParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 读取线程详情。
///
/// 调用 codex-rs 的 `thread/read` 方法，获取线程信息和可选的 turn 历史。
///
/// # 参数
///
/// - `args` — 包含 `thread_id` 和 `include_turns` 标志
///
/// # 返回
///
/// 返回 `thread/read` 的 JSON 字符串，包含 `thread` 对象。
#[tauri::command]
#[specta::specta]
pub async fn thread_read(args: ThreadReadArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // 参数验证：thread_id 不能为空
    if args.thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "includeTurns": args.include_turns,
    });

    let request = ClientRequest::ThreadRead {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadReadParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 取消订阅线程。
///
/// 调用 codex-rs 的 `thread/unsubscribe` 方法，停止接收指定线程的事件。
/// 这是在关闭线程前释放服务器端资源的推荐操作。
///
/// # 参数
///
/// - `args` — 包含要取消订阅的 `thread_id`
///
/// # 返回
///
/// 返回 `thread/unsubscribe` 的 JSON 字符串，包含 `status` 字段
///（值为 `"notLoaded"`、`"notSubscribed"` 或 `"unsubscribed"`）。
#[tauri::command]
#[specta::specta]
pub async fn thread_unsubscribe(args: ThreadUnsubscribeArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // 参数验证
    if args.thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
    });

    let request = ClientRequest::ThreadUnsubscribe {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadUnsubscribeParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// =============================================================================
// 新增命令实现 — 对齐协议层全量 thread 域命令（32 个）
// =============================================================================
//
// 实现模式：
// 1. 简单命令：用 serde_json::json! 直接构造 params
// 2. 复杂命令（含 params_json）：先用 json! 构造核心字段，再合并 params_json
//    params_json 优先级更高，可覆盖任何核心字段
// 3. 所有命令统一返回 Result<String, AppError>，避免 specta 递归类型栈溢出
//
// 辅助函数（merge_optional_params_json / parse_required_params_json）封装
// params_json 的合并/解析逻辑，避免每个复杂命令重复编写合并代码。

/// 将可选的 `params_json` 合并到基础 params JSON 中。
///
/// `params_json` 中的字段会覆盖基础 params 中的同名字段。
/// 用于 DTO 中 `params_json` 为 `Option<String>` 的命令（如 resume/fork）。
fn merge_optional_params_json(
    base: serde_json::Value,
    params_json: Option<String>,
    command_name: &str,
) -> Result<serde_json::Value, AppError> {
    let mut result = base;
    if let Some(extra) = params_json {
        let extra_value: serde_json::Value = serde_json::from_str(&extra).map_err(|e| {
            AppError::validation(format!("invalid params_json for {command_name}: {e}"))
        })?;
        // 只有当两边都是对象时才能合并
        if let (Some(obj), Some(extra_obj)) =
            (result.as_object_mut(), extra_value.as_object())
        {
            for (k, v) in extra_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(result)
}

/// 解析必填的 `params_json` 并注入 `thread_id`。
///
/// 用于 DTO 中 `params_json` 为必填 `String` 的命令
///（如 settings_update/realtime_start）。
/// `params_json` 承载协议层的复杂字段，`thread_id` 由 DTO 结构化字段提供。
fn parse_required_params_json(
    params_json: &str,
    thread_id: &str,
    command_name: &str,
) -> Result<serde_json::Value, AppError> {
    let mut value: serde_json::Value = serde_json::from_str(params_json).map_err(|e| {
        AppError::validation(format!("invalid params_json for {command_name}: {e}"))
    })?;
    // 注入 threadId（DTO 的结构化字段优先级最高，覆盖 params_json 中的同名字段）
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "threadId".to_string(),
            serde_json::Value::String(thread_id.to_string()),
        );
    }
    Ok(value)
}

/// 校验 thread_id 非空。
fn validate_thread_id(thread_id: &str) -> Result<(), AppError> {
    if thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }
    Ok(())
}

// --- 生命周期命令（7 个）---

/// 恢复线程（`thread/resume`）。
///
/// 加载已有线程到内存，可覆盖模型、工作目录等配置。
/// 复杂字段（history/sandbox/approvalPolicy 等）通过 `params_json` 透传。
#[tauri::command]
#[specta::specta]
pub async fn thread_resume(args: ThreadResumeArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 构造核心字段
    let base = serde_json::json!({
        "threadId": args.thread_id,
        "model": args.model,
        "modelProvider": args.model_provider,
        "cwd": args.cwd,
        "path": args.path,
    });
    // 合并 params_json（覆盖核心字段）
    let params = merge_optional_params_json(base, args.params_json, "thread_resume")?;

    let request = ClientRequest::ThreadResume {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadResumeParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 分叉线程（`thread/fork`）。
///
/// 从指定 turn 创建线程副本，可覆盖模型、工作目录等配置。
#[tauri::command]
#[specta::specta]
pub async fn thread_fork(args: ThreadForkArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let base = serde_json::json!({
        "threadId": args.thread_id,
        "lastTurnId": args.last_turn_id,
        "model": args.model,
        "modelProvider": args.model_provider,
        "cwd": args.cwd,
        "ephemeral": args.ephemeral,
    });
    let params = merge_optional_params_json(base, args.params_json, "thread_fork")?;

    let request = ClientRequest::ThreadFork {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadForkParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 归档线程（`thread/archive`）。
///
/// 将线程标记为已归档，归档后的线程默认不出现在线程列表中。
#[tauri::command]
#[specta::specta]
pub async fn thread_archive(args: ThreadArchiveArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadArchive {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadArchiveParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 取消归档线程（`thread/unarchive`）。
///
/// 将线程从归档状态恢复到正常状态。
#[tauri::command]
#[specta::specta]
pub async fn thread_unarchive(args: ThreadUnarchiveArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadUnarchive {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadUnarchiveParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 删除线程（`thread/delete`）。
///
/// 永久删除线程及其关联的 rollout 文件。此操作不可逆。
#[tauri::command]
#[specta::specta]
pub async fn thread_delete(args: ThreadDeleteArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadDelete {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadDeleteParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 回滚线程（`thread/rollback`，已废弃）。
///
/// 从线程末尾移除指定数量的 turn。仅修改历史记录，不回滚文件变更。
///
/// # 废弃说明
/// 协议层标记为 DEPRECATED，未来版本可能移除。
#[tauri::command]
#[specta::specta]
pub async fn thread_rollback(args: ThreadRollbackArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    if args.num_turns == 0 {
        return Err(AppError::validation("num_turns must be >= 1"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "numTurns": args.num_turns,
    });

    let request = ClientRequest::ThreadRollback {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadRollbackParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 重命名线程（`thread/name/set`）。
#[tauri::command]
#[specta::specta]
pub async fn thread_set_name(args: ThreadSetNameArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    if args.name.trim().is_empty() {
        return Err(AppError::validation("name cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "name": args.name,
    });

    let request = ClientRequest::ThreadSetName {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadSetNameParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- 元数据命令（1 个）---

/// 更新线程元数据（`thread/metadata/update`）。
///
/// 目前支持更新 Git 信息（sha/branch/originUrl）。
/// 每个字段可省略（保持不变）、设为 null（清除）或设为字符串（替换）。
#[tauri::command]
#[specta::specta]
pub async fn thread_metadata_update(args: ThreadMetadataUpdateArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 解析可选的 git_info_json
    let git_info: Option<serde_json::Value> = if let Some(json) = args.git_info_json {
        Some(serde_json::from_str(&json).map_err(|e| {
            AppError::validation(format!("invalid git_info_json for thread_metadata_update: {e}"))
        })?)
    } else {
        None
    };

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "gitInfo": git_info,
    });

    let request = ClientRequest::ThreadMetadataUpdate {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadMetadataUpdateParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- Goal 子域命令（3 个）---

/// 设置线程目标（`thread/goal/set`）。
///
/// 可设置目标描述、状态和 token 预算。所有字段可选，null 表示清除。
#[tauri::command]
#[specta::specta]
pub async fn thread_goal_set(args: ThreadGoalSetArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "objective": args.objective,
        "status": args.status,
        "tokenBudget": args.token_budget,
    });

    let request = ClientRequest::ThreadGoalSet {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadGoalSetParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 获取线程目标（`thread/goal/get`）。
#[tauri::command]
#[specta::specta]
pub async fn thread_goal_get(args: ThreadGoalGetArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadGoalGet {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadGoalGetParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 清除线程目标（`thread/goal/clear`）。
#[tauri::command]
#[specta::specta]
pub async fn thread_goal_clear(args: ThreadGoalClearArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadGoalClear {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadGoalClearParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- 列表查询命令（5 个）---

/// 列出已加载到内存的线程（`thread/loaded/list`）。
///
/// 返回当前服务器进程中活跃的线程 ID 列表。
#[tauri::command]
#[specta::specta]
pub async fn thread_loaded_list(args: ThreadLoadedListArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({
        "cursor": args.cursor,
        "limit": args.limit,
    });

    let request = ClientRequest::ThreadLoadedList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadLoadedListParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 搜索线程（`thread/search`，experimental）。
///
/// 按关键词搜索线程标题和内容，支持过滤和排序。
#[tauri::command]
#[specta::specta]
pub async fn thread_search(args: ThreadSearchArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    if args.search_term.trim().is_empty() {
        return Err(AppError::validation("search_term cannot be empty"));
    }

    let params = serde_json::json!({
        "searchTerm": args.search_term,
        "cursor": args.cursor,
        "limit": args.limit,
        "sortKey": args.sort_key,
        "sortDirection": args.sort_direction,
        "sourceKinds": args.source_kinds,
        "archived": args.archived,
    });

    let request = ClientRequest::ThreadSearch {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadSearchParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出线程的 turn（`thread/turns/list`，experimental）。
///
/// 分页返回线程的 turn 历史，可选择 item 详情级别。
#[tauri::command]
#[specta::specta]
pub async fn thread_turns_list(args: ThreadTurnsListArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "cursor": args.cursor,
        "limit": args.limit,
        "sortDirection": args.sort_direction,
        "itemsView": args.items_view,
    });

    let request = ClientRequest::ThreadTurnsList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadTurnsListParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出线程的消息项（`thread/items/list`，experimental）。
///
/// **核心命令**：分页拉取线程内的 ThreadItem，替代前端 mock 数据。
/// 可按 turn_id 过滤，支持游标分页和排序方向。
#[tauri::command]
#[specta::specta]
pub async fn thread_items_list(args: ThreadItemsListArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "turnId": args.turn_id,
        "cursor": args.cursor,
        "limit": args.limit,
        "sortDirection": args.sort_direction,
    });

    let request = ClientRequest::ThreadItemsList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadItemsListParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 注入原始 Responses API items（`thread/inject_items`）。
///
/// 向线程追加原始 items，不触发新 turn。用于客户端预填充上下文。
#[tauri::command]
#[specta::specta]
pub async fn thread_inject_items(args: ThreadInjectItemsArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 解析 items_json 为 JSON 数组
    let items: Vec<serde_json::Value> = serde_json::from_str(&args.items_json).map_err(|e| {
        AppError::validation(format!(
            "invalid items_json for thread_inject_items (expected JSON array): {e}"
        ))
    })?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "items": items,
    });

    let request = ClientRequest::ThreadInjectItems {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadInjectItemsParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- 操作命令（3 个）---

/// 启动线程压缩（`thread/compact/start`）。
///
/// 触发线程历史的上下文压缩，将旧 turn 总结为更紧凑的形式。
#[tauri::command]
#[specta::specta]
pub async fn thread_compact_start(args: ThreadCompactStartArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadCompactStart {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadCompactStartParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 执行 shell 命令（`thread/shellCommand`）。
///
/// 在线程的工作目录中执行 shell 命令。命令在线程沙箱外运行，
/// 保留 shell 语法（管道、重定向等）。
#[tauri::command]
#[specta::specta]
pub async fn thread_shell_command(args: ThreadShellCommandArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    if args.command.trim().is_empty() {
        return Err(AppError::validation("command cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "command": args.command,
    });

    let request = ClientRequest::ThreadShellCommand {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadShellCommandParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 批准 Guardian 拒绝的操作（`thread/approveGuardianDeniedAction`）。
///
/// 允许用户覆盖 Guardian 的安全决策，强制执行被拒绝的操作。
#[tauri::command]
#[specta::specta]
pub async fn thread_approve_guardian_denied_action(
    args: ThreadApproveGuardianDeniedActionArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 解析 event_json 为 GuardianAssessmentEvent
    let event: serde_json::Value = serde_json::from_str(&args.event_json).map_err(|e| {
        AppError::validation(format!(
            "invalid event_json for thread_approve_guardian_denied_action: {e}"
        ))
    })?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "event": event,
    });

    let request = ClientRequest::ThreadApproveGuardianDeniedAction {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadApproveGuardianDeniedActionParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- Experimental 命令（4 个）---

/// 增加线程 elicitation 计数（`thread/increment_elicitation`，experimental）。
///
/// 用于外部助手在用户审批等待期间暂停超时计时。
#[tauri::command]
#[specta::specta]
pub async fn thread_increment_elicitation(
    args: ThreadIncrementElicitationArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadIncrementElicitation {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadIncrementElicitationParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 减少线程 elicitation 计数（`thread/decrement_elicitation`，experimental）。
///
/// 计数归零时恢复超时计时。
#[tauri::command]
#[specta::specta]
pub async fn thread_decrement_elicitation(
    args: ThreadDecrementElicitationArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadDecrementElicitation {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadDecrementElicitationParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 更新线程设置（`thread/settings/update`，experimental）。
///
/// 协议层 ThreadSettingsUpdateParams 有 13 个字段（含 AskForApproval/SandboxPolicy 等），
/// 通过 `params_json` 承载完整协议参数。
#[tauri::command]
#[specta::specta]
pub async fn thread_settings_update(
    args: ThreadSettingsUpdateArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 解析必填 params_json 并注入 threadId
    let params = parse_required_params_json(
        &args.params_json,
        &args.thread_id,
        "thread_settings_update",
    )?;

    let request = ClientRequest::ThreadSettingsUpdate {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadSettingsUpdateParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 设置线程记忆模式（`thread/memoryMode/set`，experimental）。
///
/// 启用或禁用线程的长期记忆功能。
#[tauri::command]
#[specta::specta]
pub async fn thread_memory_mode_set(
    args: ThreadMemoryModeSetArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 校验 mode 取值
    let mode = match args.mode.as_str() {
        "enabled" => "enabled",
        "disabled" => "disabled",
        other => {
            return Err(AppError::validation(format!(
                "invalid mode '{other}' for thread_memory_mode_set (expected 'enabled' or 'disabled')"
            )));
        }
    };

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "mode": mode,
    });

    let request = ClientRequest::ThreadMemoryModeSet {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadMemoryModeSetParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- Background Terminals 命令（3 个，experimental）---

/// 清理线程的后台终端（`thread/backgroundTerminals/clean`，experimental）。
///
/// 清除已终止的后台终端进程记录。
#[tauri::command]
#[specta::specta]
pub async fn thread_background_terminals_clean(
    args: ThreadBackgroundTerminalsCleanArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadBackgroundTerminalsClean {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadBackgroundTerminalsCleanParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出线程的后台终端（`thread/backgroundTerminals/list`，experimental）。
///
/// 分页返回线程关联的后台终端进程列表。
#[tauri::command]
#[specta::specta]
pub async fn thread_background_terminals_list(
    args: ThreadBackgroundTerminalsListArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "cursor": args.cursor,
        "limit": args.limit,
    });

    let request = ClientRequest::ThreadBackgroundTerminalsList {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadBackgroundTerminalsListParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 终止线程的后台终端（`thread/backgroundTerminals/terminate`，experimental）。
///
/// 终止指定 process_id 的后台终端进程。
#[tauri::command]
#[specta::specta]
pub async fn thread_background_terminals_terminate(
    args: ThreadBackgroundTerminalsTerminateArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    if args.process_id.trim().is_empty() {
        return Err(AppError::validation("process_id cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "processId": args.process_id,
    });

    let request = ClientRequest::ThreadBackgroundTerminalsTerminate {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadBackgroundTerminalsTerminateParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

// --- Realtime 命令（6 个，experimental）---

/// 启动线程实时会话（`thread/realtime/start`，experimental）。
///
/// 协议层 ThreadRealtimeStartParams 有 13 个字段（含 RealtimeOutputModality 等），
/// 通过 `params_json` 承载完整协议参数。
#[tauri::command]
#[specta::specta]
pub async fn thread_realtime_start(args: ThreadRealtimeStartArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = parse_required_params_json(
        &args.params_json,
        &args.thread_id,
        "thread_realtime_start",
    )?;

    let request = ClientRequest::ThreadRealtimeStart {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadRealtimeStartParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 追加实时音频输入（`thread/realtime/appendAudio`，experimental）。
///
/// 向线程实时会话追加音频块。audio_json 格式：
/// `{ "data": "<base64>", "sampleRate": 24000, "numChannels": 1, ... }`。
#[tauri::command]
#[specta::specta]
pub async fn thread_realtime_append_audio(
    args: ThreadRealtimeAppendAudioArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    // 解析 audio_json 为 ThreadRealtimeAudioChunk
    let audio: serde_json::Value = serde_json::from_str(&args.audio_json).map_err(|e| {
        AppError::validation(format!(
            "invalid audio_json for thread_realtime_append_audio: {e}"
        ))
    })?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "audio": audio,
    });

    let request = ClientRequest::ThreadRealtimeAppendAudio {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadRealtimeAppendAudioParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 追加实时文本输入（`thread/realtime/appendText`，experimental）。
///
/// 向线程实时会话追加文本，可指定角色（user/developer/assistant）。
#[tauri::command]
#[specta::specta]
pub async fn thread_realtime_append_text(
    args: ThreadRealtimeAppendTextArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "text": args.text,
        "role": args.role,
    });

    let request = ClientRequest::ThreadRealtimeAppendText {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadRealtimeAppendTextParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 追加实时语音输入（`thread/realtime/appendSpeech`，experimental）。
///
/// 向线程实时会话追加可合成语音的文本。
#[tauri::command]
#[specta::specta]
pub async fn thread_realtime_append_speech(
    args: ThreadRealtimeAppendSpeechArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "text": args.text,
    });

    let request = ClientRequest::ThreadRealtimeAppendSpeech {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadRealtimeAppendSpeechParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 停止线程实时会话（`thread/realtime/stop`，experimental）。
#[tauri::command]
#[specta::specta]
pub async fn thread_realtime_stop(args: ThreadRealtimeStopArgs) -> Result<String, AppError> {
    let sender = state::handle()?;
    validate_thread_id(&args.thread_id)?;

    let params = serde_json::json!({ "threadId": args.thread_id });

    let request = ClientRequest::ThreadRealtimeStop {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct ThreadRealtimeStopParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 列出实时会话支持的语音（`thread/realtime/listVoices`，experimental）。
///
/// 协议层为空参数，DTO 也为空结构体。
#[tauri::command]
#[specta::specta]
pub async fn thread_realtime_list_voices(
    _args: ThreadRealtimeListVoicesArgs,
) -> Result<String, AppError> {
    let sender = state::handle()?;

    let params = serde_json::json!({});

    let request = ClientRequest::ThreadRealtimeListVoices {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!(
                "failed to construct ThreadRealtimeListVoicesParams: {e}"
            ))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_start_args_serializes_correctly() {
        let args = ThreadStartArgs {
            model: Some("gpt-4o".to_string()),
            model_provider: Some("openai".to_string()),
            cwd: Some("/home/user".to_string()),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["model"], "gpt-4o");
        assert_eq!(json["modelProvider"], "openai");
        assert_eq!(json["cwd"], "/home/user");
    }

    #[test]
    fn thread_start_args_with_defaults_omits_optional_fields() {
        let args = ThreadStartArgs {
            model: None,
            model_provider: None,
            cwd: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        // 可选字段应被跳过
        assert_eq!(json, "{}");
    }

    #[test]
    fn thread_list_args_serializes_correctly() {
        let args = ThreadListArgs {
            cursor: Some("abc123".to_string()),
            limit: Some(10),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["cursor"], "abc123");
        assert_eq!(json["limit"], 10);
    }

    #[test]
    fn thread_read_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "threadId": "thread-001",
            "includeTurns": true
        });
        let args: ThreadReadArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.thread_id, "thread-001");
        assert!(args.include_turns);
    }

    #[test]
    fn thread_read_args_defaults_include_turns_to_false() {
        let json = serde_json::json!({
            "threadId": "thread-001"
        });
        let args: ThreadReadArgs = serde_json::from_value(json).unwrap();
        assert!(!args.include_turns);
    }

    #[test]
    fn thread_unsubscribe_args_serializes_correctly() {
        let args = ThreadUnsubscribeArgs {
            thread_id: "thread-002".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["threadId"], "thread-002");
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}

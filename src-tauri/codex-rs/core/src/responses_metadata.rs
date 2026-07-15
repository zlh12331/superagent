//! Responses API 元数据构建。
//!
//! 本模块负责构建发送给 Responses API 的 Codex 元数据快照，包括 installation/session/thread
//! 标识、请求类型、压缩信息、工作区信息等。元数据以 `client_metadata["x-codex-turn-metadata"]`
//! 为权威来源，同时生成兼容的扁平 key 和 HTTP header 投影。

use std::collections::BTreeMap;
use std::collections::HashMap;

use codex_analytics::CompactionImplementation;
use codex_analytics::CompactionPhase;
use codex_analytics::CompactionReason;
use codex_analytics::CompactionStrategy;
use codex_analytics::CompactionTrigger;
use codex_protocol::ThreadId;
use codex_protocol::protocol::InternalSessionSource;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::protocol::ThreadSource;
use codex_utils_string::to_ascii_json_string;
use http::HeaderMap as ApiHeaderMap;
use http::HeaderValue;
use serde::Serialize;
use serde_json::Value;

use crate::client::X_CODEX_INSTALLATION_ID_HEADER;
use crate::client::X_CODEX_PARENT_THREAD_ID_HEADER;
use crate::client::X_CODEX_TURN_METADATA_HEADER;
use crate::client::X_CODEX_WINDOW_ID_HEADER;
use crate::client::X_OPENAI_SUBAGENT_HEADER;

/// installation ID 的元数据键名。
pub(crate) const INSTALLATION_ID_KEY: &str = "installation_id";
/// session ID 的元数据键名。
pub(crate) const SESSION_ID_KEY: &str = "session_id";
/// thread ID 的元数据键名。
pub(crate) const THREAD_ID_KEY: &str = "thread_id";
/// turn ID 的元数据键名。
pub(crate) const TURN_ID_KEY: &str = "turn_id";
/// window ID 的元数据键名。
pub(crate) const WINDOW_ID_KEY: &str = "window_id";
/// 请求类型的元数据键名。
pub(crate) const REQUEST_KIND_KEY: &str = "request_kind";
/// 压缩信息的元数据键名。
pub(crate) const COMPACTION_KEY: &str = "compaction";
/// turn 开始时间（Unix 毫秒）的元数据键名。
pub(crate) const TURN_STARTED_AT_UNIX_MS_KEY: &str = "turn_started_at_unix_ms";

/// fork 来源 thread ID 的元数据键名。
pub(crate) const FORKED_FROM_THREAD_ID_KEY: &str = "forked_from_thread_id";
/// 父 thread ID 的元数据键名。
pub(crate) const PARENT_THREAD_ID_KEY: &str = "parent_thread_id";
/// subagent 类型的元数据键名。
pub(crate) const SUBAGENT_KIND_KEY: &str = "subagent_kind";
/// thread 来源的元数据键名。
pub(crate) const THREAD_SOURCE_KEY: &str = "thread_source";
/// 沙箱信息的元数据键名。
pub(crate) const SANDBOX_KEY: &str = "sandbox";
/// 工作区信息的元数据键名。
pub(crate) const WORKSPACES_KEY: &str = "workspaces";

// App-server 客户端可以在提交 turn 时通过 `responsesapi_client_metadata` 参数指定额外元数据，
// 但不得覆盖由 core 拥有的字段。
const RESERVED_METADATA_KEYS: &[&str] = &[
    INSTALLATION_ID_KEY,
    X_CODEX_INSTALLATION_ID_HEADER,
    SESSION_ID_KEY,
    THREAD_ID_KEY,
    TURN_ID_KEY,
    WINDOW_ID_KEY,
    X_CODEX_WINDOW_ID_HEADER,
    X_CODEX_TURN_METADATA_HEADER,
    X_CODEX_PARENT_THREAD_ID_HEADER,
    X_OPENAI_SUBAGENT_HEADER,
    REQUEST_KIND_KEY,
    COMPACTION_KEY,
    TURN_STARTED_AT_UNIX_MS_KEY,
    FORKED_FROM_THREAD_ID_KEY,
    PARENT_THREAD_ID_KEY,
    SUBAGENT_KIND_KEY,
    THREAD_SOURCE_KEY,
    SANDBOX_KEY,
    WORKSPACES_KEY,
];

/// 附加到模型请求上的元数据，用于描述对话压缩操作。
///
/// 涵盖通过常规 `/responses` 路径发送的本地压缩请求和通过 `/responses/compact` 发送的远程
/// 压缩请求。这些字段描述的是派发时的操作信息；响应后的结果（状态、错误、时长、token 增量）
/// 保留在压缩 analytics 事件中。
#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct CompactionTurnMetadata {
    trigger: CompactionTrigger,
    reason: CompactionReason,
    implementation: CompactionImplementation,
    phase: CompactionPhase,
    strategy: CompactionStrategy,
}

impl CompactionTurnMetadata {
    /// 创建新的压缩 turn 元数据，strategy 默认为 `Memento`。
    pub(crate) fn new(
        trigger: CompactionTrigger,
        reason: CompactionReason,
        implementation: CompactionImplementation,
        phase: CompactionPhase,
    ) -> Self {
        Self {
            trigger,
            reason,
            implementation,
            phase,
            strategy: CompactionStrategy::Memento,
        }
    }
}

/// Responses API 请求的类型分类。
#[derive(Clone, Copy, Debug)]
pub(crate) enum CodexResponsesRequestKind {
    /// 普通 turn 请求。
    Turn,
    /// 预热（prewarm）请求。
    Prewarm,
    /// 压缩请求，携带压缩元数据。
    Compaction(CompactionTurnMetadata),
    /// 记忆整合（memory consolidation）请求。
    Memory,
}

impl CodexResponsesRequestKind {
    fn metadata(self) -> (&'static str, Option<CompactionTurnMetadata>) {
        match self {
            CodexResponsesRequestKind::Turn => ("turn", None),
            CodexResponsesRequestKind::Prewarm => ("prewarm", None),
            CodexResponsesRequestKind::Compaction(metadata) => ("compaction", Some(metadata)),
            CodexResponsesRequestKind::Memory => ("memory", None),
        }
    }

    fn has_turn_identity(self) -> bool {
        !matches!(self, CodexResponsesRequestKind::Memory)
    }
}

/// 单个工作区的元数据快照。
#[derive(Clone, Debug, Serialize, Default)]
pub(crate) struct TurnMetadataWorkspace {
    /// 该工作区关联的远程 URL 映射。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) associated_remote_urls: Option<BTreeMap<String, String>>,
    /// 最新的 git commit hash。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) latest_git_commit_hash: Option<String>,
    /// 是否有未提交的变更。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) has_changes: Option<bool>,
}

/// 调用方拥有的 Codex 元数据快照，发送给 Responses API。
///
/// 完整的 Codex turn 元数据 blob 以 `client_metadata["x-codex-turn-metadata"]` 作为
/// 权威传输方式。扁平的 `client_metadata` 键和直接的 HTTP/ws header 都是基于此快照
/// 生成的兼容投影，而非独立的真值来源。
#[derive(Clone, Debug)]
pub struct CodexResponsesMetadata {
    pub(crate) installation_id: String,
    pub(crate) session_id: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: Option<String>,
    pub(crate) window_id: String,
    pub(crate) request_kind: Option<CodexResponsesRequestKind>,
    pub(crate) forked_from_thread_id: Option<ThreadId>,
    pub(crate) parent_thread_id: Option<ThreadId>,
    pub(crate) subagent_header: Option<String>,
    pub(crate) subagent_kind: Option<String>,
    pub(crate) thread_source: Option<ThreadSource>,
    pub(crate) sandbox: Option<String>,
    pub(crate) workspaces: BTreeMap<String, TurnMetadataWorkspace>,
    pub(crate) turn_started_at_unix_ms: Option<i64>,
    pub(crate) extra: BTreeMap<String, String>,
}

impl CodexResponsesMetadata {
    pub(crate) fn new(
        installation_id: String,
        session_id: String,
        thread_id: String,
        window_id: String,
    ) -> Self {
        Self {
            installation_id,
            session_id,
            thread_id,
            turn_id: None,
            window_id,
            request_kind: None,
            forked_from_thread_id: None,
            parent_thread_id: None,
            subagent_header: None,
            subagent_kind: None,
            thread_source: None,
            sandbox: None,
            workspaces: BTreeMap::new(),
            turn_started_at_unix_ms: None,
            extra: BTreeMap::new(),
        }
    }

    pub(crate) fn has_turn_metadata(&self) -> bool {
        self.request_kind.is_some()
    }

    pub(crate) fn turn_metadata_json(&self) -> Option<String> {
        to_ascii_json_string(&self.turn_metadata_payload()).ok()
    }

    pub(crate) fn turn_metadata_value(&self) -> Option<Value> {
        serde_json::to_value(self.turn_metadata_payload()).ok()
    }

    pub(crate) fn client_metadata(&self) -> HashMap<String, String> {
        let mut client_metadata = HashMap::from([
            (
                X_CODEX_INSTALLATION_ID_HEADER.to_string(),
                self.installation_id.clone(),
            ),
            (SESSION_ID_KEY.to_string(), self.session_id.clone()),
            (THREAD_ID_KEY.to_string(), self.thread_id.clone()),
            (X_CODEX_WINDOW_ID_HEADER.to_string(), self.window_id.clone()),
        ]);
        if let Some(turn_id) = &self.turn_id {
            client_metadata.insert(TURN_ID_KEY.to_string(), turn_id.clone());
        }
        if let Some(subagent_header) = &self.subagent_header {
            client_metadata.insert(
                X_OPENAI_SUBAGENT_HEADER.to_string(),
                subagent_header.clone(),
            );
        }
        if let Some(parent_thread_id) = self.parent_thread_id {
            client_metadata.insert(
                X_CODEX_PARENT_THREAD_ID_HEADER.to_string(),
                parent_thread_id.to_string(),
            );
        }
        if self.has_turn_metadata()
            && let Some(turn_metadata_json) = self.turn_metadata_json()
        {
            client_metadata.insert(X_CODEX_TURN_METADATA_HEADER.to_string(), turn_metadata_json);
        }
        client_metadata
    }

    /// 生成兼容的 HTTP header 投影。
    ///
    /// 直接的 `x-codex-turn-metadata` header 是兼容输出。新的请求级消费者应优先使用
    /// `client_metadata["x-codex-turn-metadata"]`，后者由同一对象渲染生成。
    pub(crate) fn compatibility_headers(&self) -> ApiHeaderMap {
        let mut headers = ApiHeaderMap::new();
        insert_header(&mut headers, X_CODEX_WINDOW_ID_HEADER, &self.window_id);
        // 直接的 x-codex-turn-metadata 是兼容输出。新的请求级消费者应优先使用
        // client_metadata["x-codex-turn-metadata"]，后者由同一对象渲染生成。
        if self.has_turn_metadata()
            && let Some(turn_metadata_json) = self.turn_metadata_json()
        {
            insert_header(
                &mut headers,
                X_CODEX_TURN_METADATA_HEADER,
                &turn_metadata_json,
            );
        }
        if let Some(parent_thread_id) = self.parent_thread_id {
            insert_header(
                &mut headers,
                X_CODEX_PARENT_THREAD_ID_HEADER,
                &parent_thread_id.to_string(),
            );
        }
        if let Some(subagent_header) = &self.subagent_header {
            insert_header(&mut headers, X_OPENAI_SUBAGENT_HEADER, subagent_header);
        }
        headers
    }

    fn turn_metadata_payload(&self) -> CodexTurnMetadataPayload<'_> {
        let request_kind = self.request_kind;
        let (request_kind_value, compaction) = request_kind.map_or((None, None), |request_kind| {
            let (request_kind, compaction) = request_kind.metadata();
            (Some(request_kind), compaction)
        });
        let has_turn_identity =
            request_kind.is_none_or(CodexResponsesRequestKind::has_turn_identity);
        let has_request_identity =
            request_kind.is_some_and(CodexResponsesRequestKind::has_turn_identity);
        CodexTurnMetadataPayload {
            installation_id: has_request_identity.then_some(self.installation_id.as_str()),
            session_id: has_turn_identity.then_some(self.session_id.as_str()),
            thread_id: has_turn_identity.then_some(self.thread_id.as_str()),
            turn_id: has_turn_identity
                .then_some(self.turn_id.as_deref())
                .flatten(),
            window_id: has_request_identity.then_some(self.window_id.as_str()),
            request_kind: request_kind_value,
            forked_from_thread_id: self.forked_from_thread_id,
            parent_thread_id: self.parent_thread_id,
            subagent_kind: self.subagent_kind.as_deref(),
            thread_source: self.thread_source.as_ref(),
            sandbox: self.sandbox.as_deref(),
            workspaces: non_empty_workspaces(&self.workspaces),
            turn_started_at_unix_ms: self.turn_started_at_unix_ms,
            compaction,
            // responsesapi_client_metadata 丰富了 Codex turn 元数据 blob，
            // 而非字面意义上的顶层 Responses client_metadata。
            // 当这些额外字段进入 turn 状态时，会过滤掉 Codex 拥有的保留键。
            extra: &self.extra,
        }
    }
}

/// 根据 session source 计算 subagent header 值。
///
/// 返回 `None` 表示非 subagent 会话（CLI/VSCode/Exec/Mcp 等）。
pub(crate) fn subagent_header_value(session_source: &SessionSource) -> Option<String> {
    match session_source {
        SessionSource::SubAgent(subagent_source) => match subagent_source {
            SubAgentSource::Review => Some("review".to_string()),
            SubAgentSource::Compact => Some("compact".to_string()),
            SubAgentSource::MemoryConsolidation => Some("memory_consolidation".to_string()),
            SubAgentSource::ThreadSpawn { .. } => Some("collab_spawn".to_string()),
            SubAgentSource::Other(label) => Some(label.clone()),
        },
        SessionSource::Internal(InternalSessionSource::MemoryConsolidation) => {
            Some("memory_consolidation".to_string())
        }
        SessionSource::Cli
        | SessionSource::VSCode
        | SessionSource::Exec
        | SessionSource::Mcp
        | SessionSource::Custom(_)
        | SessionSource::Unknown => None,
    }
}

/// 根据 session source 计算 subagent metadata kind 值。
///
/// 仅 subagent 会话返回 `Some`，其他来源返回 `None`。
pub(crate) fn subagent_metadata_kind(session_source: &SessionSource) -> Option<String> {
    match session_source {
        SessionSource::SubAgent(subagent_source) => Some(subagent_source.kind().to_string()),
        SessionSource::Cli
        | SessionSource::VSCode
        | SessionSource::Exec
        | SessionSource::Mcp
        | SessionSource::Custom(_)
        | SessionSource::Internal(_)
        | SessionSource::Unknown => None,
    }
}

fn insert_header(headers: &mut ApiHeaderMap, name: &'static str, value: &str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        headers.insert(name, header_value);
    }
}

/// 过滤额外元数据，移除 Codex 保留的键。
pub(crate) fn filter_extra_metadata(extra: HashMap<String, String>) -> BTreeMap<String, String> {
    extra
        .into_iter()
        .filter(|(key, _)| !RESERVED_METADATA_KEYS.contains(&key.as_str()))
        .collect()
}

fn non_empty_workspaces(
    workspaces: &BTreeMap<String, TurnMetadataWorkspace>,
) -> Option<&BTreeMap<String, TurnMetadataWorkspace>> {
    (!workspaces.is_empty()).then_some(workspaces)
}

#[derive(Serialize)]
struct CodexTurnMetadataPayload<'a> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation_id: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_id: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_kind: Option<&'static str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    forked_from_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subagent_kind: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_source: Option<&'a ThreadSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sandbox: Option<&'a str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspaces: Option<&'a BTreeMap<String, TurnMetadataWorkspace>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_started_at_unix_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compaction: Option<CompactionTurnMetadata>,
    #[serde(flatten)]
    extra: &'a BTreeMap<String, String>,
}

use anyhow::Result;
use codex_protocol::SessionId;
use codex_protocol::ThreadId;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::GitInfo;
use codex_protocol::protocol::SessionMeta;
use codex_protocol::protocol::SessionMetaLine;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::TokenCountEvent;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::protocol::TokenUsageInfo;
use serde_json::json;
use std::fs;
use std::fs::FileTimes;
use std::path::Path;
use std::path::PathBuf;
use uuid::Uuid;

pub fn rollout_path(codex_home: &Path, filename_ts: &str, thread_id: &str) -> PathBuf {
    let year = &filename_ts[0..4];
    let month = &filename_ts[5..7];
    let day = &filename_ts[8..10];
    codex_home
        .join("sessions")
        .join(year)
        .join(month)
        .join(day)
        .join(format!("rollout-{filename_ts}-{thread_id}.jsonl"))
}

/// 在 `CODEX_HOME/sessions/YYYY/MM/DD/` 目录下创建一个最小化的 rollout 文件。
///
/// - `filename_ts`：文件名中的时间戳分量，格式为 `YYYY-MM-DDThh-mm-ss`。
/// - `meta_rfc3339`：写入 JSON 行内 envelope 的 RFC3339 时间戳。
/// - `preview`：用户消息的预览文本。
/// - `model_provider`：可选参数，用于设置 session meta payload 中的 provider 字段。
///
/// 返回值为生成的 conversation/session UUID 字符串，便于后续断言或继续操作。
pub fn create_fake_rollout(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
) -> Result<String> {
    create_fake_rollout_with_source(
        codex_home,
        filename_ts,
        meta_rfc3339,
        preview,
        model_provider,
        git_info,
        SessionSource::Cli,
    )
}

/// Creates a minimal rollout whose history includes a persisted token usage event.
///
/// Resume and fork tests use this fixture to verify lifecycle replay of restored
/// usage without starting a model turn. The exact token values are intentionally
/// non-zero and asymmetric so assertions catch swapped total/last fields and
/// dropped cached or reasoning counters.
pub fn create_fake_rollout_with_token_usage(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
) -> Result<String> {
    let thread_id = create_fake_rollout(
        codex_home,
        filename_ts,
        meta_rfc3339,
        preview,
        model_provider,
        /*git_info*/ None,
    )?;
    let payload = serde_json::to_value(EventMsg::TokenCount(TokenCountEvent {
        info: Some(TokenUsageInfo {
            total_token_usage: TokenUsage {
                input_tokens: 120,
                cached_input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 10,
                total_tokens: 150,
            },
            last_token_usage: TokenUsage {
                input_tokens: 70,
                cached_input_tokens: 10,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 90,
            },
            model_context_window: Some(200_000),
        }),
        rate_limits: None,
    }))?;
    let file_path = rollout_path(codex_home, filename_ts, &thread_id);
    let line = json!({
        "timestamp": meta_rfc3339,
        "type": "event_msg",
        "payload": payload
    })
    .to_string();
    fs::write(
        &file_path,
        format!("{}{}\n", fs::read_to_string(&file_path)?, line),
    )?;
    Ok(thread_id)
}

/// 创建一个最小化的 rollout 文件，并显式指定 session 来源（SessionSource）。
///
/// 与 `create_fake_rollout` 的区别：后者默认使用 `SessionSource::Cli`，
/// 本函数允许调用方传入 source 以覆盖 app-server 等其他来源的 rollout 重建场景。
pub fn create_fake_rollout_with_source(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
    source: SessionSource,
) -> Result<String> {
    create_fake_rollout_with_source_and_parent_thread_id(
        codex_home,
        filename_ts,
        meta_rfc3339,
        preview,
        model_provider,
        git_info,
        source,
        /*session_id*/ None,
        /*parent_thread_id*/ None,
    )
}

/// 创建一个最小化的 rollout 文件，并显式指定 root session 与 control parent。
///
/// 用于 thread fork 等需要重建父-子会话拓扑的测试场景，
/// 保证 rollout 历史中的 parent 关系可被 thread resume/fork 流程正确解析。
#[allow(clippy::too_many_arguments)]
pub fn create_fake_parented_rollout_with_source(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
    source: SessionSource,
    session_id: SessionId,
    parent_thread_id: ThreadId,
) -> Result<String> {
    create_fake_rollout_with_source_and_parent_thread_id(
        codex_home,
        filename_ts,
        meta_rfc3339,
        preview,
        model_provider,
        git_info,
        source,
        Some(session_id),
        Some(parent_thread_id),
    )
}

#[allow(clippy::too_many_arguments)]
fn create_fake_rollout_with_source_and_parent_thread_id(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
    source: SessionSource,
    session_id: Option<SessionId>,
    parent_thread_id: Option<ThreadId>,
) -> Result<String> {
    let uuid = Uuid::new_v4();
    let uuid_str = uuid.to_string();
    let conversation_id = ThreadId::from_string(&uuid_str)?;
    let session_id = session_id.unwrap_or_else(|| conversation_id.into());

    let file_path = rollout_path(codex_home, filename_ts, &uuid_str);
    let dir = file_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing rollout parent directory"))?;
    fs::create_dir_all(dir)?;

    // Build JSONL lines
    let meta = SessionMeta {
        session_id,
        id: conversation_id,
        forked_from_id: None,
        parent_thread_id,
        timestamp: meta_rfc3339.to_string(),
        cwd: PathBuf::from("/"),
        originator: "codex".to_string(),
        cli_version: "0.0.0".to_string(),
        source,
        thread_source: None,
        agent_path: None,
        agent_nickname: None,
        agent_role: None,
        model_provider: model_provider.map(str::to_string),
        base_instructions: None,
        dynamic_tools: None,
        selected_capability_roots: Vec::new(),
        memory_mode: None,
        history_mode: Default::default(),
        multi_agent_version: None,
        context_window: None,
    };
    let payload = serde_json::to_value(SessionMetaLine {
        meta,
        git: git_info,
    })?;

    let lines = [
        json!({
            "timestamp": meta_rfc3339,
            "type": "session_meta",
            "payload": payload
        })
        .to_string(),
        json!({
            "timestamp": meta_rfc3339,
            "type":"response_item",
            "payload": {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text": preview}]
            }
        })
        .to_string(),
        json!({
            "timestamp": meta_rfc3339,
            "type":"event_msg",
            "payload": {
                "type":"user_message",
                "message": preview,
                "kind": "plain"
            }
        })
        .to_string(),
    ];

    fs::write(&file_path, lines.join("\n") + "\n")?;
    let parsed = chrono::DateTime::parse_from_rfc3339(meta_rfc3339)?.with_timezone(&chrono::Utc);
    let times = FileTimes::new().set_modified(parsed.into());
    std::fs::OpenOptions::new()
        .append(true)
        .open(&file_path)?
        .set_times(times)?;
    Ok(uuid_str)
}

pub fn create_fake_rollout_with_text_elements(
    codex_home: &Path,
    filename_ts: &str,
    meta_rfc3339: &str,
    preview: &str,
    text_elements: Vec<serde_json::Value>,
    model_provider: Option<&str>,
    git_info: Option<GitInfo>,
) -> Result<String> {
    let uuid = Uuid::new_v4();
    let uuid_str = uuid.to_string();
    let conversation_id = ThreadId::from_string(&uuid_str)?;

    // sessions/YYYY/MM/DD derived from filename_ts (YYYY-MM-DDThh-mm-ss)
    let year = &filename_ts[0..4];
    let month = &filename_ts[5..7];
    let day = &filename_ts[8..10];
    let dir = codex_home.join("sessions").join(year).join(month).join(day);
    fs::create_dir_all(&dir)?;

    let file_path = dir.join(format!("rollout-{filename_ts}-{uuid}.jsonl"));

    // Build JSONL lines
    let meta = SessionMeta {
        session_id: conversation_id.into(),
        id: conversation_id,
        forked_from_id: None,
        parent_thread_id: None,
        timestamp: meta_rfc3339.to_string(),
        cwd: PathBuf::from("/"),
        originator: "codex".to_string(),
        cli_version: "0.0.0".to_string(),
        source: SessionSource::Cli,
        thread_source: None,
        agent_path: None,
        agent_nickname: None,
        agent_role: None,
        model_provider: model_provider.map(str::to_string),
        base_instructions: None,
        dynamic_tools: None,
        selected_capability_roots: Vec::new(),
        memory_mode: None,
        history_mode: Default::default(),
        multi_agent_version: None,
        context_window: None,
    };
    let payload = serde_json::to_value(SessionMetaLine {
        meta,
        git: git_info,
    })?;

    let lines = [
        json!( {
            "timestamp": meta_rfc3339,
            "type": "session_meta",
            "payload": payload
        })
        .to_string(),
        json!( {
            "timestamp": meta_rfc3339,
            "type":"response_item",
            "payload": {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text": preview}]
            }
        })
        .to_string(),
        json!( {
            "timestamp": meta_rfc3339,
            "type":"event_msg",
            "payload": {
                "type":"user_message",
                "message": preview,
                "text_elements": text_elements,
                "local_images": []
            }
        })
        .to_string(),
    ];

    fs::write(file_path, lines.join("\n") + "\n")?;
    Ok(uuid_str)
}

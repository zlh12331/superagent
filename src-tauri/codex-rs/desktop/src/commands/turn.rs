//! Turn 域 Tauri 命令。
//!
//! 提供会话轮次（turn）的交互能力：启动轮次、转向（steer）、中断。
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
//! codex-rs 的 Response 类型包含大量复杂嵌套类型，镜像这些类型到
//! specta 类型工作量巨大且容易过时。因此命令返回序列化后的 JSON
//! 字符串（`String`），前端调用后 `JSON.parse()` 即可得到结构化数据。

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

/// `turn/start` 命令的参数。
///
/// 对应 codex-rs 的 `v2::TurnStartParams`，但只暴露桌面端常用的字段。
/// `input` 为 `Vec<UserInput>` 的 JSON 字符串，由前端序列化后传入，
/// 命令内部用 `serde_json::from_str` 解析为 `serde_json::Value`。
///
/// 使用 `String` 而非 `serde_json::Value` 的原因：specta 不支持递归类型
/// `serde_json::Value`（其 `Number` 变体包含 `i64/u64`，触发 BigInt 禁令）。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartArgs {
    /// 要启动轮次的线程 ID（必填）。
    pub thread_id: String,
    /// 用户输入内容，是 `Vec<UserInput>` 的 JSON 字符串（前端 `JSON.stringify` 后传入）。
    pub input: String,
    /// 覆盖本轮使用的模型名称。为空时使用线程默认模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 覆盖本轮的工作目录。为空时使用线程默认工作目录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// `turn/steer` 命令的参数。
///
/// 在当前轮次进行中追加用户输入（转向），需要指定当前活跃的 turn ID
/// 作为前置条件，如果不匹配则请求失败。
///
/// `input` 同 `TurnStartArgs.input`，为 JSON 字符串。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerArgs {
    /// 要转向的线程 ID（必填）。
    pub thread_id: String,
    /// 用户输入内容，是 `Vec<UserInput>` 的 JSON 字符串（前端 `JSON.stringify` 后传入）。
    pub input: String,
    /// 预期的当前活跃 turn ID（必填）。不匹配时请求失败。
    pub expected_turn_id: String,
}

/// `turn/interrupt` 命令的参数。
///
/// 中断指定线程的当前轮次。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptArgs {
    /// 要中断的线程 ID（必填）。
    pub thread_id: String,
    /// 要中断的轮次 ID（必填）。
    pub turn_id: String,
}

// =============================================================================
// 命令实现
// =============================================================================

/// 启动新的会话轮次。
///
/// 调用 codex-rs 的 `turn/start` 方法，在指定线程上开始一轮新的对话。
/// 前端通过 `input` 传入用户消息（文本、图片等）。
///
/// # 参数
///
/// - `args` — 轮次启动参数（线程 ID、输入、模型、工作目录）
///
/// # 返回
///
/// 返回 `turn/start` 的 JSON 字符串，包含 `turn` 对象。
///
/// # 错误
///
/// - [`AppError::Validation`] — `thread_id` 为空
/// - [`AppError::NotInitialized`] — codex 运行时未初始化
/// - [`AppError::TypedRequestError`] — 请求失败
#[tauri::command]
#[specta::specta]
pub async fn turn_start(args: TurnStartArgs) -> Result<String, AppError> {
    // 1. 获取全局 sender
    let sender = state::handle()?;

    // 2. 参数验证
    if args.thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }

    // 3. 解析 input JSON 字符串为 serde_json::Value
    //    前端传入 JSON.stringify 后的字符串，这里解析为 Value 传给 codex-rs。
    //    使用 String 而非 serde_json::Value 是为了规避 specta BigInt 禁令。
    let input_value: serde_json::Value = serde_json::from_str(&args.input)
        .map_err(|e| AppError::validation(format!("invalid input JSON: {e}")))?;

    // 4. 构造 codex-rs 的 TurnStartParams
    //    使用 serde_json::Value 构造，因为 TurnStartParams 包含大量
    //    实验性字段，直接构造会非常冗长。
    let params = serde_json::json!({
        "threadId": args.thread_id,
        "input": input_value,
        "model": args.model,
        "cwd": args.cwd,
    });

    // 4. 构造 ClientRequest
    let request = ClientRequest::TurnStart {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct TurnStartParams: {e}"))
        })?,
    };

    // 5. 发送请求并将响应序列化为 JSON 字符串
    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 在当前轮次中追加用户输入（转向）。
///
/// 调用 codex-rs 的 `turn/steer` 方法，在正在进行的轮次中注入新的
/// 用户输入。`expected_turn_id` 必须与当前活跃的 turn ID 匹配。
///
/// # 参数
///
/// - `args` — 转向参数（线程 ID、输入、预期 turn ID）
///
/// # 返回
///
/// 返回 `turn/steer` 的 JSON 字符串，包含 `turnId` 字段。
///
/// # 错误
///
/// - [`AppError::Validation`] — `thread_id` 或 `expected_turn_id` 为空
#[tauri::command]
#[specta::specta]
pub async fn turn_steer(args: TurnSteerArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // 参数验证
    if args.thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }
    if args.expected_turn_id.trim().is_empty() {
        return Err(AppError::validation("expected_turn_id cannot be empty"));
    }

    // 解析 input JSON 字符串为 serde_json::Value
    let input_value: serde_json::Value = serde_json::from_str(&args.input)
        .map_err(|e| AppError::validation(format!("invalid input JSON: {e}")))?;

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "input": input_value,
        "expectedTurnId": args.expected_turn_id,
    });

    let request = ClientRequest::TurnSteer {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct TurnSteerParams: {e}"))
        })?,
    };

    let response = send_request(&sender, request)
        .await
        .map_err(AppError::from)?;
    serde_json::to_string(&response)
        .map_err(|e| AppError::serialization(format!("failed to serialize response: {e}")))
}

/// 中断指定线程的当前轮次。
///
/// 调用 codex-rs 的 `turn/interrupt` 方法，停止正在进行的轮次。
///
/// # 参数
///
/// - `args` — 中断参数（线程 ID、轮次 ID）
///
/// # 返回
///
/// 返回 `turn/interrupt` 的 JSON 字符串。
///
/// # 错误
///
/// - [`AppError::Validation`] — `thread_id` 或 `turn_id` 为空
#[tauri::command]
#[specta::specta]
pub async fn turn_interrupt(args: TurnInterruptArgs) -> Result<String, AppError> {
    let sender = state::handle()?;

    // 参数验证
    if args.thread_id.trim().is_empty() {
        return Err(AppError::validation("thread_id cannot be empty"));
    }
    if args.turn_id.trim().is_empty() {
        return Err(AppError::validation("turn_id cannot be empty"));
    }

    let params = serde_json::json!({
        "threadId": args.thread_id,
        "turnId": args.turn_id,
    });

    let request = ClientRequest::TurnInterrupt {
        request_id: state::sequencer().next_id(),
        params: serde_json::from_value(params).map_err(|e| {
            AppError::validation(format!("failed to construct TurnInterruptParams: {e}"))
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
    fn turn_start_args_serializes_correctly() {
        let args = TurnStartArgs {
            thread_id: "thread-001".to_string(),
            input: r#"[{"type":"text","text":"hello"}]"#.to_string(),
            model: Some("gpt-4o".to_string()),
            cwd: Some("/home/user".to_string()),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["threadId"], "thread-001");
        assert_eq!(json["model"], "gpt-4o");
        assert_eq!(json["cwd"], "/home/user");
    }

    #[test]
    fn turn_start_args_omits_optional_fields() {
        let args = TurnStartArgs {
            thread_id: "thread-001".to_string(),
            input: "[]".to_string(),
            model: None,
            cwd: None,
        };
        let json = serde_json::to_string(&args).unwrap();
        assert!(!json.contains("model"));
        assert!(!json.contains("cwd"));
    }

    #[test]
    fn turn_steer_args_serializes_correctly() {
        let args = TurnSteerArgs {
            thread_id: "thread-002".to_string(),
            input: r#"[{"type":"text","text":"steer"}]"#.to_string(),
            expected_turn_id: "turn-abc".to_string(),
        };
        let json = serde_json::to_value(&args).unwrap();
        assert_eq!(json["threadId"], "thread-002");
        assert_eq!(json["expectedTurnId"], "turn-abc");
    }

    #[test]
    fn turn_interrupt_args_deserializes_from_camel_case() {
        let json = serde_json::json!({
            "threadId": "thread-003",
            "turnId": "turn-xyz"
        });
        let args: TurnInterruptArgs = serde_json::from_value(json).unwrap();
        assert_eq!(args.thread_id, "thread-003");
        assert_eq!(args.turn_id, "turn-xyz");
    }

    #[test]
    fn sequencer_produces_unique_ids_across_calls() {
        let seq = RequestIdSequencer::new();
        let id1 = seq.next_id();
        let id2 = seq.next_id();
        assert_ne!(id1, id2);
    }
}

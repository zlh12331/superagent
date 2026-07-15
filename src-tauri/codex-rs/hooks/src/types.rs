//! Hook 系统的基础类型定义。
//!
//! 这里定义了内置 hook 的函数签名、执行结果、负载与事件枚举，
//! 用于 [`registry::Hooks`](crate::registry::Hooks) 等模块共享。

use std::sync::Arc;

use chrono::DateTime;
use chrono::SecondsFormat;
use chrono::Utc;
use codex_protocol::ThreadId;
use codex_utils_absolute_path::AbsolutePathBuf;
use futures::future::BoxFuture;
use serde::Serialize;
use serde::Serializer;

/// Hook 执行函数的类型别名。
///
/// 接收一个 [`HookPayload`] 引用，返回一个异步 [`HookResult`]。
/// 需要满足 `Send + Sync`，可在多线程上下文中共享。
pub type HookFn = Arc<dyn for<'a> Fn(&'a HookPayload) -> BoxFuture<'a, HookResult> + Send + Sync>;

/// Hook 执行结果。
#[derive(Debug)]
pub enum HookResult {
    /// 成功：hook 正常完成。
    Success,
    /// 失败但继续：hook 失败，但后续 hook 仍会执行，操作继续。
    FailedContinue(Box<dyn std::error::Error + Send + Sync + 'static>),
    /// 失败并中止：hook 失败，后续 hook 不再执行，操作被中止。
    FailedAbort(Box<dyn std::error::Error + Send + Sync + 'static>),
}

impl HookResult {
    /// 判断该结果是否要求中止整个操作。
    pub fn should_abort_operation(&self) -> bool {
        matches!(self, Self::FailedAbort(_))
    }
}

/// 单个 hook 执行后的响应。
#[derive(Debug)]
pub struct HookResponse {
    /// 触发该响应的 hook 名称。
    pub hook_name: String,
    /// 执行结果。
    pub result: HookResult,
}

/// 一个可执行的内置 hook。
#[derive(Clone)]
pub struct Hook {
    /// hook 名称，用于响应归属。
    pub name: String,
    /// hook 执行函数。
    pub func: HookFn,
}

impl Default for Hook {
    fn default() -> Self {
        Self {
            name: "default".to_string(),
            func: Arc::new(|_| Box::pin(async { HookResult::Success })),
        }
    }
}

impl Hook {
    /// 执行当前 hook，返回对应的 [`HookResponse`]。
    pub async fn execute(&self, payload: &HookPayload) -> HookResponse {
        HookResponse {
            hook_name: self.name.clone(),
            result: (self.func)(payload).await,
        }
    }
}

/// 触发 hook 时携带的负载信息。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct HookPayload {
    /// 当前会话 ID。
    pub session_id: ThreadId,
    /// 当前工作目录。
    pub cwd: AbsolutePathBuf,
    /// 可选的客户端标识。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// 触发时间（UTC）。
    #[serde(serialize_with = "serialize_triggered_at")]
    pub triggered_at: DateTime<Utc>,
    /// 触发该负载的具体事件。
    pub hook_event: HookEvent,
}

/// `AfterAgent` 事件的负载字段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HookEventAfterAgent {
    /// 触发该事件的 thread ID。
    pub thread_id: ThreadId,
    /// 当前 turn ID。
    pub turn_id: String,
    /// 用户输入的消息列表。
    pub input_messages: Vec<String>,
    /// 最近一条 assistant 消息内容（如有）。
    pub last_assistant_message: Option<String>,
}

/// 将 UTC 时间序列化为 RFC3339 字符串（精度到秒）。
fn serialize_triggered_at<S>(value: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&value.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// 钩子事件枚举，使用 `event_type` 作为内部 tag。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum HookEvent {
    /// Agent 完成一轮对话后触发。
    AfterAgent {
        #[serde(flatten)]
        event: HookEventAfterAgent,
    },
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use chrono::Utc;
    use codex_protocol::ThreadId;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::HookEvent;
    use super::HookEventAfterAgent;
    use super::HookPayload;

    #[test]
    fn hook_payload_serializes_stable_wire_shape() {
        let session_id = ThreadId::new();
        let thread_id = ThreadId::new();
        let cwd = test_path_buf("/tmp").abs();
        let payload = HookPayload {
            session_id,
            cwd: cwd.clone(),
            client: None,
            triggered_at: Utc
                .with_ymd_and_hms(2025, 1, 1, 0, 0, 0)
                .single()
                .expect("valid timestamp"),
            hook_event: HookEvent::AfterAgent {
                event: HookEventAfterAgent {
                    thread_id,
                    turn_id: "turn-1".to_string(),
                    input_messages: vec!["hello".to_string()],
                    last_assistant_message: Some("hi".to_string()),
                },
            },
        };

        let actual = serde_json::to_value(payload).expect("serialize hook payload");
        let expected = json!({
            "session_id": session_id.to_string(),
            "cwd": cwd.display().to_string(),
            "triggered_at": "2025-01-01T00:00:00Z",
            "hook_event": {
                "event_type": "after_agent",
                "thread_id": thread_id.to_string(),
                "turn_id": "turn-1",
                "input_messages": ["hello"],
                "last_assistant_message": "hi",
            },
        });

        assert_eq!(actual, expected);
    }
}

//! 通过 ChatGPT 后端 `/wham/tasks/{task_id}` 接口拉取 task 详情。

use codex_core::config::Config;
use serde::Deserialize;

use crate::chatgpt_client::chatgpt_get_request;

/// `GET /wham/tasks/{task_id}` 的响应体。
#[derive(Debug, Deserialize)]
pub struct GetTaskResponse {
    /// 当前 diff task 对应的助手轮次（若存在）。
    pub current_diff_task_turn: Option<AssistantTurn>,
}

// 仅反序列化我们关心的字段。
#[derive(Debug, Deserialize)]
pub struct AssistantTurn {
    /// 该轮助手消息的输出项列表。
    pub output_items: Vec<OutputItem>,
}

/// 单条输出项，按 `type` 字段区分。
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum OutputItem {
    /// PR 类型的输出项。
    #[serde(rename = "pr")]
    Pr(PrOutputItem),

    /// 其他类型，统一忽略。
    #[serde(other)]
    Other,
}

/// PR 输出项的具体结构。
#[derive(Debug, Deserialize)]
pub struct PrOutputItem {
    /// PR 的输出 diff。
    pub output_diff: OutputDiff,
}

/// PR 输出 diff 的载体。
#[derive(Debug, Deserialize)]
pub struct OutputDiff {
    /// unified diff 文本。
    pub diff: String,
}

/// 拉取指定 task 的详情。
pub(crate) async fn get_task(config: &Config, task_id: String) -> anyhow::Result<GetTaskResponse> {
    let path = format!("/wham/tasks/{task_id}");
    chatgpt_get_request(config, path).await
}

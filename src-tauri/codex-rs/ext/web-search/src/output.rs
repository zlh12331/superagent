//! Web search 输出封装模块。
//!
//! 该模块定义了 `SearchOutput`，将 web 搜索的输出文本封装为 `ToolOutput` trait 实现，
//! 供工具调用结果回传使用。输出被标记为外部上下文（不参与模型推理缓存）。

use codex_extension_api::ToolOutput;
use codex_extension_api::ToolPayload;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseInputItem;

/// Web 搜索结果输出封装。
///
/// 将搜索输出文本包装为 `ToolOutput`，标记为外部上下文，
/// 并在转换为 response item 时生成纯文本 function call output。
pub(crate) struct SearchOutput {
    /// 搜索输出文本
    output: String,
}

impl SearchOutput {
    /// 创建一个新的搜索输出。
    pub(crate) fn new(output: String) -> Self {
        Self { output }
    }
}

impl ToolOutput for SearchOutput {
    /// 返回用于日志的预览文本（不暴露实际搜索内容）。
    fn log_preview(&self) -> String {
        "[standalone web search output]".to_string()
    }

    /// 标记为成功的日志记录。
    fn success_for_logging(&self) -> bool {
        true
    }

    /// 标记为外部上下文，不参与模型推理缓存。
    fn contains_external_context(&self) -> bool {
        true
    }

    /// 转换为 `ResponseInputItem::FunctionCallOutput`，以纯文本形式返回搜索结果。
    fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem {
        ResponseInputItem::FunctionCallOutput {
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload::from_content_items(vec![
                FunctionCallOutputContentItem::InputText {
                    text: self.output.clone(),
                },
            ]),
        }
    }
}

#[cfg(test)]
mod tests {
    use codex_extension_api::ToolPayload;
    use codex_protocol::models::FunctionCallOutputContentItem;
    use codex_protocol::models::FunctionCallOutputPayload;
    use codex_protocol::models::ResponseInputItem;
    use pretty_assertions::assert_eq;

    use super::SearchOutput;
    use super::ToolOutput;

    #[test]
    fn emits_plaintext_function_call_output() {
        let output = SearchOutput::new("search output".to_string());

        assert_eq!(
            output.to_response_item(
                "call-1",
                &ToolPayload::Function {
                    arguments: "{}".to_string(),
                },
            ),
            ResponseInputItem::FunctionCallOutput {
                call_id: "call-1".to_string(),
                output: FunctionCallOutputPayload::from_content_items(vec![
                    FunctionCallOutputContentItem::InputText {
                        text: "search output".to_string(),
                    },
                ]),
            }
        );
    }
}

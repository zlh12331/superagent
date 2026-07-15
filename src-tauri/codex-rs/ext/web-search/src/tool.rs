//! Web search 工具实现模块。
//!
//! 该模块定义了 `web.run` 工具的执行器 [`WebSearchTool`]，实现 [`ToolExecutor`] trait。
//! 工具负责：
//! - 解析模型传入的搜索命令（[`SearchCommands`]）
//! - 构建独立的搜索请求（含最近对话上下文）
//! - 调用搜索 API 并将结果封装为 [`SearchOutput`] 返回
//!
//! 工具命名空间为 `web`，工具名为 `run`，支持并行调用。
//! 工具描述从 `web_run_description.md` 内联文件读取。

use codex_api::ReqwestTransport;
use codex_api::SearchClient;
use codex_api::SearchCommands;
use codex_api::SearchQuery;
use codex_api::SearchRequest;
use codex_api::SearchSettings;
use codex_core::web_search_action_detail;
use codex_extension_api::ExtensionTurnItem;
use codex_extension_api::FunctionCallError;
use codex_extension_api::ResponsesApiTool;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolName;
use codex_extension_api::ToolOutput;
use codex_extension_api::ToolSpec;
use codex_extension_api::parse_tool_input_schema_without_compaction;
use codex_login::default_client::build_reqwest_client;
use codex_model_provider::SharedModelProvider;
use codex_protocol::items::WebSearchItem;
use codex_protocol::models::WebSearchAction;
use codex_tools::ResponsesApiNamespace;
use codex_tools::ResponsesApiNamespaceTool;
use codex_tools::ToolExposure;
use codex_tools::default_namespace_description;
use http::HeaderMap;
use url::Url;

use crate::history::recent_input;
use crate::output::SearchOutput;
use crate::schema::commands_schema;

/// 工具命名空间名称
pub(crate) const WEB_NAMESPACE: &str = "web";
/// 工具名称
pub(crate) const RUN_TOOL_NAME: &str = "run";
/// 工具描述文本，从外部 markdown 文件内联读取
const WEB_RUN_DESCRIPTION: &str = include_str!("../web_run_description.md");

/// Web 搜索工具执行器。
///
/// 持有当前 session id、共享 model provider 以及搜索设置，
/// 在每次工具调用时构建独立请求并调用搜索 API。
pub(crate) struct WebSearchTool {
    /// 当前 session 的 id，作为搜索请求的标识
    pub(crate) session_id: String,
    /// 共享的 model provider，用于获取 API 端点与认证信息
    pub(crate) provider: SharedModelProvider,
    /// 透传给搜索 API 的搜索设置
    pub(crate) settings: SearchSettings,
}

impl ToolExecutor<ToolCall> for WebSearchTool {
    /// 返回命名空间形式的工具名（`web.run`）。
    fn tool_name(&self) -> ToolName {
        ToolName::namespaced(WEB_NAMESPACE, RUN_TOOL_NAME)
    }

    /// 构造工具定义（spec）。
    ///
    /// 使用非紧凑方式解析 schema，保留字段元数据/描述以匹配 hosted tool 定义。
    /// 若 schema 解析失败则 panic，因为这是编程错误而非运行时错误。
    fn spec(&self) -> ToolSpec {
        // 不使用紧凑解析，保留字段元数据/描述以匹配 hosted tool 定义
        let parameters = match parse_tool_input_schema_without_compaction(&commands_schema()) {
            Ok(parameters) => parameters,
            Err(err) => panic!("search command schema should parse: {err}"),
        };

        ToolSpec::Namespace(ResponsesApiNamespace {
            name: WEB_NAMESPACE.to_string(),
            description: default_namespace_description(WEB_NAMESPACE),
            tools: vec![ResponsesApiNamespaceTool::Function(ResponsesApiTool {
                name: RUN_TOOL_NAME.to_string(),
                description: WEB_RUN_DESCRIPTION.to_string(),
                strict: false,
                parameters,
                output_schema: None,
                defer_loading: None,
            })],
        })
    }

    /// 工具暴露方式：直接暴露给模型。
    fn exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    /// 是否支持并行工具调用：支持。
    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    /// 处理工具调用，返回 future。
    fn handle(&self, call: ToolCall) -> codex_extension_api::ToolExecutorFuture<'_> {
        Box::pin(self.handle_call(call))
    }
}

impl WebSearchTool {
    /// 实际处理工具调用的异步方法。
    ///
    /// 流程：
    /// 1. 解析模型传入的搜索命令
    /// 2. 计算 command action（用于 UI 展示）
    /// 3. 从 provider 获取 API 端点与认证信息
    /// 4. 构建搜索请求（含最近对话上下文与设置）
    /// 5. 发送 started 事件，调用搜索 API，发送 completed 事件
    /// 6. 将响应输出封装为 [`SearchOutput`] 返回
    ///
    /// # 参数
    /// - `call`：模型发起的工具调用上下文
    ///
    /// # 返回
    /// 成功返回封装的搜索输出，失败返回 [`FunctionCallError`]。
    async fn handle_call(&self, call: ToolCall) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
        let commands = parse_commands(&call)?;
        let command_action = command_action(&commands);
        let provider = self
            .provider
            .api_provider()
            .await
            .map_err(|err| FunctionCallError::Fatal(err.to_string()))?;
        let auth = self
            .provider
            .api_auth()
            .await
            .map_err(|err| FunctionCallError::Fatal(err.to_string()))?;
        let client = SearchClient::new(
            ReqwestTransport::new(build_reqwest_client()),
            provider,
            auth,
        );
        let request = SearchRequest {
            id: self.session_id.clone(),
            model: call.model.clone(),
            reasoning: None,
            input: recent_input(call.conversation_history.items()),
            commands: Some(commands),
            settings: Some(self.settings.clone()),
            max_output_tokens: Some(
                u64::try_from(call.truncation_policy.token_budget()).unwrap_or(u64::MAX),
            ),
        };
        call.turn_item_emitter
            .emit_started(web_search_item(&call.call_id, WebSearchAction::Other))
            .await;
        let response = client
            .search(&request, HeaderMap::new())
            .await
            .map_err(|err| FunctionCallError::Fatal(err.to_string()))?;
        call.turn_item_emitter
            .emit_completed(web_search_item(&call.call_id, command_action))
            .await;

        Ok(Box::new(SearchOutput::new(response.output)))
    }
}

/// 从工具调用中解析搜索命令。
///
/// 空参数视为默认命令；解析失败返回可回传模型的错误。
///
/// # 参数
/// - `call`：工具调用上下文
///
/// # 返回
/// 成功返回 [`SearchCommands`]，参数解析失败返回 [`FunctionCallError::RespondToModel`]。
fn parse_commands(call: &ToolCall) -> Result<SearchCommands, FunctionCallError> {
    let arguments = call.function_arguments()?;
    if arguments.trim().is_empty() {
        return Ok(SearchCommands::default());
    }

    serde_json::from_str(arguments)
        .map_err(|err| FunctionCallError::RespondToModel(err.to_string()))
}

/// 根据搜索命令计算用于 UI 展示的 [`WebSearchAction`]。
///
/// 按优先级依次判断：
/// 1. `search_query`：搜索动作
/// 2. `image_query`：图片搜索动作
/// 3. `open`：打开页面动作（仅当 ref_id 是合法 URL 时）
/// 4. `find`：页面内查找动作
/// 5. 以上都不匹配时返回 [`WebSearchAction::Other`]
///
/// # 参数
/// - `commands`：解析后的搜索命令
fn command_action(commands: &SearchCommands) -> WebSearchAction {
    commands
        .search_query
        .as_deref()
        .and_then(query_action)
        .or_else(|| commands.image_query.as_deref().and_then(query_action))
        .or_else(|| {
            commands
                .open
                .as_deref()
                .and_then(|operations| operations.first())
                .and_then(|operation| {
                    literal_url(&operation.ref_id)
                        .map(|url| WebSearchAction::OpenPage { url: Some(url) })
                })
        })
        .or_else(|| {
            commands
                .find
                .as_deref()
                .and_then(|operations| operations.first())
                .map(|operation| WebSearchAction::FindInPage {
                    url: literal_url(&operation.ref_id),
                    pattern: Some(operation.pattern.clone()),
                })
        })
        .unwrap_or(WebSearchAction::Other)
}

/// 将查询列表转换为搜索动作。
///
/// - 空列表：返回 `None`
/// - 单个查询：返回单查询搜索动作
/// - 多个查询：返回多查询搜索动作
///
/// # 参数
/// - `queries`：搜索查询列表
fn query_action(queries: &[SearchQuery]) -> Option<WebSearchAction> {
    match queries {
        [] => None,
        [query] => Some(WebSearchAction::Search {
            query: Some(query.q.clone()),
            queries: None,
        }),
        queries => Some(WebSearchAction::Search {
            query: None,
            queries: Some(queries.iter().map(|query| query.q.clone()).collect()),
        }),
    }
}

/// 判断 ref_id 是否为合法 URL，若是则返回其字符串形式。
///
/// 用于区分 `open`/`find` 操作中的 ref_id 是真实 URL
/// 还是引用编号（如 `turn0search0`）。
///
/// # 参数
/// - `ref_id`：操作引用标识
fn literal_url(ref_id: &str) -> Option<String> {
    Url::parse(ref_id).is_ok().then(|| ref_id.to_string())
}

/// 构造一个 web 搜索 turn item。
///
/// 用于在工具调用 started/completed 时向 turn emitter 发送事件，
/// 供 UI 展示搜索动作详情。
///
/// # 参数
/// - `call_id`：工具调用 id
/// - `action`：搜索动作
fn web_search_item(call_id: &str, action: WebSearchAction) -> ExtensionTurnItem {
    ExtensionTurnItem::WebSearch(WebSearchItem {
        id: call_id.to_string(),
        query: web_search_action_detail(&action),
        action,
    })
}

#[cfg(test)]
mod tests {
    use codex_api::SearchCommands;
    use codex_protocol::models::WebSearchAction;
    use pretty_assertions::assert_eq;

    use super::command_action;

    #[test]
    fn command_action_reports_queries_and_navigation_detail() {
        let cases = [
            (
                r#"{"image_query":[{"q":"waterfalls"},{"q":"mountains"}]}"#,
                WebSearchAction::Search {
                    query: None,
                    queries: Some(vec!["waterfalls".to_string(), "mountains".to_string()]),
                },
            ),
            (
                r#"{"open":[{"ref_id":"https://example.com/docs"}]}"#,
                WebSearchAction::OpenPage {
                    url: Some("https://example.com/docs".to_string()),
                },
            ),
            (
                r#"{"find":[{"ref_id":"https://example.com/docs","pattern":"install"}]}"#,
                WebSearchAction::FindInPage {
                    url: Some("https://example.com/docs".to_string()),
                    pattern: Some("install".to_string()),
                },
            ),
            (
                r#"{"find":[{"ref_id":"turn0search0","pattern":"install"}]}"#,
                WebSearchAction::FindInPage {
                    url: None,
                    pattern: Some("install".to_string()),
                },
            ),
            (
                r#"{"open":[{"ref_id":"turn0search0"}]}"#,
                WebSearchAction::Other,
            ),
        ];

        for (arguments, expected) in cases {
            let commands: SearchCommands =
                serde_json::from_str(arguments).expect("valid search command arguments");
            assert_eq!(command_action(&commands), expected);
        }
    }
}

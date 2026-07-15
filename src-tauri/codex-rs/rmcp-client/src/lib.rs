//! MCP（Model Context Protocol）客户端封装模块。
//!
//! 该 crate 基于 `rmcp` 协议库提供 MCP 客户端的完整实现，包括：
//! - 认证状态判定与 OAuth 登录流程；
//! - 多种传输方式（in-process、stdio、HTTP）；
//! - elicitation（用户交互式确认）客户端服务；
//! - MCP server 启动器（stdio）与程序解析器；
//! - 客户端句柄 `RmcpClient` 与工具/连接器列表查询。
//!
//! 核心类型：[`RmcpClient`]、[`McpAuthState`]、[`InProcessTransportFactory`]、
//! [`StdioServerLauncher`]。

mod auth_status;
mod elicitation_client_service;
mod executor_process_transport;
mod http_client_adapter;
mod in_process_transport;
mod logging_client_handler;
mod oauth;
mod oauth_http_client;
mod perform_oauth_login;
mod program_resolver;
mod rmcp_client;
mod startup_error;
mod stdio_server_launcher;
mod utils;

/// MCP 认证状态：描述当前客户端的认证情况。
pub use auth_status::McpAuthState;
/// MCP 登录要求：描述是否需要登录及登录方式。
pub use auth_status::McpLoginRequirement;
/// Streamable HTTP 的 OAuth 发现结果。
pub use auth_status::StreamableHttpOAuthDiscovery;
/// 判定 streamable HTTP 端点的认证状态。
pub use auth_status::determine_streamable_http_auth_status;
/// 使用自定义 HTTP 客户端判定 streamable HTTP 端点的认证状态。
pub use auth_status::determine_streamable_http_auth_status_with_http_client;
/// 对 streamable HTTP 端点执行 OAuth 发现。
pub use auth_status::discover_streamable_http_oauth;
/// 使用自定义 HTTP 客户端对 streamable HTTP 端点执行 OAuth 发现。
pub use auth_status::discover_streamable_http_oauth_with_http_client;
/// 判断该端点是否支持 OAuth 登录。
pub use auth_status::supports_oauth_login;
/// MCP 认证状态协议类型（来自 `codex_protocol`）。
pub use codex_protocol::protocol::McpAuthStatus;
/// In-process 传输工厂：创建进程内 MCP 传输。
pub use in_process_transport::InProcessTransportFactory;
/// 已存储的 OAuth token 集合。
pub use oauth::StoredOAuthTokens;
/// 包装后的 OAuth token 响应。
pub use oauth::WrappedOAuthTokenResponse;
/// 删除已存储的 OAuth token。
pub use oauth::delete_oauth_tokens;
/// 加载已存储的 OAuth token（crate 内部使用）。
pub(crate) use oauth::load_oauth_tokens;
/// 保存 OAuth token。
pub use oauth::save_oauth_tokens;
/// OAuth provider 相关错误类型。
pub use perform_oauth_login::OAuthProviderError;
/// OAuth 登录句柄：管理登录流程的生命周期。
pub use perform_oauth_login::OauthLoginHandle;
/// 执行 OAuth 登录流程。
pub use perform_oauth_login::perform_oauth_login;
/// 执行 OAuth 登录并返回重定向 URL。
pub use perform_oauth_login::perform_oauth_login_return_url;
/// 使用自定义 HTTP 客户端执行 OAuth 登录并返回重定向 URL。
pub use perform_oauth_login::perform_oauth_login_return_url_with_http_client;
/// 静默执行 OAuth 登录（无用户交互）。
pub use perform_oauth_login::perform_oauth_login_silent;
/// Elicitation 动作类型（来自 `rmcp`）。
pub use rmcp::model::ElicitationAction;
/// Elicitation 请求抽象。
pub use rmcp_client::Elicitation;
/// Elicitation 响应抽象。
pub use rmcp_client::ElicitationResponse;
/// 列举工具（带 connector ID）的结果。
pub use rmcp_client::ListToolsWithConnectorIdResult;
/// MCP 客户端句柄：封装与 MCP server 的交互。
pub use rmcp_client::RmcpClient;
/// 发送 elicitation 请求的抽象。
pub use rmcp_client::SendElicitation;
/// 带 connector ID 的工具描述。
pub use rmcp_client::ToolWithConnectorId;
/// 判断给定错误是否为"需要认证"错误。
pub use startup_error::is_authentication_required_error;
/// 基于执行器的 stdio server 启动器。
pub use stdio_server_launcher::ExecutorStdioServerLauncher;
/// 本地 stdio server 启动器。
pub use stdio_server_launcher::LocalStdioServerLauncher;
/// stdio server 启动器抽象 trait。
pub use stdio_server_launcher::StdioServerLauncher;

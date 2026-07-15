//! Codex HTTP 客户端核心库。
//!
//! 本 crate 提供与 Codex 后端通信所需的 HTTP 客户端能力，包括：
//! - 自定义 CA / 系统证书构建的 reqwest 客户端
//! - 路由感知的出站代理（outbound proxy）
//! - 请求/响应抽象（含 JSON 序列化与 zstd 压缩）
//! - 重试策略与指数退避
//! - SSE（Server-Sent Events）流式解析
//! - 请求遥测（telemetry）

mod chatgpt_cloudflare_cookies;
mod chatgpt_hosts;
mod custom_ca;
mod default_client;
mod error;
mod outbound_proxy;
mod request;
mod retry;
mod sse;
mod telemetry;
mod transport;

/// 为 reqwest client 注入 ChatGPT Cloudflare cookie 存储的辅助函数。
pub use crate::chatgpt_cloudflare_cookies::with_chatgpt_cloudflare_cookie_store;
/// 判断给定主机名是否属于允许的 ChatGPT 域。
pub use crate::chatgpt_hosts::is_allowed_chatgpt_host;
/// 构建自定义 CA transport 时可能发生的错误。
pub use crate::custom_ca::BuildCustomCaTransportError;
/// 仅测试用：用于 custom CA 覆盖率测试的子进程入口辅助函数。
///
/// 该项保持 pub 仅为了让 `custom_ca_probe` 二进制目标能复用共享辅助代码；
/// 在普通文档中隐藏，因为外部调用方应使用
/// [`build_reqwest_client_with_custom_ca`] 替代。
#[doc(hidden)]
pub use crate::custom_ca::build_reqwest_client_for_subprocess_tests;
/// 构建一个使用自定义 CA 证书的 reqwest client。
pub use crate::custom_ca::build_reqwest_client_with_custom_ca;
/// 尝试使用自定义 CA 构建一个 rustls client 配置（若可用）。
pub use crate::custom_ca::maybe_build_rustls_client_config_with_custom_ca;
/// Codex 默认的 HTTP 客户端句柄。
pub use crate::default_client::CodexHttpClient;
/// Codex 请求构造器，封装常用请求构建逻辑。
pub use crate::default_client::CodexRequestBuilder;
/// 流式响应在读取过程中发生的错误。
pub use crate::error::StreamError;
/// 传输层错误（HTTP 状态、网络、超时等）。
pub use crate::error::TransportError;
/// 构建路由感知 HTTP 客户端时可能发生的错误。
pub use crate::outbound_proxy::BuildRouteAwareHttpClientError;
/// 客户端路由分类标签，用于区分不同流量类型。
pub use crate::outbound_proxy::ClientRouteClass;
/// 出站代理配置。
pub use crate::outbound_proxy::OutboundProxyConfig;
/// 路由失败分类标签，用于错误上报。
pub use crate::outbound_proxy::RouteFailureClass;
/// 按路由构建对应的 reqwest 客户端。
pub use crate::outbound_proxy::build_reqwest_client_for_route;
/// 已序列化、可复用的 JSON 请求体。
pub use crate::request::EncodedJsonBody;
/// 已准备好的请求体（含最终 headers 与字节流）。
pub use crate::request::PreparedRequestBody;
/// 平台无关的 HTTP 请求抽象。
pub use crate::request::Request;
/// 请求体枚举（JSON / 已编码 JSON / 原始字节）。
pub use crate::request::RequestBody;
/// 请求体压缩算法选择。
pub use crate::request::RequestCompression;
/// 平台无关的 HTTP 响应抽象。
pub use crate::request::Response;
/// 重试触发条件配置。
pub use crate::retry::RetryOn;
/// 重试策略（最大尝试次数、基础延迟、触发条件）。
pub use crate::retry::RetryPolicy;
/// 指数退避算法（含 ±10% 抖动）。
pub use crate::retry::backoff;
/// 按重试策略运行给定的异步操作。
pub use crate::retry::run_with_retry;
/// 将字节流转换为 SSE 事件流并通过 mpsc 推送。
pub use crate::sse::sse_stream;
/// 请求遥测数据，用于指标上报。
pub use crate::telemetry::RequestTelemetry;
/// 字节流类型别名。
pub use crate::transport::ByteStream;
/// HTTP 传输层 trait 抽象。
pub use crate::transport::HttpTransport;
/// 基于 reqwest 的默认传输层实现。
pub use crate::transport::ReqwestTransport;
/// 流式响应句柄。
pub use crate::transport::StreamResponse;

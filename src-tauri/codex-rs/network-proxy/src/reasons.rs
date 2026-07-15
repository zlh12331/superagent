//! 网络代理拒绝原因常量模块。
//!
//! 定义所有用于审计日志与拒绝响应的标准化原因字符串。
//! 这些字符串作为机器可读的标识符，便于上层统计与告警。

/// 通用拒绝原因
pub(crate) const REASON_DENIED: &str = "denied";
/// HTTP 方法不被允许（如 limited 模式下的 POST）
pub(crate) const REASON_METHOD_NOT_ALLOWED: &str = "method_not_allowed";
/// MITM 钩子拒绝该请求
pub(crate) const REASON_MITM_HOOK_DENIED: &str = "mitm_hook_denied";
/// 该请求需要 MITM 才能执行策略
pub(crate) const REASON_MITM_REQUIRED: &str = "mitm_required";
/// 请求被通用策略拒绝
pub(crate) const REASON_NOT_ALLOWED: &str = "not_allowed";
/// 请求被本地/私有地址策略拒绝
pub(crate) const REASON_NOT_ALLOWED_LOCAL: &str = "not_allowed_local";
/// 请求被托管策略拒绝
pub(crate) const REASON_POLICY_DENIED: &str = "policy_denied";
/// 代理已被禁用
pub(crate) const REASON_PROXY_DISABLED: &str = "proxy_disabled";
/// 当前平台不支持 unix socket 代理
pub(crate) const REASON_UNIX_SOCKET_UNSUPPORTED: &str = "unix_socket_unsupported";

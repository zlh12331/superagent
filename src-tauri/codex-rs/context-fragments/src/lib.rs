//! 上下文片段（context fragments）抽象与注册机制。
//!
//! 本 crate 定义了向模型可见上下文中注入额外片段的统一抽象，
//! 支持开发者片段与用户片段两种来源，并通过注册代理实现片段的动态拼装。

mod additional_context;
mod fragment;

/// 来自开发者侧的额外上下文片段。
pub use additional_context::AdditionalContextDeveloperFragment;
/// 来自用户侧的额外上下文片段。
pub use additional_context::AdditionalContextUserFragment;
/// 带上下文信息的用户片段。
pub use fragment::ContextualUserFragment;
/// 片段注册项，描述单个片段的元信息与加载方式。
pub use fragment::FragmentRegistration;
/// 片段注册代理，聚合多个 `FragmentRegistration` 并对外提供统一访问。
pub use fragment::FragmentRegistrationProxy;

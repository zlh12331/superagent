//! Executor-backed connector 声明加载。
//!
//! 该 crate 负责从 executor plugin 加载 connector 声明，并通过
//! [`ExecutorPluginConnectorProvider`] 对外暴露统一的 provider 接口。

mod executor_plugin;

pub use executor_plugin::ExecutorPluginConnectorProvider;
pub use executor_plugin::ExecutorPluginConnectorProviderError;

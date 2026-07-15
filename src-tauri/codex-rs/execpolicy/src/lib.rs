//! codex execpolicy —— 命令执行策略核心库。
//!
//! 本 crate 提供基于 Starlark DSL 的策略文件解析、命令匹配、网络规则
//! 评估以及策略文件追加修改能力，供 codex core 在执行用户命令前进行
//! 安全决策。
//!
//! 子模块：
//! - `decision`：决策枚举（Allow / Prompt / Forbidden）。
//! - `rule`：规则定义（prefix rule、network rule）与匹配逻辑。
//! - `policy`：策略对象，承载规则集合并提供命令检查入口。
//! - `parser`：基于 Starlark 的策略文件解析器。
//! - `amend`：策略文件追加修改（advisory file locking）。
//! - `execpolicycheck`：CLI 子命令 `check` 的实现。
//! - `executable_name`：跨平台可执行文件名归一化工具。
//! - `error`：错误类型与位置信息。

pub(crate) mod amend;
pub(crate) mod decision;
pub(crate) mod error;
pub(crate) mod execpolicycheck;
mod executable_name;
pub(crate) mod parser;
pub(crate) mod policy;
pub mod rule;

pub use amend::AmendError;
pub use amend::blocking_append_allow_prefix_rule;
pub use amend::blocking_append_network_rule;
pub use decision::Decision;
pub use error::Error;
pub use error::ErrorLocation;
pub use error::Result;
pub use error::TextPosition;
pub use error::TextRange;
pub use execpolicycheck::ExecPolicyCheckCommand;
pub use parser::PolicyParser;
pub use policy::Evaluation;
pub use policy::MatchOptions;
pub use policy::Policy;
pub use rule::NetworkRuleProtocol;
pub use rule::PatternToken;
pub use rule::PrefixPattern;
pub use rule::PrefixRule;
pub use rule::Rule;
pub use rule::RuleMatch;
pub use rule::RuleRef;

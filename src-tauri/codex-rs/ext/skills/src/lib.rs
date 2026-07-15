//! Skills extension crate。
//!
//! 该 crate 提供 Codex 的 skills（技能）发现、读取和注入能力。
//! skills 来源包括：
//!
//! - **Host**：Codex 宿主管理的 skills（bundled、user、repo、plugin-installed）
//! - **Executor**：执行环境拥有的 skills
//! - **Orchestrator**：orchestrator 拥有的 skills（通过 MCP resource 暴露）
//!
//! ## 架构
//!
//! - [`catalog`](catalog) 模块定义 skill 目录和资源类型
//! - [`provider`](provider) 模块定义 skill provider trait 和三种实现
//! - [`sources`](sources) 模块管理多个 provider source 的聚合
//! - [`state`](state) 模块管理 thread/turn 级缓存
//! - [`extension`](extension) 模块将所有能力注册为 extension contributor
//! - [`render`](render) 模块构建 available skills prompt fragment
//! - [`fragments`](fragments) 模块定义 contextual user fragment
//! - [`selection`](selection) 模块从用户输入提取 skill mentions
//! - [`tools`](tools) 模块将 skill 操作封装为 Responses API 工具
//! - [`world_state`](world_state) 模块贡献 skills world state section

// 子模块声明
pub mod catalog;
mod config;
mod extension;
mod fragments;
pub mod provider;
mod render;
mod selection;
mod sources;
mod state;
mod tools;
mod world_state;

// 对外公开的类型 re-export
pub use config::SkillsExtensionConfig;
pub use extension::install;
pub use extension::install_with_providers;
pub use provider::ExecutorSkillProvider;
pub use provider::HostSkillProvider;
pub use provider::OrchestratorSkillProvider;
pub use provider::SkillProvider;
pub use sources::SkillProviderSource;
pub use sources::SkillProviders;

//! Skill provider trait 定义模块。
//!
//! 该模块定义了 skill provider 的核心 trait（`SkillProvider`）以及相关的
//! 请求/响应类型。所有具体的 provider 实现（host、executor、orchestrator）
//! 都遵循该接口契约。
//!
//! 子模块：
//! - `executor`：通过执行环境文件系统发现和读取 skills
//! - `host`：基于不可变快照的 host skills provider
//! - `orchestrator`：通过 MCP resources 发现 orchestrator skills

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

mod executor;
mod host;
mod orchestrator;

use codex_core_skills::HostSkillsSnapshot;
use codex_mcp::McpResourceClient;
use codex_protocol::capabilities::SelectedCapabilityRoot;

use crate::catalog::SkillAuthority;
use crate::catalog::SkillCatalog;
use crate::catalog::SkillPackageId;
use crate::catalog::SkillProviderResult;
use crate::catalog::SkillReadResult;
use crate::catalog::SkillResourceId;
use crate::catalog::SkillSearchResult;

// 对外公开具体 provider 类型
pub use executor::ExecutorSkillProvider;
pub use host::HostSkillProvider;
pub use orchestrator::OrchestratorSkillProvider;

/// Skill 列表查询参数。
///
/// 封装了 list 操作所需的所有上下文信息，包括来源过滤标志、host 快照、
/// executor roots 和 MCP 资源客户端等。
#[derive(Clone, Debug)]
pub struct SkillListQuery {
    /// 当前 turn 的 id
    pub turn_id: String,
    /// 选中的执行环境 capability roots
    pub executor_roots: Vec<SelectedCapabilityRoot>,
    /// Host skills 的不可变快照
    pub host_snapshot: Option<Arc<HostSkillsSnapshot>>,
    /// 是否包含 host skills
    pub include_host_skills: bool,
    /// 是否包含 bundled skills
    pub include_bundled_skills: bool,
    /// 是否包含 orchestrator skills
    pub include_orchestrator_skills: bool,
    /// MCP 资源客户端（用于 orchestrator skills 发现）
    pub mcp_resources: Option<Arc<McpResourceClient>>,
}

/// Skill 读取请求参数。
#[derive(Clone, Debug)]
pub struct SkillReadRequest {
    /// 目标 authority
    pub authority: SkillAuthority,
    /// 目标 package id
    pub package: SkillPackageId,
    /// 目标 resource id
    pub resource: SkillResourceId,
    /// Host skills 快照（host 来源读取时需要）
    pub host_snapshot: Option<Arc<HostSkillsSnapshot>>,
    /// MCP 资源客户端（orchestrator 来源读取时需要）
    pub mcp_resources: Option<Arc<McpResourceClient>>,
}

/// Skill 搜索请求参数。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillSearchRequest {
    /// 目标 authority
    pub authority: SkillAuthority,
    /// 目标 package id
    pub package: SkillPackageId,
    /// 搜索查询字符串
    pub query: String,
}

/// Provider 方法的统一 Future 类型别名。
pub type SkillProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = SkillProviderResult<T>> + Send + 'a>>;

/// 来源特定的 skill 目录和资源访问接口。
///
/// 实现者必须保持 authority 边界：由某个 provider 列出的 resource 必须通过
/// 同一个 provider/authority 读取或搜索，而不能转换为环境本地路径。
pub trait SkillProvider: Send + Sync {
    /// 列出该 provider 拥有的 skills。
    fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog>;

    /// 读取指定 skill resource 的内容。
    fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult>;

    /// 搜索指定 package 中的 resource。
    fn search(&self, request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult>;
}

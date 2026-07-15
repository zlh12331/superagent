//! Thread/turn 级缓存状态模块。
//!
//! 该模块管理 skills 扩展在 thread 和 turn 生命周期中的状态，包括：
//! - `SkillsThreadState`：thread 级状态，持有配置和两个缓存（executor 和 orchestrator）
//! - `SkillsTurnState`：turn 级状态，持有当前 turn 的目录、选中条目和警告
//! - `ExecutorSkillsStepState`：执行环境 skill 步骤状态
//! - `OrchestratorGenerationCache`：orchestrator 资源缓存
//!
//! 缓存策略：
//! - Executor 缓存：按 selected root 缓存 catalog，首次结果持久缓存直到 thread 结束
//! - Orchestrator 缓存：按 MCP 客户端 cache key 缓存 catalog 和已读取的 resource，
//!   当 MCP 客户端变更时重建缓存；缓存有数量和字节数上限

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;

use codex_mcp::McpResourceClient;
use codex_mcp::McpResourceClientCacheKey;
use codex_protocol::capabilities::SelectedCapabilityRoot;
use tokio::sync::OnceCell;

use crate::SkillsExtensionConfig;
use crate::catalog::SkillAuthority;
use crate::catalog::SkillCatalog;
use crate::catalog::SkillCatalogEntry;
use crate::catalog::SkillPackageId;
use crate::catalog::SkillProviderError;
use crate::catalog::SkillProviderResult;
use crate::catalog::SkillReadResult;
use crate::catalog::SkillResourceId;
use crate::catalog::SkillSourceKind;
use crate::provider::SkillListQuery;
use crate::provider::SkillReadRequest;
use crate::sources::SkillProviders;

/// 缓存的 orchestrator resource 最大数量
const MAX_CACHED_ORCHESTRATOR_RESOURCES: usize = 100;
/// 缓存的 orchestrator resource 最大总字节数
const MAX_CACHED_ORCHESTRATOR_CONTENT_BYTES: usize = 8 * 1024 * 1024;

/// Skills 扩展的 thread 级状态。
///
/// 持有当前配置、orchestrator 可用性标志以及两个独立的缓存。
/// 通过 `Mutex` 保证线程安全，缓存策略保证在 thread 生命周期内
/// 相同输入产生相同输出（乐观并发控制）。
pub(crate) struct SkillsThreadState {
    /// 当前 skills 扩展配置
    config: Mutex<SkillsExtensionConfig>,
    /// orchestrator skills 是否可用（当存在非本地环境时为 true）
    orchestrator_skills_available: bool,
    /// Executor catalog 缓存，按 selected root 索引
    executor_cache: Mutex<Vec<CachedExecutorCatalog>>,
    /// Orchestrator catalog 和 resource 缓存
    orchestrator_cache: Mutex<Option<Arc<OrchestratorGenerationCache>>>,
}

impl SkillsThreadState {
    /// 创建一个新的 thread 级状态。
    ///
    /// # 参数
    /// - `config`：初始配置
    /// - `orchestrator_skills_available`：orchestrator skills 是否可用
    pub(crate) fn new(config: SkillsExtensionConfig, orchestrator_skills_available: bool) -> Self {
        Self {
            config: Mutex::new(config),
            orchestrator_skills_available,
            executor_cache: Mutex::new(Vec::new()),
            orchestrator_cache: Mutex::new(None),
        }
    }

    /// 获取当前配置的副本。
    pub(crate) fn config(&self) -> SkillsExtensionConfig {
        self.config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// 更新当前配置。
    pub(crate) fn set_config(&self, config: SkillsExtensionConfig) {
        *self
            .config
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = config;
    }

    /// 判断 orchestrator skills 是否启用。
    ///
    /// 需要同时满足：orchestrator 可用且配置启用。
    pub(crate) fn orchestrator_skills_enabled(&self) -> bool {
        self.orchestrator_skills_available && self.config().orchestrator_skills_enabled
    }

    /// 返回稳定 selected roots 的 catalog 快照。
    ///
    /// 每个 root 的首次 catalog 结果会被缓存直到 thread 状态被销毁。
    /// 环境可用性仅控制 root 是否投影到当前步骤，不会使缓存失效。
    /// 故意不实现文件系统监视器或基于内容的失效，因为选中的环境 root 被视为稳定的。
    pub(crate) async fn executor_catalog_snapshot(
        &self,
        providers: &SkillProviders,
        mut query: SkillListQuery,
    ) -> SkillCatalog {
        let roots = std::mem::take(&mut query.executor_roots);
        let mut catalog = SkillCatalog::default();
        for root in roots {
            query.executor_roots = vec![root.clone()];
            catalog.extend(
                self.executor_root_catalog(providers, root, query.clone())
                    .await,
            );
        }
        catalog
    }

    /// 返回 orchestrator catalog 的缓存快照。
    ///
    /// 使用 `OnceCell` 保证 catalog 只初始化一次（基于 MCP 客户端 cache key）。
    /// 若初始化函数返回错误，将错误消息转为 catalog 的警告。
    pub(crate) async fn orchestrator_catalog_snapshot(
        &self,
        mcp_resources: Option<&McpResourceClient>,
        initialize: impl Future<Output = Result<SkillCatalog, SkillProviderError>> + Send,
    ) -> SkillCatalog {
        self.orchestrator_cache(mcp_resources)
            .catalog
            .get_or_init(|| async {
                initialize.await.unwrap_or_else(|err| SkillCatalog {
                    warnings: vec![err.message],
                    ..Default::default()
                })
            })
            .await
            .clone()
    }

    /// 读取 skill resource，对 orchestrator 来源使用缓存。
    ///
    /// 非 orchestrator 来源直接委托给 provider 集合读取。
    /// orchestrator 来源先检查缓存，命中则返回；未命中则读取并缓存结果。
    pub(crate) async fn read_skill(
        &self,
        providers: &SkillProviders,
        request: SkillReadRequest,
    ) -> SkillProviderResult<SkillReadResult> {
        if request.authority.kind != SkillSourceKind::Orchestrator {
            return providers.read(request).await;
        }

        let cache = self.orchestrator_cache(request.mcp_resources.as_deref());
        let cache_key = SkillReadCacheKey::from(&request);
        // 先检查缓存
        if let Some(result) = cache
            .resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&cache_key)
        {
            return Ok(result);
        }

        let result = providers.read(request).await?;
        // 仅缓存与请求 resource 一致的结果
        if result.resource != cache_key.resource {
            return Ok(result);
        }

        Ok(cache
            .resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(cache_key, result))
    }

    /// 获取或创建 orchestrator 缓存。
    ///
    /// 根据 MCP 客户端的 cache key 判断是否需要重建缓存。
    /// 当 MCP 客户端变更时，旧的缓存被丢弃并创建新的空缓存。
    fn orchestrator_cache(
        &self,
        mcp_resources: Option<&McpResourceClient>,
    ) -> Arc<OrchestratorGenerationCache> {
        let mut cache = self
            .orchestrator_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cache_key = mcp_resources.map(McpResourceClient::cache_key);
        // 若已有缓存且 cache key 匹配，直接复用
        if let Some(cache) = cache
            .as_ref()
            .filter(|cache| cache.mcp_cache_key == cache_key)
        {
            return Arc::clone(cache);
        }

        // 创建新缓存
        let next_cache = Arc::new(OrchestratorGenerationCache {
            mcp_cache_key: cache_key,
            catalog: OnceCell::new(),
            resources: Mutex::new(OrchestratorResourceCache::default()),
        });
        *cache = Some(Arc::clone(&next_cache));
        next_cache
    }

    /// 获取指定 root 的 executor catalog（带缓存）。
    ///
    /// 若缓存中已有该 root 的 catalog，直接返回；否则调用 provider 发现
    /// 并将结果存入缓存。使用双重检查避免并发重复发现。
    async fn executor_root_catalog(
        &self,
        providers: &SkillProviders,
        root: SelectedCapabilityRoot,
        query: SkillListQuery,
    ) -> SkillCatalog {
        // 第一次检查（快速路径）
        if let Some(cached) = self
            .executor_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|cached| cached.root == root)
        {
            return cached.catalog.clone();
        }

        let discovered = providers.list_executor_for_turn(query).await;
        let mut cache = self
            .executor_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // 第二次检查（防止并发重复发现）
        if let Some(cached) = cache.iter().find(|cached| cached.root == root) {
            return cached.catalog.clone();
        }
        cache.push(CachedExecutorCatalog {
            root,
            catalog: discovered.clone(),
        });
        discovered
    }
}

/// 缓存的 executor catalog 条目。
struct CachedExecutorCatalog {
    /// 关联的 selected root
    root: SelectedCapabilityRoot,
    /// 缓存的 catalog
    catalog: SkillCatalog,
}

/// Orchestrator 生成缓存，按 MCP 客户端 cache key 隔离。
///
/// 包含 catalog 的 `OnceCell`（只初始化一次）和 resource 的 `Mutex<HashMap>`（可增量缓存）。
struct OrchestratorGenerationCache {
    /// MCP 客户端的 cache key，用于判断缓存是否需要重建
    mcp_cache_key: Option<McpResourceClientCacheKey>,
    /// catalog 缓存，只初始化一次
    catalog: OnceCell<SkillCatalog>,
    /// resource 内容缓存，可增量添加
    resources: Mutex<OrchestratorResourceCache>,
}

/// Skill 读取缓存键，由 authority、package 和 resource 组成。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SkillReadCacheKey {
    authority: SkillAuthority,
    package: SkillPackageId,
    resource: SkillResourceId,
}

impl From<&SkillReadRequest> for SkillReadCacheKey {
    fn from(request: &SkillReadRequest) -> Self {
        Self {
            authority: request.authority.clone(),
            package: request.package.clone(),
            resource: request.resource.clone(),
        }
    }
}

/// Orchestrator resource 缓存，存储已读取的 resource 内容。
///
/// 有数量和字节数上限，超过上限时不再缓存新条目。
#[derive(Default)]
struct OrchestratorResourceCache {
    /// 已缓存的 resource 条目
    entries: HashMap<SkillReadCacheKey, SkillReadResult>,
    /// 当前缓存的总字节数
    contents_bytes: usize,
}

impl OrchestratorResourceCache {
    /// 获取缓存的 resource 结果。
    fn get(&self, key: &SkillReadCacheKey) -> Option<SkillReadResult> {
        self.entries.get(key).cloned()
    }

    /// 插入缓存结果。
    ///
    /// 若已存在相同 key 的缓存，返回已缓存的副本。
    /// 若超过数量或字节数上限，返回原始结果但不缓存。
    fn insert(&mut self, key: SkillReadCacheKey, result: SkillReadResult) -> SkillReadResult {
        // 已存在则返回已缓存的副本
        if let Some(cached) = self.entries.get(&key) {
            return cached.clone();
        }

        // 检查字节数是否溢出
        let contents_bytes = result.contents.len();
        let Some(next_contents_bytes) = self.contents_bytes.checked_add(contents_bytes) else {
            return result;
        };
        // 检查是否超过数量或字节数上限
        if self.entries.len() >= MAX_CACHED_ORCHESTRATOR_RESOURCES
            || next_contents_bytes > MAX_CACHED_ORCHESTRATOR_CONTENT_BYTES
        {
            return result;
        }

        // 缓存新条目
        self.contents_bytes = next_contents_bytes;
        self.entries.insert(key, result.clone());
        result
    }
}

/// Skills 扩展的 turn 级状态。
///
/// 存储当前 turn 处理过程中产生的目录、选中的 skill 条目、警告信息
/// 以及主 prompt 是否已注入的标志。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SkillsTurnState {
    /// 当前 turn 的合并目录
    pub(crate) catalog: SkillCatalog,
    /// 当前 turn 选中的 skill 条目
    pub(crate) selected_entries: Vec<SkillCatalogEntry>,
    /// 当前 turn 产生的警告
    pub(crate) warnings: Vec<String>,
    /// 是否已注入主 prompt
    pub(crate) main_prompts_injected: bool,
}

/// 执行环境 skill 步骤状态，存储 world state 阶段发现的 executor catalog。
#[derive(Clone, Debug, Default)]
pub(crate) struct ExecutorSkillsStepState(pub(crate) SkillCatalog);

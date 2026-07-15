//! Provider source 聚合模块。
//!
//! 该模块定义了 `SkillProviderSource` 和 `SkillProviders`，用于聚合多个
//! skill provider 并按来源类型路由 list/read/search 请求。
//!
//! `SkillProviders` 提供以下核心能力：
//! - 按 query 标志过滤应该列出的 provider 来源
//! - 聚合多个 provider 的 catalog 结果并合并警告
//! - 按 authority kind 路由 read/search 请求到正确的 provider

use std::fmt;
use std::sync::Arc;

use crate::catalog::SkillCatalog;
use crate::catalog::SkillProviderError;
use crate::catalog::SkillProviderResult;
use crate::catalog::SkillReadResult;
use crate::catalog::SkillSearchResult;
use crate::catalog::SkillSourceKind;
use crate::provider::SkillListQuery;
use crate::provider::SkillProvider;
use crate::provider::SkillReadRequest;
use crate::provider::SkillSearchRequest;

/// 单个 provider 来源，封装来源类型、标签和 provider 实现。
///
/// 标签用于生成警告消息时标识来源，便于调试。
#[derive(Clone)]
pub struct SkillProviderSource {
    /// 来源类型
    kind: SkillSourceKind,
    /// 来源标签（用于警告消息）
    label: String,
    /// provider 实现
    provider: Arc<dyn SkillProvider>,
}

impl SkillProviderSource {
    /// 创建一个新的 provider 来源。
    ///
    /// # 参数
    /// - `kind`：来源类型
    /// - `label`：来源标签
    /// - `provider`：provider 实现
    pub fn new(
        kind: SkillSourceKind,
        label: impl Into<String>,
        provider: Arc<dyn SkillProvider>,
    ) -> Self {
        Self {
            kind,
            label: label.into(),
            provider,
        }
    }

    /// 创建一个 host 来源的快捷方法。
    pub fn host(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self {
        Self::new(SkillSourceKind::Host, label, provider)
    }

    /// 创建一个 executor 来源的快捷方法。
    pub fn executor(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self {
        Self::new(SkillSourceKind::Executor, label, provider)
    }

    /// 创建一个 orchestrator 来源的快捷方法。
    pub fn orchestrator(label: impl Into<String>, provider: Arc<dyn SkillProvider>) -> Self {
        Self::new(SkillSourceKind::Orchestrator, label, provider)
    }

    /// 根据 query 判断该来源是否应该被列出。
    ///
    /// 各来源的判断规则：
    /// - Host：检查 `include_host_skills` 标志
    /// - Executor：检查是否有 executor_roots
    /// - Orchestrator：检查 `include_orchestrator_skills` 标志
    /// - Custom：始终列出
    fn should_list(&self, query: &SkillListQuery) -> bool {
        match &self.kind {
            SkillSourceKind::Host => query.include_host_skills,
            SkillSourceKind::Executor => !query.executor_roots.is_empty(),
            SkillSourceKind::Orchestrator => query.include_orchestrator_skills,
            SkillSourceKind::Custom(_) => true,
        }
    }

    /// 检查该来源是否拥有指定的来源类型。
    fn owns_kind(&self, kind: &SkillSourceKind) -> bool {
        &self.kind == kind
    }
}

impl fmt::Debug for SkillProviderSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SkillProviderSource")
            .field("kind", &self.kind)
            .field("label", &self.label)
            .finish()
    }
}

/// 聚合多个 provider 来源的集合。
///
/// 提供按来源类型路由的 list/read/search 操作，并聚合结果和警告。
#[derive(Clone, Default, Debug)]
pub struct SkillProviders {
    /// 已注册的 provider 来源列表
    sources: Vec<SkillProviderSource>,
}

impl SkillProviders {
    /// 创建一个空的 provider 集合。
    pub fn new() -> Self {
        Self::default()
    }

    /// 链式添加一个 provider 来源。
    pub fn with_provider(mut self, source: SkillProviderSource) -> Self {
        self.sources.push(source);
        self
    }

    /// 链式添加一个 host provider。
    pub fn with_host_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self {
        self.sources
            .push(SkillProviderSource::host("host", provider));
        self
    }

    /// 链式添加一个 executor provider。
    pub fn with_executor_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self {
        self.sources
            .push(SkillProviderSource::executor("executor", provider));
        self
    }

    /// 链式添加一个 orchestrator provider。
    pub fn with_orchestrator_provider(mut self, provider: Arc<dyn SkillProvider>) -> Self {
        self.sources
            .push(SkillProviderSource::orchestrator("orchestrator", provider));
        self
    }

    /// 检查是否存在 orchestrator provider。
    pub(crate) fn has_orchestrator_provider(&self) -> bool {
        self.sources
            .iter()
            .any(|source| source.kind == SkillSourceKind::Orchestrator)
    }

    /// 列出当前 turn 应该包含的所有非 orchestrator 来源的 skills。
    ///
    /// 根据 query 标志过滤 provider 来源，聚合 catalog 并将错误转为警告。
    pub(crate) async fn list_for_turn(&self, query: SkillListQuery) -> SkillCatalog {
        self.list_matching(&query, |source| source.should_list(&query))
            .await
    }

    /// 列出 orchestrator 来源的 skills。
    ///
    /// 与 `list_for_turn` 不同，该方法返回 `Result` 而非将错误转为警告，
    /// 因为 orchestrator 发现失败应由调用方决定如何处理。
    pub(crate) async fn list_orchestrator_for_turn(
        &self,
        query: SkillListQuery,
    ) -> SkillProviderResult<SkillCatalog> {
        let mut catalog = SkillCatalog::default();

        for source in self
            .sources
            .iter()
            .filter(|source| source.kind == SkillSourceKind::Orchestrator)
        {
            let source_catalog = source.provider.list(query.clone()).await.map_err(|err| {
                SkillProviderError::new(format!(
                    "{} skills unavailable: {}",
                    source.label, err.message
                ))
            })?;
            catalog.extend(source_catalog);
        }

        Ok(catalog)
    }

    /// 列出 executor 来源的 skills。
    pub(crate) async fn list_executor_for_turn(&self, query: SkillListQuery) -> SkillCatalog {
        self.list_matching(&query, |source| source.kind == SkillSourceKind::Executor)
            .await
    }

    /// 内部方法：按过滤条件列出匹配来源的 skills 并聚合 catalog。
    ///
    /// 单个来源的失败会被转为警告而非传播错误，确保其他来源的结果不受影响。
    async fn list_matching(
        &self,
        query: &SkillListQuery,
        should_list: impl Fn(&SkillProviderSource) -> bool,
    ) -> SkillCatalog {
        let mut catalog = SkillCatalog::default();

        for source in self.sources.iter().filter(|source| should_list(source)) {
            extend_catalog(
                &mut catalog,
                source.provider.list(query.clone()).await,
                source.label.as_str(),
            );
        }

        catalog
    }

    /// 读取指定 authority 的 skill resource。
    ///
    /// 按 authority kind 路由到拥有该 kind 的 provider，依次尝试直到成功。
    /// 若所有 provider 都失败，返回最后一个错误；若无匹配 provider，返回未配置错误。
    pub(crate) async fn read(
        &self,
        request: SkillReadRequest,
    ) -> Result<SkillReadResult, SkillProviderError> {
        let mut last_error = None;
        for source in self
            .sources
            .iter()
            .filter(|source| source.owns_kind(&request.authority.kind))
        {
            match source.provider.read(request.clone()).await {
                Ok(result) => return Ok(result),
                Err(err) => last_error = Some(err),
            }
        }

        match last_error {
            Some(err) => Err(err),
            None => Err(SkillProviderError::new(format!(
                "{} skill provider is not configured",
                request.authority.kind
            ))),
        }
    }

    /// 搜索指定 authority 的 skill resource。
    ///
    /// 按 authority kind 路由到拥有该 kind 的 provider，依次尝试直到成功。
    pub async fn search(
        &self,
        request: SkillSearchRequest,
    ) -> Result<SkillSearchResult, SkillProviderError> {
        let mut last_error = None;
        for source in self
            .sources
            .iter()
            .filter(|source| source.owns_kind(&request.authority.kind))
        {
            match source.provider.search(request.clone()).await {
                Ok(result) => return Ok(result),
                Err(err) => last_error = Some(err),
            }
        }

        match last_error {
            Some(err) => Err(err),
            None => Err(SkillProviderError::new(format!(
                "{} skill provider is not configured",
                request.authority.kind
            ))),
        }
    }
}

/// 将单个来源的 catalog 结果合并到聚合 catalog 中。
///
/// 成功时扩展 catalog，失败时将错误转为警告追加到 catalog。
fn extend_catalog(
    catalog: &mut SkillCatalog,
    result: Result<SkillCatalog, SkillProviderError>,
    label: &str,
) {
    match result {
        Ok(source_catalog) => catalog.extend(source_catalog),
        Err(err) => catalog
            .warnings
            .push(format!("{label} skills unavailable: {}", err.message)),
    }
}

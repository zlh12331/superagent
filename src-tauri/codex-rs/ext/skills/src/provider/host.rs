//! Host skill provider 模块。
//!
//! 该模块实现了 `HostSkillProvider`，基于不可变的 host skills 快照
//! 提供 list 和 read 操作。
//!
//! 设计说明：
//! - 发现和缓存由 `SkillsService` 负责，本 provider 仅将快照映射为
//!   authority 感知的 catalog/read 契约
//! - 快照是不可变的，确保在 thread 生命周期内数据一致

use codex_core_skills::SkillLoadOutcome;
use codex_core_skills::SkillMetadata;

use crate::catalog::SkillAuthority;
use crate::catalog::SkillCatalog;
use crate::catalog::SkillCatalogEntry;
use crate::catalog::SkillPackageId;
use crate::catalog::SkillProviderError;
use crate::catalog::SkillReadResult;
use crate::catalog::SkillResourceId;
use crate::catalog::SkillSearchResult;
use crate::catalog::SkillSourceKind;
use crate::provider::SkillListQuery;
use crate::provider::SkillProvider;
use crate::provider::SkillProviderFuture;
use crate::provider::SkillReadRequest;
use crate::provider::SkillSearchRequest;

/// Host authority 的 id
const HOST_AUTHORITY_ID: &str = "host";

/// 基于 host skills 快照的 provider。
///
/// 该 provider 不执行实际的发现或缓存，仅将传入的快照转换为
/// catalog 和 read 结果。发现和缓存由 `SkillsService` 在外部完成。
#[derive(Clone, Default)]
pub struct HostSkillProvider;

impl HostSkillProvider {
    /// 创建一个新的 host skill provider。
    pub fn new() -> Self {
        Self
    }
}

impl SkillProvider for HostSkillProvider {
    /// 列出 host skills 快照中的所有 skills。
    ///
    /// 需要 query 中包含 host_snapshot，否则返回错误。
    fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog> {
        Box::pin(async move {
            let Some(host_snapshot) = query.host_snapshot else {
                return Err(SkillProviderError::new(
                    "host skill provider requires a host skills snapshot",
                ));
            };

            Ok(catalog_from_outcome(host_snapshot.outcome()))
        })
    }

    /// 读取指定 host skill 的内容。
    ///
    /// 通过 resource id（skill 路径）在快照中查找对应的 skill，
    /// 然后从快照读取文件文本。支持 Windows 和 POSIX 路径分隔符的匹配。
    fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult> {
        Box::pin(async move {
            let Some(host_snapshot) = request.host_snapshot else {
                return Err(SkillProviderError::new(
                    "host skill provider requires a host skills snapshot",
                ));
            };
            // 查找路径匹配的 skill，支持 Windows 和 POSIX 路径分隔符
            let Some(skill) = host_snapshot.outcome().skills.iter().find(|skill| {
                let skill_path = skill.path_to_skills_md.to_string_lossy();
                skill_path == request.resource.as_str()
                    || skill_path.replace('\\', "/") == request.resource.as_str()
            }) else {
                return Err(SkillProviderError::new(format!(
                    "host skill resource is not loaded: {}",
                    request.resource.as_str()
                )));
            };

            // 从快照读取 skill 文本
            let contents = host_snapshot.read_skill_text(skill).await.map_err(|err| {
                SkillProviderError::new(format!(
                    "failed to read host skill resource {}: {err}",
                    request.resource.as_str()
                ))
            })?;

            Ok(SkillReadResult {
                resource: request.resource,
                contents,
            })
        })
    }

    /// 搜索 skills（当前返回空结果，预留接口）。
    fn search(&self, _request: SkillSearchRequest) -> SkillProviderFuture<'_, SkillSearchResult> {
        Box::pin(async { Ok(SkillSearchResult::default()) })
    }
}

/// 从 skill 加载结果创建 catalog。
///
/// 将加载错误转为 catalog 警告，将成功加载的 skills 转为 catalog 条目。
fn catalog_from_outcome(outcome: &SkillLoadOutcome) -> SkillCatalog {
    let mut catalog = SkillCatalog {
        entries: Vec::new(),
        warnings: outcome
            .errors
            .iter()
            .map(|err| {
                format!(
                    "Failed to load skill at {}: {}",
                    err.path.display(),
                    err.message
                )
            })
            .collect(),
    };

    for (skill, enabled) in outcome.skills_with_enabled() {
        catalog.push_entry(catalog_entry_from_skill(skill, enabled));
    }

    catalog
}

/// 从 skill 元数据创建 catalog 条目。
///
/// 设置展示路径（规范化为正斜杠），并根据 enabled 和 allows_implicit_invocation
/// 标志调整条目状态。
fn catalog_entry_from_skill(skill: &SkillMetadata, enabled: bool) -> SkillCatalogEntry {
    let skill_path = skill.path_to_skills_md.to_string_lossy().into_owned();
    let display_path = skill_path.replace('\\', "/");
    let mut entry = SkillCatalogEntry::new(
        SkillPackageId(skill_path.clone()),
        SkillAuthority::new(SkillSourceKind::Host, HOST_AUTHORITY_ID),
        skill.name.clone(),
        skill.description.clone(),
        SkillResourceId::new(skill_path),
    )
    .with_short_description(skill.short_description.clone())
    .with_display_path(display_path)
    .with_dependencies(skill.dependencies.clone());

    // 未启用的 skill 标记为禁用
    if !enabled {
        entry = entry.disabled();
    }
    // 不允许隐式调用的 skill 从 prompt 中隐藏
    if !skill.allows_implicit_invocation() {
        entry = entry.hidden_from_prompt();
    }

    entry
}

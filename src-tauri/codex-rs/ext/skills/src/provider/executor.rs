//! Executor skill provider 模块。
//!
//! 该模块实现了 `ExecutorSkillProvider`，通过执行环境（execution environment）
//! 的文件系统发现和读取 skills。
//!
//! 工作原理：
//! - `list`：遍历 query 中的 executor_roots，对每个 root 调用
//!   `load_environment_skills_from_root` 加载 skill 元数据
//! - `read`：通过 resource 上绑定的 environment_id 和 path，从对应环境的
//!   文件系统读取 SKILL.md 内容
//! - `search`：当前返回空结果（预留接口）

use std::sync::Arc;

use codex_core_skills::loader::EnvironmentSkillMetadata;
use codex_core_skills::loader::load_environment_skills_from_root;
use codex_exec_server::EnvironmentManager;
use codex_protocol::capabilities::CapabilityRootLocation;
use codex_protocol::protocol::Product;
use codex_utils_path_uri::PathConvention;

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

/// 通过执行环境文件系统发现和读取 skills 的 provider。
///
/// 持有环境管理器和可选的产品限制标志，用于从执行环境的文件系统中
/// 加载 skill 元数据和读取 skill 内容。
#[derive(Clone, Debug)]
pub struct ExecutorSkillProvider {
    /// 环境管理器，用于获取执行环境的文件系统
    environment_manager: Arc<EnvironmentManager>,
    /// 产品限制标志，用于过滤仅适用于特定产品的 skills
    restriction_product: Option<Product>,
}

impl ExecutorSkillProvider {
    /// 创建一个新的 executor skill provider。
    ///
    /// # 参数
    /// - `environment_manager`：环境管理器
    /// - `restriction_product`：产品限制标志（`None` 表示不限制）
    pub fn new_with_restriction_product(
        environment_manager: Arc<EnvironmentManager>,
        restriction_product: Option<Product>,
    ) -> Self {
        Self {
            environment_manager,
            restriction_product,
        }
    }
}

impl SkillProvider for ExecutorSkillProvider {
    /// 列出所有 executor roots 下的 skills。
    ///
    /// 遍历 query 中的 executor_roots，对每个 root：
    /// 1. 解析 root 的 environment id 和路径
    /// 2. 获取对应的执行环境
    /// 3. 从环境文件系统加载 skill 元数据
    /// 4. 将元数据转换为 catalog 条目
    fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog> {
        Box::pin(async move {
            let mut catalog = SkillCatalog::default();
            for selected_root in query.executor_roots {
                let selected_root_id = selected_root.id;
                let CapabilityRootLocation::Environment {
                    environment_id,
                    path,
                } = selected_root.location;
                let authority =
                    SkillAuthority::new(SkillSourceKind::Executor, selected_root_id.clone());
                // 获取执行环境，若不存在则记录警告
                let Some(environment) = self.environment_manager.get_environment(&environment_id)
                else {
                    catalog.warnings.push(format!(
                        "Selected capability root `{selected_root_id}` references unavailable environment `{environment_id}`."
                    ));
                    continue;
                };
                let file_system = environment.get_filesystem();
                // 从环境文件系统加载 skills
                let outcome = load_environment_skills_from_root(
                    file_system.as_ref(),
                    &path,
                    self.restriction_product,
                )
                .await;
                catalog.warnings.extend(outcome.warnings);
                for skill in outcome.skills {
                    catalog.push_entry(catalog_entry_from_skill(
                        &skill,
                        authority.clone(),
                        &selected_root_id,
                        &environment_id,
                    ));
                }
            }

            Ok(catalog)
        })
    }

    /// 读取指定 executor skill resource 的内容。
    ///
    /// 流程：
    /// 1. 验证 authority kind 为 Executor
    /// 2. 验证 package id 与 resource id 一致
    /// 3. 从 resource 获取环境路径绑定
    /// 4. 通过环境文件系统读取文件内容
    fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult> {
        Box::pin(async move {
            if request.authority.kind != SkillSourceKind::Executor {
                return Err(SkillProviderError::new(format!(
                    "executor skill provider cannot read {} resources",
                    request.authority.kind
                )));
            }
            if request.package.0 != request.resource.as_str() {
                return Err(SkillProviderError::new(
                    "executor skill resource does not match its package",
                ));
            }
            // 获取环境路径绑定
            let Some((environment_id, resource_path)) = request.resource.environment_path() else {
                return Err(SkillProviderError::new(
                    "executor skill resource is not bound to an environment",
                ));
            };
            let Some(environment) = self.environment_manager.get_environment(environment_id) else {
                return Err(SkillProviderError::new(format!(
                    "executor skill resource references unavailable environment `{environment_id}`"
                )));
            };
            // 通过环境文件系统读取文件
            let contents = environment
                .get_filesystem()
                .read_file_text(resource_path, /*sandbox*/ None)
                .await
                .map_err(|err| {
                    SkillProviderError::new(format!(
                        "failed to read executor skill resource {}: {err}",
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

/// 从环境 skill 元数据创建 catalog 条目。
///
/// 生成展示路径（`skill://{root_id}/{normalized_path}`），
/// 并根据 skill 是否允许隐式调用设置 prompt 可见性。
fn catalog_entry_from_skill(
    skill: &EnvironmentSkillMetadata,
    authority: SkillAuthority,
    selected_root_id: &str,
    environment_id: &str,
) -> SkillCatalogEntry {
    let skill_path = skill.path_to_skills_md.inferred_native_path_string();
    // 规范化路径分隔符为正斜杠（统一展示格式）
    let normalized_path = match skill.path_to_skills_md.infer_path_convention() {
        Some(PathConvention::Windows) => skill_path.replace('\\', "/"),
        Some(PathConvention::Posix) | None => skill_path,
    };
    let display_path = format!(
        "skill://{selected_root_id}/{}",
        normalized_path.trim_start_matches('/')
    );
    let entry = SkillCatalogEntry::new(
        SkillPackageId(display_path.clone()),
        authority,
        skill.name.clone(),
        skill.description.clone(),
        SkillResourceId::environment(
            display_path.clone(),
            environment_id,
            skill.path_to_skills_md.clone(),
        ),
    )
    .with_short_description(skill.short_description.clone())
    .with_display_path(display_path)
    .with_dependencies(skill.dependencies.clone());

    // 不允许隐式调用的 skill 从 prompt 中隐藏，只能通过显式 mention 调用
    if skill.allows_implicit_invocation() {
        entry
    } else {
        entry.hidden_from_prompt()
    }
}

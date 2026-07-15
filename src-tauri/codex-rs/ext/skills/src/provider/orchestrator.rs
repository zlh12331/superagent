//! Orchestrator skill provider 模块。
//!
//! 该模块实现了 `OrchestratorSkillProvider`，通过 session 级 MCP resources
//! 发现和读取 orchestrator 拥有的 skills。
//!
//! 工作原理：
//! - `list`：通过 MCP resource client 分页列出 mime_type 为 `mcp/skill` 的 resources，
//!   从 resource 的 meta 字段提取 skill 名称、描述等信息
//! - `read`：通过 MCP resource client 读取指定 skill resource 的文本内容
//! - `search`：当前返回空结果（预留接口）
//!
//! 安全限制：
//! - 发现超时：10 秒（`ORCHESTRATOR_SKILL_DISCOVERY_TIMEOUT`）
//! - 读取超时：10 秒（`ORCHESTRATOR_SKILL_READ_TIMEOUT`）
//! - 最大分页数：10 页（`MAX_RESOURCE_PAGES`）
//! - 最大 skill 数量：100 个（`MAX_ORCHESTRATOR_SKILLS`）
//! - resource 内容大小上限：1 MB（`MAX_SKILL_RESOURCE_CONTENT_BYTES`）
//! - URI 格式校验：仅允许 `skill://` scheme，无用户名/密码/端口/查询/片段

use std::collections::HashSet;
use std::time::Duration;

use codex_mcp::CODEX_APPS_MCP_SERVER_NAME;
use codex_protocol::mcp::Resource;
use codex_protocol::mcp::ResourceContent;
use url::Url;

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

/// Orchestrator skill resource 的 MIME 类型
const ORCHESTRATOR_SKILL_MIME_TYPE: &str = "mcp/skill";
/// Skill 发现超时时长
const ORCHESTRATOR_SKILL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
/// Skill 读取超时时长
const ORCHESTRATOR_SKILL_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// 最大分页数
const MAX_RESOURCE_PAGES: usize = 10;
/// 最大 skill 数量
const MAX_ORCHESTRATOR_SKILLS: usize = 100;
/// skill 名称最大字符数
const MAX_SKILL_NAME_CHARS: usize = 64;
/// 限定 skill 名称（plugin:skill 格式）最大字符数
const MAX_QUALIFIED_SKILL_NAME_CHARS: usize = 128;
/// skill package URI 最大字符数
const MAX_SKILL_PACKAGE_URI_CHARS: usize = 1_024;
/// skill resource URI 最大字符数
const MAX_SKILL_RESOURCE_URI_CHARS: usize = 2_048;
/// skill resource 内容最大字节数（1 MB）
const MAX_SKILL_RESOURCE_CONTENT_BYTES: usize = 1024 * 1024;

/// 发现和读取 orchestrator 拥有的 skills 的 provider。
///
/// 该 provider 使用 session 级 MCP resources 进行 skill 发现和读取，
/// 不向配置 skills 扩展的调用方暴露传输层或 resource server。
#[derive(Clone, Debug, Default)]
pub struct OrchestratorSkillProvider;

impl OrchestratorSkillProvider {
    /// 创建一个新的 orchestrator skill provider。
    pub fn new() -> Self {
        Self
    }
}

impl SkillProvider for OrchestratorSkillProvider {
    /// 列出 orchestrator 拥有的所有 skills。
    ///
    /// 通过 MCP resource client 分页列出 `mcp/skill` 类型的 resources，
    /// 从每个 resource 的 meta 字段提取 skill 元数据并构建 catalog 条目。
    ///
    /// 流程：
    /// 1. 检查 MCP 客户端是否配置且存在 codex-apps server
    /// 2. 设置发现超时截止时间
    /// 3. 分页列出 resources，过滤 MIME 类型为 `mcp/skill`
    /// 4. 对每个 resource 解析元数据并构建 catalog 条目
    /// 5. 处理分页游标（检测重复游标防止无限循环）
    /// 6. 达到上限时记录截断警告
    fn list(&self, query: SkillListQuery) -> SkillProviderFuture<'_, SkillCatalog> {
        Box::pin(async move {
            let Some(client) = query.mcp_resources else {
                return Ok(SkillCatalog::default());
            };
            if !client.has_server(CODEX_APPS_MCP_SERVER_NAME).await {
                return Ok(SkillCatalog::default());
            }

            let discovery_deadline =
                tokio::time::Instant::now() + ORCHESTRATOR_SKILL_DISCOVERY_TIMEOUT;
            let mut catalog = SkillCatalog::default();
            let mut cursor = None;
            let mut seen_cursors = HashSet::new();
            let mut skill_resources_seen = 0usize;
            let mut skipped_resources = 0usize;
            let mut truncated = false;
            let mut completed_pages = 0usize;

            // 分页列出 resources
            for _ in 0..MAX_RESOURCE_PAGES {
                let page = match tokio::time::timeout_at(
                    discovery_deadline,
                    client.list_resources(CODEX_APPS_MCP_SERVER_NAME, cursor.clone()),
                )
                .await
                {
                    Ok(result) => result.map_err(|err| {
                        SkillProviderError::new(format!(
                            "failed to list orchestrator skill resources: {err:#}"
                        ))
                    }),
                    Err(_) => Err(SkillProviderError::new(format!(
                        "orchestrator skill discovery timed out after {ORCHESTRATOR_SKILL_DISCOVERY_TIMEOUT:?}"
                    ))),
                };
                let result = match page {
                    Ok(result) => result,
                    // 首页失败直接返回错误
                    Err(err) if completed_pages == 0 => return Err(err),
                    // 后续页失败转为警告并停止分页
                    Err(err) => {
                        let page_word = if completed_pages == 1 {
                            "page"
                        } else {
                            "pages"
                        };
                        catalog.warnings.push(format!(
                            "Orchestrator skill discovery stopped after {completed_pages} resource {page_word}: {}",
                            err.message
                        ));
                        cursor = None;
                        break;
                    }
                };
                completed_pages = completed_pages.saturating_add(1);

                for resource in &result.resources {
                    // 仅处理 mcp/skill 类型的 resource
                    if resource.mime_type.as_deref() != Some(ORCHESTRATOR_SKILL_MIME_TYPE) {
                        continue;
                    }
                    // 达到数量上限时标记截断
                    if skill_resources_seen >= MAX_ORCHESTRATOR_SKILLS {
                        truncated = true;
                        break;
                    }
                    skill_resources_seen = skill_resources_seen.saturating_add(1);
                    match catalog_entry_from_resource(resource) {
                        Some(entry) => catalog.push_entry(entry),
                        None => skipped_resources = skipped_resources.saturating_add(1),
                    }
                }

                if truncated {
                    break;
                }
                // 检查是否有下一页游标
                let Some(next_cursor) = result.next_cursor else {
                    cursor = None;
                    break;
                };
                // 检测重复游标防止无限循环
                if !seen_cursors.insert(next_cursor.clone()) {
                    catalog.warnings.push(
                        "Orchestrator skill resource pagination returned a duplicate cursor."
                            .to_string(),
                    );
                    cursor = None;
                    break;
                }
                cursor = Some(next_cursor);
            }

            // 记录截断警告
            if cursor.is_some() || truncated {
                catalog.warnings.push(format!(
                    "Orchestrator skill discovery was truncated at {MAX_ORCHESTRATOR_SKILLS} skills or {MAX_RESOURCE_PAGES} resource pages."
                ));
            }
            // 记录跳过的无效 resource 数量
            if skipped_resources > 0 {
                catalog.warnings.push(format!(
                    "Skipped {skipped_resources} malformed orchestrator skill resources."
                ));
            }

            Ok(catalog)
        })
    }

    /// 读取指定 orchestrator skill resource 的内容。
    ///
    /// 流程：
    /// 1. 验证 authority 为 orchestrator
    /// 2. 验证 resource 属于指定 package（防止路径穿越）
    /// 3. 通过 MCP resource client 读取 resource 内容
    /// 4. 提取匹配的文本内容
    /// 5. 检查内容大小是否超过上限
    fn read(&self, request: SkillReadRequest) -> SkillProviderFuture<'_, SkillReadResult> {
        Box::pin(async move {
            if request.authority
                != SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME)
            {
                return Err(SkillProviderError::new(format!(
                    "orchestrator skill provider cannot read authority {}",
                    request.authority.id
                )));
            }
            // 验证 resource 属于指定 package（安全检查）
            if !resource_belongs_to_package(&request.package.0, request.resource.as_str()) {
                return Err(SkillProviderError::new(
                    "orchestrator skill resource does not match its package",
                ));
            }

            let Some(client) = request.mcp_resources.as_ref() else {
                return Err(SkillProviderError::new(
                    "session MCP resource client is not configured",
                ));
            };
            // 通过 MCP 读取 resource，带超时
            let result = tokio::time::timeout(
                ORCHESTRATOR_SKILL_READ_TIMEOUT,
                client.read_resource(CODEX_APPS_MCP_SERVER_NAME, request.resource.as_str()),
            )
            .await
            .map_err(|_| {
                SkillProviderError::new(format!(
                    "orchestrator skill read timed out after {ORCHESTRATOR_SKILL_READ_TIMEOUT:?}"
                ))
            })?
            .map_err(|err| {
                SkillProviderError::new(format!(
                    "failed to read orchestrator skill resource {}: {err:#}",
                    request.resource.as_str()
                ))
            })?;
            // 从返回的内容中查找匹配 URI 的文本内容
            let contents = result
                .contents
                .into_iter()
                .find_map(|contents| match contents {
                    ResourceContent::Text { uri, text, .. } if uri == request.resource.as_str() => {
                        Some(text)
                    }
                    ResourceContent::Text { .. } | ResourceContent::Blob { .. } => None,
                });
            let Some(contents) = contents else {
                return Err(SkillProviderError::new(format!(
                    "orchestrator skill resource {} did not return matching text contents",
                    request.resource.as_str()
                )));
            };
            // 检查内容大小是否超过上限
            if contents.len() > MAX_SKILL_RESOURCE_CONTENT_BYTES {
                return Err(SkillProviderError::new(format!(
                    "orchestrator skill resource {} exceeds the {MAX_SKILL_RESOURCE_CONTENT_BYTES}-byte read limit",
                    request.resource.as_str()
                )));
            }

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

/// 从 MCP resource 构建 catalog 条目。
///
/// 从 resource 的 URI、meta 和 description 提取 skill 信息：
/// - URI：作为 package id 和 display_path
/// - meta.skill_name：skill 名称
/// - meta.source：若为 "user" 则使用 skill_name，否则使用 `plugin_name:skill_name` 格式
/// - meta.plugin_name：插件名称（source 非 user 时必需）
/// - description：skill 描述（经过 HTML 转义处理）
///
/// 返回 `None` 表示 resource 格式无效，应被跳过。
fn catalog_entry_from_resource(resource: &Resource) -> Option<SkillCatalogEntry> {
    let uri = validated_skill_uri(resource.uri.as_str(), MAX_SKILL_PACKAGE_URI_CHARS)?;
    let meta = resource.meta.as_ref()?.as_object()?;
    let skill_name = normalized_label(meta.get("skill_name")?.as_str()?, MAX_SKILL_NAME_CHARS)?;
    // 根据 source 决定名称格式：user 来源使用纯名称，其他使用 plugin:skill 格式
    let name = if meta.get("source").and_then(|value| value.as_str()) == Some("user") {
        skill_name
    } else {
        let plugin_name =
            normalized_label(meta.get("plugin_name")?.as_str()?, MAX_SKILL_NAME_CHARS)?;
        let qualified_name = format!("{plugin_name}:{skill_name}");
        (qualified_name.chars().count() <= MAX_QUALIFIED_SKILL_NAME_CHARS)
            .then_some(qualified_name)?
    };
    let description = normalized_description(resource.description.as_deref().unwrap_or_default())?;
    let main_prompt = main_prompt_uri(uri);

    Some(
        SkillCatalogEntry::new(
            SkillPackageId(uri.to_string()),
            SkillAuthority::new(SkillSourceKind::Orchestrator, CODEX_APPS_MCP_SERVER_NAME),
            name,
            description,
            SkillResourceId::new(main_prompt),
        )
        .with_display_path(uri),
    )
}

/// 验证 skill URI 格式并返回原始字符串。
fn validated_skill_uri(uri: &str, max_chars: usize) -> Option<&str> {
    validated_skill_url(uri, max_chars).map(|_| uri)
}

/// 验证 skill URL 格式。
///
/// 校验规则：
/// - 字符数不超过上限
/// - 不包含控制字符、空白字符或尖括号
/// - scheme 必须为 `skill`
/// - 必须有非空的 host
/// - 不能有 username、password、port、query、fragment
/// - 路径必须非空且各段非空
fn validated_skill_url(uri: &str, max_chars: usize) -> Option<Url> {
    if uri.chars().count() > max_chars
        || uri
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || matches!(ch, '<' | '>'))
    {
        return None;
    }

    let url = Url::parse(uri).ok()?;
    let path_is_valid = url.path_segments().is_some_and(|segments| {
        let segments = segments.collect::<Vec<_>>();
        !segments.is_empty() && segments.iter().all(|segment| !segment.is_empty())
    });
    (url.scheme() == "skill"
        && url.as_str() == uri
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && path_is_valid)
        .then_some(url)
}

/// 检查 resource URI 是否属于指定 package URI。
///
/// package URI 和 resource URI 必须满足：
/// - scheme 和 host 相同
/// - resource 的路径段以 package 的路径段为前缀
/// - resource 的路径段数大于 package 的路径段数
fn resource_belongs_to_package(package: &str, resource: &str) -> bool {
    let Some(package) = validated_skill_url(package, MAX_SKILL_PACKAGE_URI_CHARS) else {
        return false;
    };
    let Some(resource) = validated_skill_url(resource, MAX_SKILL_RESOURCE_URI_CHARS) else {
        return false;
    };

    let Some(package_segments) = package.path_segments() else {
        return false;
    };
    let Some(resource_segments) = resource.path_segments() else {
        return false;
    };
    let package_segments = package_segments.collect::<Vec<_>>();
    let resource_segments = resource_segments.collect::<Vec<_>>();

    package.scheme() == resource.scheme()
        && package.host_str() == resource.host_str()
        && resource_segments.len() > package_segments.len()
        && resource_segments.starts_with(&package_segments)
}

/// 规范化标签（skill 名称或插件名称）。
///
/// 规则：
/// - 折叠空白字符为单个空格
/// - 长度不超过上限
/// - 不包含控制字符
/// - 不为空
/// - 不包含 `&`、`<`、`>` 字符
fn normalized_label(value: &str, max_chars: usize) -> Option<String> {
    let value = normalized_single_line(value, max_chars)?;
    let invalid = value.is_empty() || value.chars().any(|ch| matches!(ch, '&' | '<' | '>'));
    (!invalid).then_some(value)
}

/// 规范化描述文本。
///
/// 规则：
/// - 折叠空白字符为单个空格
/// - 不包含控制字符
/// - 对 `&`、`<`、`>` 进行 HTML 转义
fn normalized_description(value: &str) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().any(char::is_control) {
        return None;
    }

    Some(
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;"),
    )
}

/// 规范化单行文本。
///
/// 折叠空白字符为单个空格，检查长度和控制字符。
fn normalized_single_line(value: &str, max_chars: usize) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let valid = value.chars().count() <= max_chars && !value.chars().any(char::is_control);
    valid.then_some(value)
}

/// 构建 package URI 对应的主 prompt resource URI。
///
/// 格式：`{package_uri}/SKILL.md`
fn main_prompt_uri(package_uri: &str) -> String {
    format!("{}/SKILL.md", package_uri.trim_end_matches('/'))
}

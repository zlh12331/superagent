//! skills/list 工具模块。
//!
//! 该模块实现了 `skills/list` 工具，用于列出指定 authority 拥有的可用 skills。
//! 当前仅支持 orchestrator authority。
//!
//! 返回结果包含每个 skill 的 authority、package、name、description 和 main_resource，
//! 以及发现过程中产生的警告信息（数量和大小受限）。

use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolExecutorFuture;
use codex_extension_api::ToolName;
use codex_extension_api::ToolSpec;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

use crate::catalog::SkillCatalogEntry;
use crate::render::truncate_catalog_skill_description;
use crate::render::truncate_utf8_to_bytes;

use super::MAX_HANDLE_BYTES;
use super::SkillToolAuthority;
use super::SkillToolContext;
use super::external_json_output;
use super::is_bounded_handle;
use super::parse_args;
use super::skill_function_tool;
use super::skill_tool_name;

/// 工具名称
const TOOL_NAME: &str = "list";
/// 最大警告数量
const MAX_WARNINGS: usize = 4;
/// 每条警告的最大字节数
const MAX_WARNING_BYTES: usize = 256;

/// list 工具的输入参数。
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    /// 要列出的 authority
    authority: SkillToolAuthority,
}

/// list 工具返回的单个 skill 信息。
#[derive(Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(deny_unknown_fields)]
struct ListedSkill {
    /// skill 所属 authority
    authority: SkillToolAuthority,
    /// skill 的 package 标识
    package: String,
    /// skill 名称
    name: String,
    /// skill 描述（已截断）
    description: String,
    /// skill 的主 resource 标识
    main_resource: String,
}

/// list 工具的响应。
#[derive(Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(deny_unknown_fields)]
struct ListResponse {
    /// 可用 skill 列表
    skills: Vec<ListedSkill>,
    /// 发现过程中的警告
    warnings: Vec<String>,
}

/// skills/list 工具实现。
#[derive(Clone)]
pub(super) struct ListTool {
    /// 共享的工具上下文
    pub(super) context: SkillToolContext,
}

impl ToolExecutor<ToolCall> for ListTool {
    fn tool_name(&self) -> ToolName {
        skill_tool_name(TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        skill_function_tool::<ListArgs, ListResponse>(
            TOOL_NAME,
            "List enabled skills owned by the requested authority. Only orchestrator-owned skills are currently supported. Returns the opaque package and main-resource handles required by skills.read.",
        )
    }

    /// 处理 list 工具调用。
    ///
    /// 流程：
    /// 1. 解析输入参数获取 authority
    /// 2. 通过上下文获取 catalog 快照
    /// 3. 过滤启用且 authority 匹配的条目
    /// 4. 将条目转换为 `ListedSkill`（验证 handle 边界）
    /// 5. 截断警告数量和大小
    fn handle(&self, call: ToolCall) -> ToolExecutorFuture<'_> {
        Box::pin(async move {
            let args: ListArgs = parse_args(&call)?;
            let authority = args.authority.into_authority();
            let catalog = self.context.catalog(&call.turn_id, args.authority).await;
            let response = ListResponse {
                skills: catalog
                    .entries
                    .into_iter()
                    .filter(|entry| entry.enabled && entry.authority == authority)
                    .filter_map(listed_skill)
                    .collect(),
                warnings: bounded_warnings(catalog.warnings),
            };

            external_json_output(&response)
        })
    }
}

/// 将 catalog 条目转换为 `ListedSkill`。
///
/// 验证 package id 和 main_prompt 的 handle 边界，超限的条目被过滤。
fn listed_skill(entry: SkillCatalogEntry) -> Option<ListedSkill> {
    let authority = SkillToolAuthority::from_authority(&entry.authority)?;
    if !is_bounded_handle(&entry.id.0, MAX_HANDLE_BYTES)
        || !is_bounded_handle(entry.main_prompt.as_str(), MAX_HANDLE_BYTES)
    {
        return None;
    }

    Some(ListedSkill {
        authority,
        package: entry.id.0,
        name: entry.name,
        description: truncate_catalog_skill_description(&entry.description).into_owned(),
        main_resource: entry.main_prompt.as_str().to_string(),
    })
}

/// 限制警告数量和每条警告的大小。
fn bounded_warnings(warnings: Vec<String>) -> Vec<String> {
    warnings
        .into_iter()
        .take(MAX_WARNINGS)
        .map(|warning| {
            let (warning, _) = truncate_utf8_to_bytes(&warning, MAX_WARNING_BYTES);
            warning
        })
        .collect()
}

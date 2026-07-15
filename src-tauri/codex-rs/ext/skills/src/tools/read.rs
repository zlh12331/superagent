//! skills/read 工具模块。
//!
//! 该模块实现了 `skills/read` 工具，用于读取指定 skill 的 resource 内容。
//! 调用方需通过 `skills/list` 获取的 package 和 resource 标识进行读取。
//!
//! 安全检查：
//! - package 和 resource 标识必须满足 handle 边界约束
//! - 请求的 package 必须在当前 catalog 中可用
//! - 返回的 resource 必须与请求的 resource 一致

use codex_extension_api::FunctionCallError;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolExecutorFuture;
use codex_extension_api::ToolName;
use codex_extension_api::ToolSpec;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

use crate::catalog::SkillPackageId;
use crate::catalog::SkillResourceId;
use crate::provider::SkillReadRequest;

use super::MAX_HANDLE_BYTES;
use super::SkillToolAuthority;
use super::SkillToolContext;
use super::external_json_output;
use super::parse_args;
use super::skill_function_tool;
use super::skill_tool_name;
use super::validate_handle;

/// 工具名称
const TOOL_NAME: &str = "read";

/// read 工具的输入参数。
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    /// 要读取的 authority
    authority: SkillToolAuthority,
    /// skill 的 package 标识（来自 list 结果）
    package: String,
    /// resource 标识（来自 list 结果的 main_resource）
    resource: String,
}

/// read 工具的响应。
#[derive(Debug, Eq, JsonSchema, PartialEq, Serialize)]
#[schemars(deny_unknown_fields)]
struct ReadResponse {
    /// 读取的 resource 标识
    resource: String,
    /// resource 的文本内容
    contents: String,
}

/// skills/read 工具实现。
#[derive(Clone)]
pub(super) struct ReadTool {
    /// 共享的工具上下文
    pub(super) context: SkillToolContext,
}

impl ToolExecutor<ToolCall> for ReadTool {
    fn tool_name(&self) -> ToolName {
        skill_tool_name(TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        skill_function_tool::<ReadArgs, ReadResponse>(
            TOOL_NAME,
            "Read one complete resource from an enabled skill. Pass the exact authority and package returned by skills.list; resource identifiers remain opaque and are routed to that authority.",
        )
    }

    /// 处理 read 工具调用。
    ///
    /// 流程：
    /// 1. 解析输入参数并验证 handle 边界
    /// 2. 获取 catalog 快照并验证 package 可用性
    /// 3. 通过 thread 状态读取 skill resource（orchestrator 使用缓存）
    /// 4. 验证返回的 resource 与请求一致
    fn handle(&self, call: ToolCall) -> ToolExecutorFuture<'_> {
        Box::pin(async move {
            let args: ReadArgs = parse_args(&call)?;
            let authority = args.authority.into_authority();
            validate_handle("package", &args.package, MAX_HANDLE_BYTES)?;
            validate_handle("resource", &args.resource, MAX_HANDLE_BYTES)?;

            // 获取 catalog 并验证 package 可用性
            let catalog = self.context.catalog(&call.turn_id, args.authority).await;
            let package_is_available = catalog.entries.iter().any(|entry| {
                entry.enabled && entry.authority == authority && entry.id.0 == args.package
            });
            if !package_is_available {
                return Err(FunctionCallError::RespondToModel(
                    "skill package is not available from the requested authority".to_string(),
                ));
            }

            let requested_resource = SkillResourceId::new(args.resource);
            let result = self
                .context
                .thread_state
                .read_skill(
                    &self.context.providers,
                    SkillReadRequest {
                        authority,
                        package: SkillPackageId(args.package),
                        resource: requested_resource.clone(),
                        host_snapshot: None,
                        mcp_resources: self.context.mcp_resources.clone(),
                    },
                )
                .await
                .map_err(|err| {
                    tracing::warn!(
                        error = %err,
                        turn_id = %call.turn_id,
                        call_id = %call.call_id,
                        resource = requested_resource.as_str(),
                        "skills.read provider request failed"
                    );
                    FunctionCallError::RespondToModel("failed to read skill resource".to_string())
                })?;
            // 验证返回的 resource 与请求一致（防止 provider 返回错误 resource）
            if result.resource != requested_resource {
                return Err(FunctionCallError::Fatal(
                    "skill provider returned a different resource".to_string(),
                ));
            }

            external_json_output(&ReadResponse {
                resource: result.resource.as_str().to_string(),
                contents: result.contents,
            })
        })
    }
}

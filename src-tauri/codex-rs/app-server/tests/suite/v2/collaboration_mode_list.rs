//! 验证 collaboration mode 列表端点是否返回预期的默认预设集合。
//!
//! 本测试通过 MCP harness 驱动 app server，并断言列表响应中包含 plan 和
//! default 两种模式，从而在一处集中维护该 API 契约，便于回归跟踪。

#![allow(clippy::unwrap_used)]

use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use codex_app_server_protocol::CollaborationModeListParams;
use codex_app_server_protocol::CollaborationModeListResponse;
use codex_app_server_protocol::CollaborationModeMask;
use codex_app_server_protocol::JSONRPCResponse;
use codex_app_server_protocol::RequestId;
use codex_core::test_support::builtin_collaboration_mode_presets;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;

// Bazel CI 在启动 app-server 子进程或在负载下处理 list RPC 时，
// 可能需要数十秒的时间，因此放宽超时上限。
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// 确认 server 以稳定顺序返回默认的 collaboration mode 预设集合。
#[tokio::test]
async fn list_collaboration_modes_returns_presets() -> Result<()> {
    let codex_home = TempDir::new()?;
    let mut mcp = TestAppServer::new(codex_home.path()).await?;

    timeout(DEFAULT_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_list_collaboration_modes_request(CollaborationModeListParams::default())
        .await?;

    let response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;

    let CollaborationModeListResponse { data: items } =
        to_response::<CollaborationModeListResponse>(response)?;

    let expected: Vec<CollaborationModeMask> = builtin_collaboration_mode_presets()
        .into_iter()
        .map(|preset| CollaborationModeMask {
            name: preset.name,
            mode: preset.mode,
            model: preset.model,
            reasoning_effort: preset.reasoning_effort,
        })
        .collect();
    assert_eq!(expected, items);
    Ok(())
}

//! MCP（Model Context Protocol）服务器原型实现。
//!
//! 该 crate 实现了一个基于 stdio 的 MCP 服务器，通过 stdin 读取 JSON-RPC 消息、
//! 经 `MessageProcessor` 处理后，将响应消息写回 stdout。它复用了 codex 的
//! 配置、OTel 遥测与执行服务器（exec-server）能力，使 MCP 客户端能够调用
//! Codex 工具集（如代码执行、补丁审批等）。
#![deny(clippy::print_stdout, clippy::print_stderr)]

use std::io::ErrorKind;
use std::io::Result as IoResult;
use std::sync::Arc;

use codex_arg0::Arg0DispatchPaths;
use codex_core::config::ConfigBuilder;
use codex_core::resolve_installation_id;
use codex_exec_server::EnvironmentManager;
use codex_exec_server::ExecServerRuntimePaths;
use codex_login::default_client::set_default_client_residency_requirement;
use codex_utils_cli::CliConfigOverrides;

use rmcp::model::ClientNotification;
use rmcp::model::ClientRequest;
use rmcp::model::JsonRpcMessage;
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::io::{self};
use tokio::sync::mpsc;
use tracing::debug;
use tracing::error;
use tracing::info;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

mod codex_tool_config;
mod codex_tool_runner;
mod exec_approval;
pub(crate) mod message_processor;
mod outgoing_message;
mod patch_approval;

use crate::message_processor::MessageProcessor;
use crate::outgoing_message::OutgoingJsonRpcMessage;
use crate::outgoing_message::OutgoingMessage;
use crate::outgoing_message::OutgoingMessageSender;

/// Codex 工具调用参数类型。
pub use crate::codex_tool_config::CodexToolCallParam;
/// Codex 工具调用回复参数类型。
pub use crate::codex_tool_config::CodexToolCallReplyParam;
/// 执行审批（exec approval）的 elicitation 请求参数类型。
pub use crate::exec_approval::ExecApprovalElicitRequestParams;
/// 执行审批响应类型。
pub use crate::exec_approval::ExecApprovalResponse;
/// 补丁审批（patch approval）的 elicitation 请求参数类型。
pub use crate::patch_approval::PatchApprovalElicitRequestParams;
/// 补丁审批响应类型。
pub use crate::patch_approval::PatchApprovalResponse;

/// 任务间通信所用的有界 channel 容量。该值在吞吐量与内存占用之间做了平衡
/// ——对于交互式 CLI 来说，128 条消息已经足够。
const CHANNEL_CAPACITY: usize = 128;
const DEFAULT_ANALYTICS_ENABLED: bool = true;
const OTEL_SERVICE_NAME: &str = "codex_mcp_server";

type IncomingMessage = JsonRpcMessage<ClientRequest, Value, ClientNotification>;

/// MCP 服务器主入口函数。
///
/// 完成以下初始化工作：
/// 1. 解析 CLI 配置覆盖项并构建 `Config`；
/// 2. 初始化 OTel 遥测 provider（logs/traces/metrics）；
/// 3. 构建 `EnvironmentManager`（用于执行服务器能力）；
/// 4. 安装 tracing subscriber；
/// 5. 启动三个并发任务：stdin 读取、消息处理、stdout 写入。
///
/// 典型退出路径：stdin 读取到 EOF → `incoming_tx` 被丢弃 → 处理器任务结束 →
/// stdout 写入任务结束。
pub async fn run_main(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    strict_config: bool,
) -> IoResult<()> {
    // 一次性解析 CLI 覆盖项并急切地派生出基础 Config，
    // 这样后续组件无需再处理原始 TOML 值。
    let cli_kv_overrides = cli_config_overrides.parse_overrides().map_err(|e| {
        std::io::Error::new(
            ErrorKind::InvalidInput,
            format!("error parsing -c overrides: {e}"),
        )
    })?;
    let config = ConfigBuilder::default()
        .cli_overrides(cli_kv_overrides)
        .strict_config(strict_config)
        .build()
        .await
        .map_err(|e| {
            std::io::Error::new(ErrorKind::InvalidData, format!("error loading config: {e}"))
        })?;
    set_default_client_residency_requirement(config.enforce_residency.value());
    let otel = codex_core::otel_init::build_provider(
        &config,
        env!("CARGO_PKG_VERSION"),
        Some(OTEL_SERVICE_NAME),
        DEFAULT_ANALYTICS_ENABLED,
    )
    .map_err(|e| {
        std::io::Error::new(
            ErrorKind::InvalidData,
            format!("error loading otel config: {e}"),
        )
    })?;
    codex_core::otel_init::record_process_start(otel.as_ref(), OTEL_SERVICE_NAME);
    codex_core::otel_init::install_sqlite_telemetry(otel.as_ref(), OTEL_SERVICE_NAME);
    let state_db = codex_core::init_state_db(&config).await;
    let environment_manager = Arc::new(
        EnvironmentManager::from_codex_home(
            config.codex_home.clone(),
            Some(ExecServerRuntimePaths::from_optional_paths(
                arg0_paths.codex_self_exe.clone(),
                arg0_paths.codex_linux_sandbox_exe.clone(),
            )?),
        )
        .await
        .map_err(std::io::Error::other)?,
    );

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(EnvFilter::from_default_env());
    let otel_logger_layer = otel.as_ref().and_then(|provider| provider.logger_layer());
    let otel_tracing_layer = otel.as_ref().and_then(|provider| provider.tracing_layer());

    let _ = tracing_subscriber::registry()
        .with(fmt_layer)
        .with(otel_logger_layer)
        .with(otel_tracing_layer)
        .try_init();

    // 建立 channel。
    let (incoming_tx, mut incoming_rx) = mpsc::channel::<IncomingMessage>(CHANNEL_CAPACITY);
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<OutgoingMessage>();
    let installation_id = resolve_installation_id(&config.codex_home).await?;

    // 任务：从 stdin 读取消息，推入 `incoming_tx`。
    let stdin_reader_handle = tokio::spawn({
        async move {
            let stdin = io::stdin();
            let reader = BufReader::new(stdin);
            let mut lines = reader.lines();

            while let Some(line) = lines.next_line().await.unwrap_or_default() {
                match serde_json::from_str::<IncomingMessage>(&line) {
                    Ok(msg) => {
                        if incoming_tx.send(msg).await.is_err() {
                            // 接收端已关闭——无事可做。
                            break;
                        }
                    }
                    Err(e) => error!("Failed to deserialize JSON-RPC message: {e}"),
                }
            }

            debug!("stdin reader finished (EOF)");
        }
    });

    // 任务：处理接收到的消息。
    let processor_handle = tokio::spawn({
        let outgoing_message_sender = OutgoingMessageSender::new(outgoing_tx);
        let mut processor = MessageProcessor::new(
            outgoing_message_sender,
            arg0_paths,
            Arc::new(config),
            environment_manager,
            state_db,
            installation_id,
        )
        .await;
        async move {
            while let Some(msg) = incoming_rx.recv().await {
                match msg {
                    JsonRpcMessage::Request(r) => processor.process_request(r).await,
                    JsonRpcMessage::Response(r) => processor.process_response(r).await,
                    JsonRpcMessage::Notification(n) => processor.process_notification(n).await,
                    JsonRpcMessage::Error(e) => processor.process_error(e),
                }
            }

            info!("processor task exited (channel closed)");
        }
    });

    // 任务：将输出消息写入 stdout。
    let stdout_writer_handle = tokio::spawn(async move {
        let mut stdout = io::stdout();
        while let Some(outgoing_message) = outgoing_rx.recv().await {
            let msg: OutgoingJsonRpcMessage = outgoing_message.into();
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if let Err(e) = stdout.write_all(json.as_bytes()).await {
                        error!("Failed to write to stdout: {e}");
                        break;
                    }
                    if let Err(e) = stdout.write_all(b"\n").await {
                        error!("Failed to write newline to stdout: {e}");
                        break;
                    }
                }
                Err(e) => error!("Failed to serialize JSON-RPC message: {e}"),
            }
        }

        info!("stdout writer exited (channel closed)");
    });

    // 等待所有任务结束。典型退出路径：stdin 读取器遇到 EOF，
    // 在丢弃 `incoming_tx` 后将关闭信号传播给处理器，再传播给 stdout 任务。
    let _ = tokio::join!(stdin_reader_handle, processor_handle, stdout_writer_handle);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_config::types::OtelExporterKind;
    use codex_core::config::ConfigBuilder;
    use pretty_assertions::assert_eq;
    use std::collections::HashMap;
    use tempfile::TempDir;

    #[test]
    fn mcp_server_defaults_analytics_to_enabled() {
        assert_eq!(DEFAULT_ANALYTICS_ENABLED, true);
    }

    #[tokio::test]
    async fn mcp_server_builds_otel_provider_with_logs_traces_and_metrics() -> anyhow::Result<()> {
        let codex_home = TempDir::new()?;
        let mut config = ConfigBuilder::default()
            .codex_home(codex_home.path().to_path_buf())
            .build()
            .await?;
        let exporter = OtelExporterKind::OtlpGrpc {
            endpoint: "http://localhost:4317".to_string(),
            headers: HashMap::new(),
            tls: None,
        };
        config.otel.exporter = exporter.clone();
        config.otel.trace_exporter = exporter.clone();
        config.otel.metrics_exporter = exporter;
        config.analytics_enabled = None;

        let provider = codex_core::otel_init::build_provider(
            &config,
            "0.0.0-test",
            Some(OTEL_SERVICE_NAME),
            DEFAULT_ANALYTICS_ENABLED,
        )
        .map_err(|err| anyhow::anyhow!(err.to_string()))?
        .expect("otel provider");

        assert!(provider.logger.is_some(), "expected log exporter");
        assert!(
            provider.tracer_provider.is_some(),
            "expected trace exporter"
        );
        assert!(provider.metrics().is_some(), "expected metrics exporter");
        provider.shutdown();

        Ok(())
    }
}

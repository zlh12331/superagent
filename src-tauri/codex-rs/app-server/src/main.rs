use clap::Parser;
use codex_app_server::AppServerRuntimeOptions;
use codex_app_server::AppServerTransport;
use codex_app_server::AppServerWebsocketAuthArgs;
use codex_app_server::PluginStartupTasks;
use codex_app_server::run_main_with_transport_options;
use codex_arg0::Arg0DispatchPaths;
use codex_arg0::arg0_dispatch_or_else;
use codex_config::LoaderOverrides;
use codex_protocol::protocol::SessionSource;
use codex_utils_cli::CliConfigOverrides;
use std::path::PathBuf;

// 仅 debug 构建可用的测试钩子：允许集成测试将服务器指向一个临时托管配置文件，
// 而无需写入 /etc 系统目录。
const MANAGED_CONFIG_PATH_ENV_VAR: &str = "CODEX_APP_SERVER_MANAGED_CONFIG_PATH";
const DISABLE_MANAGED_CONFIG_ENV_VAR: &str = "CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG";

/// app-server 二进制入口的命令行参数。
///
/// 通过 `clap` 解析，包含传输方式、会话来源、认证、配置严格度等选项。
/// 部分字段仅在 debug 构建中可用，供集成测试使用。
#[derive(Debug, Parser)]
#[command(version)]
struct AppServerArgs {
    #[command(flatten)]
    config_overrides: CliConfigOverrides,

    /// 传输端点 URL。支持值：`stdio://`（默认）、`unix://`、`unix://PATH`、
    /// `ws://IP:PORT`、`off`。
    #[arg(
        long = "listen",
        value_name = "URL",
        default_value = AppServerTransport::DEFAULT_LISTEN_URL
    )]
    listen: AppServerTransport,

    /// 会话来源，用于派生产品限制与元数据。
    #[arg(
        long = "session-source",
        value_name = "SOURCE",
        default_value = "vscode",
        value_parser = SessionSource::from_startup_arg
    )]
    session_source: SessionSource,

    #[command(flatten)]
    auth: AppServerWebsocketAuthArgs,

    /// 当 config.toml 包含未知配置字段时直接报错退出。
    #[arg(long = "strict-config", default_value_t = false)]
    strict_config: bool,

    /// 隐藏的 debug-only 测试钩子，供启动生产 app-server 二进制的集成测试使用。
    #[cfg(debug_assertions)]
    #[arg(long = "disable-plugin-startup-tasks-for-tests", hide = true)]
    disable_plugin_startup_tasks_for_tests: bool,

    /// 为当前 app-server 进程启用远程控制，但不修改持久化设置。
    #[arg(long = "remote-control", hide = true)]
    remote_control: bool,
}

fn main() -> anyhow::Result<()> {
    let remote_control_disabled = codex_app_server::take_remote_control_disabled_env();
    arg0_dispatch_or_else(move |arg0_paths: Arg0DispatchPaths| async move {
        let AppServerArgs {
            config_overrides,
            listen,
            session_source,
            auth,
            strict_config,
            #[cfg(debug_assertions)]
            disable_plugin_startup_tasks_for_tests,
            remote_control,
        } = AppServerArgs::parse();
        // 根据 debug-only 环境变量决定托管配置策略：完全禁用或指向自定义路径。
        let loader_overrides = if disable_managed_config_from_debug_env() {
            LoaderOverrides::without_managed_config_for_tests()
        } else {
            managed_config_path_from_debug_env()
                .map(LoaderOverrides::with_managed_config_path_for_tests)
                .unwrap_or_default()
        };
        let transport = listen;
        let auth = auth.try_into_settings()?;
        let mut runtime_options = AppServerRuntimeOptions::default();
        #[cfg(debug_assertions)]
        if disable_plugin_startup_tasks_for_tests {
            runtime_options.plugin_startup_tasks = PluginStartupTasks::Skip;
        }
        // 综合 --remote-control 命令行参数与禁用环境变量决定远程控制启动模式。
        runtime_options.remote_control_startup_mode =
            match (remote_control, remote_control_disabled) {
                (true, _) => codex_app_server::RemoteControlStartupMode::EnabledEphemeral,
                (false, true) => codex_app_server::RemoteControlStartupMode::DisabledEphemeral,
                (false, false) => codex_app_server::RemoteControlStartupMode::ResolvePersisted,
            };

        run_main_with_transport_options(
            arg0_paths,
            config_overrides,
            loader_overrides,
            strict_config,
            /*default_analytics_enabled*/ false,
            transport,
            session_source,
            auth,
            runtime_options,
        )
        .await?;
        Ok(())
    })
}

/// 读取 debug-only 环境变量判断是否禁用托管配置。
///
/// 仅在 debug 构建生效；release 构建始终返回 `false`。
fn disable_managed_config_from_debug_env() -> bool {
    #[cfg(debug_assertions)]
    {
        if let Ok(value) = std::env::var(DISABLE_MANAGED_CONFIG_ENV_VAR) {
            return matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES");
        }
    }

    false
}

/// 读取 debug-only 环境变量获取自定义托管配置路径。
///
/// 仅在 debug 构建生效；release 构建始终返回 `None`。
fn managed_config_path_from_debug_env() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if let Ok(value) = std::env::var(MANAGED_CONFIG_PATH_ENV_VAR) {
            return if value.is_empty() {
                None
            } else {
                Some(PathBuf::from(value))
            };
        }
    }

    None
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;

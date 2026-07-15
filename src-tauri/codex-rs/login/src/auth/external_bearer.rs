//! 外部 bearer token 刷新器。
//!
//! 当模型 provider 配置了自定义认证命令时，[`BearerTokenRefresher`] 负责：
//! - 执行 provider 配置的认证命令获取 access token。
//! - 在内存中缓存 token 直到刷新间隔过期。
//! - 收到 401 时通过 [`ExternalAuth`] trait 触发刷新。
//!
//! 这使得自定义 provider 可以通过外部脚本（如 `op signin`、`vault kv get` 等）
//! 动态提供 bearer token，而无需修改 Codex 核心代码。

use super::manager::ExternalAuth;
use super::manager::ExternalAuthFuture;
use super::manager::ExternalAuthRefreshContext;
use super::manager::ExternalAuthTokens;
use codex_protocol::auth::AuthMode;
use codex_protocol::config_types::ModelProviderAuthInfo;
use std::fmt;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tokio::process::Command;
use tokio::sync::Mutex;

/// 外部 bearer token 刷新器，实现 [`ExternalAuth`] trait。
///
/// 内部通过 [`Arc<ExternalBearerAuthState>`] 共享状态，
/// 因此克隆是廉价的，可在多个调用点共享同一缓存。
#[derive(Clone)]
pub(crate) struct BearerTokenRefresher {
    state: Arc<ExternalBearerAuthState>,
}

impl BearerTokenRefresher {
    /// 创建一个新的刷新器。
    ///
    /// 参数：
    /// - `config`：模型 provider 的认证配置（命令、参数、超时等）。
    pub(crate) fn new(config: ModelProviderAuthInfo) -> Self {
        Self {
            state: Arc::new(ExternalBearerAuthState::new(config)),
        }
    }

    /// 尝试从缓存或执行认证命令获取 access token。
    ///
    /// 若缓存 token 仍在刷新间隔内，直接返回缓存值；
    /// 否则执行认证命令获取新 token 并更新缓存。
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "external bearer cache misses intentionally hold cached_token across the provider command to avoid duplicate refreshes"
    )]
    async fn resolve(&self) -> io::Result<Option<ExternalAuthTokens>> {
        let access_token = {
            let mut cached = self.state.cached_token.lock().await;
            if let Some(cached_token) = cached.as_ref() {
                let should_use_cached_token = match self.state.config.refresh_interval() {
                    Some(refresh_interval) => cached_token.fetched_at.elapsed() < refresh_interval,
                    None => true,
                };
                if should_use_cached_token {
                    return Ok(Some(ExternalAuthTokens::access_token_only(
                        cached_token.access_token.clone(),
                    )));
                }
            }

            let access_token = run_provider_auth_command(&self.state.config).await?;
            *cached = Some(CachedExternalBearerToken {
                access_token: access_token.clone(),
                fetched_at: Instant::now(),
            });
            access_token
        };
        Ok(Some(ExternalAuthTokens::access_token_only(access_token)))
    }

    /// 强制刷新 access token（忽略缓存）。
    async fn refresh(
        &self,
        _context: ExternalAuthRefreshContext,
    ) -> io::Result<ExternalAuthTokens> {
        let access_token = run_provider_auth_command(&self.state.config).await?;
        let mut cached = self.state.cached_token.lock().await;
        *cached = Some(CachedExternalBearerToken {
            access_token: access_token.clone(),
            fetched_at: Instant::now(),
        });
        Ok(ExternalAuthTokens::access_token_only(access_token))
    }
}

impl ExternalAuth for BearerTokenRefresher {
    fn auth_mode(&self) -> AuthMode {
        AuthMode::ApiKey
    }

    fn resolve(&self) -> ExternalAuthFuture<'_, Option<ExternalAuthTokens>> {
        Box::pin(BearerTokenRefresher::resolve(self))
    }

    fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> ExternalAuthFuture<'_, ExternalAuthTokens> {
        Box::pin(BearerTokenRefresher::refresh(self, context))
    }
}

impl fmt::Debug for BearerTokenRefresher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BearerTokenRefresher")
            .finish_non_exhaustive()
    }
}

/// 刷新器的共享内部状态。
struct ExternalBearerAuthState {
    /// provider 认证配置。
    config: ModelProviderAuthInfo,
    /// 内存中缓存的 token（含获取时间）。
    cached_token: Mutex<Option<CachedExternalBearerToken>>,
}

impl ExternalBearerAuthState {
    fn new(config: ModelProviderAuthInfo) -> Self {
        Self {
            config,
            cached_token: Mutex::new(None),
        }
    }
}

/// 缓存的外部 bearer token 及其获取时间。
struct CachedExternalBearerToken {
    /// access token 字符串。
    access_token: String,
    /// token 获取时刻，用于判断是否过期。
    fetched_at: Instant,
}

/// 执行 provider 配置的认证命令并返回 access token。
///
/// 命令的 stdout 第一行（去除首尾空白）作为 access token 返回。
/// 命令失败、超时或输出为空均返回错误。
async fn run_provider_auth_command(config: &ModelProviderAuthInfo) -> io::Result<String> {
    let program = resolve_provider_auth_program(&config.command, &config.cwd)?;
    let mut command = Command::new(&program);
    command
        .args(&config.args)
        .current_dir(config.cwd.as_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(config.timeout(), command.output())
        .await
        .map_err(|_| {
            io::Error::other(format!(
                "provider auth command `{}` timed out after {} ms",
                config.command,
                config.timeout_ms.get()
            ))
        })?
        .map_err(|err| {
            io::Error::other(format!(
                "provider auth command `{}` failed to start: {err}",
                config.command
            ))
        })?;

    if !output.status.success() {
        let status = output.status;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stderr_suffix = if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        };
        return Err(io::Error::other(format!(
            "provider auth command `{}` exited with status {status}{stderr_suffix}",
            config.command
        )));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        io::Error::other(format!(
            "provider auth command `{}` wrote non-UTF-8 data to stdout",
            config.command
        ))
    })?;
    let access_token = stdout.trim().to_string();
    if access_token.is_empty() {
        return Err(io::Error::other(format!(
            "provider auth command `{}` produced an empty token",
            config.command
        )));
    }

    Ok(access_token)
}

/// 解析 provider 认证命令的可执行程序路径。
///
/// - 绝对路径：直接返回。
/// - 相对路径（含多级）：相对于 cwd 解析。
/// - 单独命令名：交由系统 PATH 查找。
fn resolve_provider_auth_program(command: &str, cwd: &Path) -> io::Result<PathBuf> {
    let path = Path::new(command);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    if path.components().count() > 1 {
        return Ok(cwd.join(path));
    }

    Ok(PathBuf::from(command))
}

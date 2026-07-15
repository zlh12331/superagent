//! OAuth 设备码（device code）授权流程实现。
//!
//! 适用于无浏览器或输入受限的终端环境：
//! 1. 向认证服务器请求用户码与轮询间隔。
//! 2. 提示用户在浏览器中访问验证 URL 并输入用户码。
//! 3. 客户端按固定间隔轮询令牌端点，直到用户完成授权或超时。
//! 4. 收到授权码后通过 PKCE 交换为 OAuth 令牌并持久化。

use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use serde::de::Deserializer;
use serde::de::{self};
use std::time::Duration;
use std::time::Instant;

use crate::default_client::build_raw_auth_reqwest_client;
use crate::pkce::PkceCodes;
use crate::server::ServerOptions;
use std::io;

/// 终端蓝色 ANSI 转义序列，用于突出显示关键信息。
const ANSI_BLUE: &str = "\x1b[94m";
/// 终端灰色 ANSI 转义序列，用于次要信息。
const ANSI_GRAY: &str = "\x1b[90m";
/// 终端颜色重置 ANSI 转义序列。
const ANSI_RESET: &str = "\x1b[0m";

/// 设备码授权流程中返回给调用方的设备码信息。
///
/// 由 [`request_device_code`] 生成，需配合 [`complete_device_code_login`] 完成登录。
#[derive(Debug, Clone)]
pub struct DeviceCode {
    /// 用户在浏览器中访问的验证 URL。
    pub verification_url: String,
    /// 用户在验证页面输入的一次性代码。
    pub user_code: String,
    /// 认证服务器分配的设备授权 ID，用于后续轮询。
    device_auth_id: String,
    /// 轮询令牌端点的时间间隔（秒）。
    interval: u64,
}

#[derive(Deserialize)]
struct UserCodeResp {
    device_auth_id: String,
    #[serde(alias = "user_code", alias = "usercode")]
    user_code: String,
    #[serde(default, deserialize_with = "deserialize_interval")]
    interval: u64,
}

#[derive(Serialize)]
struct UserCodeReq {
    client_id: String,
}

#[derive(Serialize)]
struct TokenPollReq {
    device_auth_id: String,
    user_code: String,
}

/// 将字符串形式的轮询间隔解析为 u64。
fn deserialize_interval<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    s.trim().parse::<u64>().map_err(de::Error::custom)
}

#[derive(Deserialize)]
struct CodeSuccessResp {
    authorization_code: String,
    code_challenge: String,
    code_verifier: String,
}

/// 请求用户码与轮询间隔。
///
/// 参数：
/// - `client`：HTTP 客户端。
/// - `auth_base_url`：认证 API 基础 URL。
/// - `client_id`：OAuth 客户端 ID。
async fn request_user_code(
    client: &reqwest::Client,
    auth_base_url: &str,
    client_id: &str,
) -> std::io::Result<UserCodeResp> {
    let url = format!("{auth_base_url}/deviceauth/usercode");
    let body = serde_json::to_string(&UserCodeReq {
        client_id: client_id.to_string(),
    })
    .map_err(std::io::Error::other)?;
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(std::io::Error::other)?;

    if !resp.status().is_success() {
        let status = resp.status();
        if status == StatusCode::NOT_FOUND {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "device code login is not enabled for this Codex server. Use the browser login or verify the server URL.",
            ));
        }

        return Err(std::io::Error::other(format!(
            "device code request failed with status {status}"
        )));
    }

    let body = resp.text().await.map_err(std::io::Error::other)?;
    serde_json::from_str(&body).map_err(std::io::Error::other)
}

/// 轮询令牌端点直到获得授权码或超时（15 分钟）。
///
/// 参数：
/// - `client`：HTTP 客户端。
/// - `auth_base_url`：认证 API 基础 URL。
/// - `device_auth_id`：设备授权 ID。
/// - `user_code`：用户码。
/// - `interval`：轮询间隔（秒）。
async fn poll_for_token(
    client: &reqwest::Client,
    auth_base_url: &str,
    device_auth_id: &str,
    user_code: &str,
    interval: u64,
) -> std::io::Result<CodeSuccessResp> {
    let url = format!("{auth_base_url}/deviceauth/token");
    let max_wait = Duration::from_secs(15 * 60);
    let start = Instant::now();

    loop {
        let body = serde_json::to_string(&TokenPollReq {
            device_auth_id: device_auth_id.to_string(),
            user_code: user_code.to_string(),
        })
        .map_err(std::io::Error::other)?;
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(std::io::Error::other)?;

        let status = resp.status();

        if status.is_success() {
            return resp.json().await.map_err(std::io::Error::other);
        }

        // 403 / 404 表示用户尚未完成授权，继续轮询。
        if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
            if start.elapsed() >= max_wait {
                return Err(std::io::Error::other(
                    "device auth timed out after 15 minutes",
                ));
            }
            let sleep_for = Duration::from_secs(interval).min(max_wait - start.elapsed());
            tokio::time::sleep(sleep_for).await;
            continue;
        }

        return Err(std::io::Error::other(format!(
            "device auth failed with status {}",
            resp.status()
        )));
    }
}

/// 在终端打印设备码登录提示，引导用户完成授权。
fn print_device_code_prompt(verification_url: &str, code: &str) {
    let version = env!("CARGO_PKG_VERSION");
    println!(
        "\nWelcome to Codex [v{ANSI_GRAY}{version}{ANSI_RESET}]\n{ANSI_GRAY}OpenAI's command-line coding agent{ANSI_RESET}\n\
\nFollow these steps to sign in with ChatGPT using device code authorization:\n\
\n1. Open this link in your browser and sign in to your account\n   {ANSI_BLUE}{verification_url}{ANSI_RESET}\n\
\n2. Enter this one-time code {ANSI_GRAY}(expires in 15 minutes){ANSI_RESET}\n   {ANSI_BLUE}{code}{ANSI_RESET}\n\
\n{ANSI_GRAY}Device codes are a common phishing target. Never share this code.{ANSI_RESET}\n",
    );
}

/// 向认证服务器请求设备码。
///
/// 参数：
/// - `opts`：登录服务器配置（包含 issuer、client_id 等）。
///
/// 返回值：
/// - `Ok(DeviceCode)`：成功获取设备码，等待用户授权。
/// - `Err`：请求失败或服务器不支持设备码登录。
pub async fn request_device_code(opts: &ServerOptions) -> std::io::Result<DeviceCode> {
    let base_url = opts.issuer.trim_end_matches('/');
    // issuer 选定的路由会复用到所有 device-auth 端点路径上，端点路径不会单独解析。
    let client = build_raw_auth_reqwest_client(base_url, opts.auth_route_config.as_ref())?;
    let api_base_url = format!("{base_url}/api/accounts");
    let uc = request_user_code(&client, &api_base_url, &opts.client_id).await?;

    Ok(DeviceCode {
        verification_url: format!("{base_url}/codex/device"),
        user_code: uc.user_code,
        device_auth_id: uc.device_auth_id,
        interval: uc.interval,
    })
}

/// 完成设备码登录流程。
///
/// 轮询令牌端点获取授权码，然后通过 PKCE 交换为 OAuth 令牌并持久化。
///
/// 参数：
/// - `opts`：登录服务器配置。
/// - `device_code`：由 [`request_device_code`] 返回的设备码。
pub async fn complete_device_code_login(
    opts: ServerOptions,
    device_code: DeviceCode,
) -> std::io::Result<()> {
    let base_url = opts.issuer.trim_end_matches('/');
    let client = build_raw_auth_reqwest_client(base_url, opts.auth_route_config.as_ref())?;
    let api_base_url = format!("{base_url}/api/accounts");

    let code_resp = poll_for_token(
        &client,
        &api_base_url,
        &device_code.device_auth_id,
        &device_code.user_code,
        device_code.interval,
    )
    .await?;

    let pkce = PkceCodes {
        code_verifier: code_resp.code_verifier,
        code_challenge: code_resp.code_challenge,
    };
    let redirect_uri = format!("{base_url}/deviceauth/callback");

    let tokens = crate::server::exchange_code_for_tokens(
        base_url,
        &opts.client_id,
        &redirect_uri,
        &pkce,
        &code_resp.authorization_code,
        opts.auth_route_config.as_ref(),
    )
    .await
    .map_err(|err| std::io::Error::other(format!("device code exchange failed: {err}")))?;

    if let Err(message) = crate::server::ensure_workspace_allowed(
        opts.forced_chatgpt_workspace_id.as_deref(),
        &tokens.id_token,
    ) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, message));
    }

    crate::server::persist_tokens_async(
        &opts.codex_home,
        /*api_key*/ None,
        tokens.id_token,
        tokens.access_token,
        tokens.refresh_token,
        opts.cli_auth_credentials_store_mode,
        opts.auth_keyring_backend_kind,
    )
    .await
}

/// 运行完整的设备码登录流程。
///
/// 依次执行：请求设备码 -> 打印提示 -> 轮询并完成令牌交换与持久化。
///
/// 参数：
/// - `opts`：登录服务器配置。
pub async fn run_device_code_login(opts: ServerOptions) -> std::io::Result<()> {
    let device_code = request_device_code(&opts).await?;
    print_device_code_prompt(&device_code.verification_url, &device_code.user_code);
    complete_device_code_login(opts, device_code).await
}

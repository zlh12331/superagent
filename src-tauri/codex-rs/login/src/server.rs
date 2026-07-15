//! CLI 登录使用的本地 OAuth 回调服务器。
//!
//! 本模块运行交互式登录所用的短暂 localhost 服务器。
//!
//! 回调流程承担两类相互竞争的职责：
//!
//! - 保留足够的 backend 与传输层细节，便于开发者、系统管理员和支持工程师诊断登录失败原因
//! - 避免将 secrets 或敏感 URL/query 数据写入常规应用日志
//!
//! 因此本模块将面向用户的错误路径与结构化日志路径分开处理。返回的 `io::Error` 仍携带
//! CLI/浏览器调用方所需的细节，而结构化日志仅输出经过审核的字段以及已脱敏的 URL/错误值。
use std::io::Cursor;
use std::io::Read;
use std::io::Write;
use std::io::{self};
use std::net::SocketAddr;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::thread;
use std::time::Duration;

use crate::auth::AuthDotJson;
use crate::auth::AuthKeyringBackendKind;
use crate::auth::save_auth;
use crate::default_client::build_raw_auth_reqwest_client;
use crate::default_client::originator;
use crate::outbound_proxy::AuthRouteConfig;
use crate::pkce::PkceCodes;
use crate::pkce::generate_pkce;
use crate::token_data::TokenData;
use crate::token_data::parse_chatgpt_jwt_claims;
use base64::Engine;
use chrono::Utc;
use codex_config::types::AuthCredentialsStoreMode;
use codex_protocol::auth::AuthMode;
use codex_utils_template::Template;
use rand::RngCore;
use serde_json::Value as JsonValue;
use tiny_http::Header;
use tiny_http::Request;
use tiny_http::Response;
use tiny_http::Server;
use tiny_http::StatusCode;
use tracing::error;
use tracing::info;
use tracing::warn;

const DEFAULT_ISSUER: &str = "https://auth.openai.com";
const DEFAULT_PORT: u16 = 1455;
// 与 Codex CLI Hydra redirect URI allow-list 保持同步。
const FALLBACK_PORT: u16 = 1457;
static LOGIN_ERROR_PAGE_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    Template::parse(include_str!("assets/error.html"))
        .unwrap_or_else(|err| panic!("login error page template must parse: {err}"))
});

/// 启动本地登录回调服务器所需的配置项。
#[derive(Debug, Clone)]
pub struct ServerOptions {
    /// Codex 本地配置根目录（`codex_home`），用于持久化登录凭据。
    pub codex_home: PathBuf,
    /// OAuth client_id，由 Codex CLI 在登录时使用。
    pub client_id: String,
    /// OAuth issuer URL（通常为 `https://auth.openai.com`）。
    pub issuer: String,
    /// 本地回调服务器监听的端口号（默认 1455，失败时回退 1457）。
    pub port: u16,
    /// 是否在启动后自动打开浏览器访问授权 URL。
    pub open_browser: bool,
    /// 可选的强制 `state` 值，用于测试或外部流程注入；为 `None` 时随机生成。
    pub force_state: Option<String>,
    /// 可选的允许 ChatGPT workspace ID 列表，登录 token 必须属于其中之一。
    pub forced_chatgpt_workspace_id: Option<Vec<String>>,
    /// 是否启用 Codex streamlined login 流程（影响 success 页面渲染）。
    pub codex_streamlined_login: bool,
    /// CLI 凭据存储模式（file / keyring 等）。
    pub cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
    /// keyring 后端类型（direct / secrets / auto）。
    pub auth_keyring_backend_kind: AuthKeyringBackendKind,
    /// 出站代理路由配置（可选），影响 auth 请求的网络走向。
    pub auth_route_config: Option<AuthRouteConfig>,
}

impl ServerOptions {
    /// 使用默认 issuer 与默认端口构造一份服务器配置。
    ///
    /// - `codex_home`：Codex 本地配置根目录
    /// - `client_id`：OAuth client_id
    /// - `forced_chatgpt_workspace_id`：可选的 workspace 限制
    /// - `cli_auth_credentials_store_mode`：凭据存储模式
    /// - `auth_keyring_backend_kind`：keyring 后端类型
    /// - `auth_route_config`：出站代理路由配置
    pub fn new(
        codex_home: PathBuf,
        client_id: String,
        forced_chatgpt_workspace_id: Option<Vec<String>>,
        cli_auth_credentials_store_mode: AuthCredentialsStoreMode,
        auth_keyring_backend_kind: AuthKeyringBackendKind,
        auth_route_config: Option<AuthRouteConfig>,
    ) -> Self {
        Self {
            codex_home,
            client_id,
            issuer: DEFAULT_ISSUER.to_string(),
            port: DEFAULT_PORT,
            open_browser: true,
            force_state: None,
            forced_chatgpt_workspace_id,
            codex_streamlined_login: false,
            cli_auth_credentials_store_mode,
            auth_keyring_backend_kind,
            auth_route_config,
        }
    }
}

/// 正在运行的登录回调服务器句柄。
pub struct LoginServer {
    /// 浏览器需访问的授权 URL（包含 PKCE challenge 与 state）。
    pub auth_url: String,
    /// 服务器实际绑定的本地端口（可能与配置不同，因为存在回退逻辑）。
    pub actual_port: u16,
    server_handle: tokio::task::JoinHandle<io::Result<()>>,
    shutdown_handle: ShutdownHandle,
}

impl LoginServer {
    /// 阻塞等待登录回调循环结束。
    ///
    /// 返回回调循环的最终结果：登录成功为 `Ok(())`，否则返回对应的 `io::Error`。
    pub async fn block_until_done(self) -> io::Result<()> {
        self.server_handle
            .await
            .map_err(|err| io::Error::other(format!("login server thread panicked: {err:?}")))?
    }

    /// 请求关闭回调服务器，触发登录循环退出。
    pub fn cancel(&self) {
        self.shutdown_handle.shutdown();
    }

    /// 返回一个可克隆的取消句柄，用于跨任务取消登录服务器。
    pub fn cancel_handle(&self) -> ShutdownHandle {
        self.shutdown_handle.clone()
    }
}

/// 用于通知登录服务器循环退出的句柄。
#[derive(Clone, Debug)]
pub struct ShutdownHandle {
    shutdown_notify: Arc<tokio::sync::Notify>,
}

impl ShutdownHandle {
    /// 通知登录循环终止。
    pub fn shutdown(&self) {
        self.shutdown_notify.notify_one();
    }
}

/// 启动本地回调服务器并返回浏览器授权 URL。
///
/// 流程：
/// 1. 生成 PKCE 与 state；
/// 2. 绑定本地端口（必要时回退到 `FALLBACK_PORT`）；
/// 3. 构造授权 URL，按需打开浏览器；
/// 4. 在独立线程中读取 HTTP 请求并通过 channel 转发到异步任务；
/// 5. 异步任务使用 `tokio::select!` 监听 shutdown 信号或新请求。
pub fn run_login_server(opts: ServerOptions) -> io::Result<LoginServer> {
    let pkce = generate_pkce();
    let state = opts.force_state.clone().unwrap_or_else(generate_state);

    let server = bind_server(opts.port)?;
    let actual_port = match server.server_addr().to_ip() {
        Some(addr) => addr.port(),
        None => {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "Unable to determine the server port",
            ));
        }
    };
    let server = Arc::new(server);

    let redirect_uri = format!("http://localhost:{actual_port}/auth/callback");
    let auth_url = build_authorize_url(
        &opts.issuer,
        &opts.client_id,
        &redirect_uri,
        &pkce,
        &state,
        opts.forced_chatgpt_workspace_id.as_deref(),
    );

    if opts.open_browser {
        let _ = webbrowser::open(&auth_url);
    }

    // 将 server.recv() 的阻塞读取转换为异步 channel。
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Request>(16);
    let _server_handle = {
        let server = server.clone();
        thread::spawn(move || -> io::Result<()> {
            while let Ok(request) = server.recv() {
                match tx.blocking_send(request) {
                    Ok(()) => {}
                    Err(error) => {
                        eprintln!("Failed to send request to channel: {error}");
                        return Err(io::Error::other("Failed to send request to channel"));
                    }
                }
            }
            Ok(())
        })
    };

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let server_handle = {
        let shutdown_notify = shutdown_notify.clone();
        let server = server;
        tokio::spawn(async move {
            let result = loop {
                tokio::select! {
                    _ = shutdown_notify.notified() => {
                        break Err(io::Error::other("Login was not completed"));
                    }
                    maybe_req = rx.recv() => {
                        let Some(req) = maybe_req else {
                            break Err(io::Error::other("Login was not completed"));
                        };

                        let url_raw = req.url().to_string();
                        let response =
                            process_request(&url_raw, &opts, &redirect_uri, &pkce, actual_port, &state).await;

                        let exit_result = match response {
                            HandledRequest::Response(response) => {
                                let _ = tokio::task::spawn_blocking(move || req.respond(response)).await;
                                None
                            }
                            HandledRequest::ResponseAndExit {
                                headers,
                                body,
                                result,
                            } => {
                                let _ = tokio::task::spawn_blocking(move || {
                                    send_response_with_disconnect(req, headers, body)
                                })
                                .await;
                                Some(result)
                            }
                            HandledRequest::RedirectWithHeader(header) => {
                                let redirect = Response::empty(302).with_header(header);
                                let _ = tokio::task::spawn_blocking(move || req.respond(redirect)).await;
                                None
                            }
                        };

                        if let Some(result) = exit_result {
                            break result;
                        }
                    }
                }
            };

            // 确保 server 解除阻塞，使专门循环运行 `server.recv()` 的线程能干净退出。
            server.unblock();
            result
        })
    };

    Ok(LoginServer {
        auth_url,
        actual_port,
        server_handle,
        shutdown_handle: ShutdownHandle { shutdown_notify },
    })
}

/// 回调处理的内部结果枚举。
enum HandledRequest {
    Response(Response<Cursor<Vec<u8>>>),
    RedirectWithHeader(Header),
    ResponseAndExit {
        headers: Vec<Header>,
        body: Vec<u8>,
        result: io::Result<()>,
    },
}

async fn process_request(
    url_raw: &str,
    opts: &ServerOptions,
    redirect_uri: &str,
    pkce: &PkceCodes,
    actual_port: u16,
    state: &str,
) -> HandledRequest {
    let parsed_url = match url::Url::parse(&format!("http://localhost{url_raw}")) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("URL parse error: {e}");
            return HandledRequest::Response(
                Response::from_string("Bad Request").with_status_code(400),
            );
        }
    };
    let path = parsed_url.path().to_string();

    match path.as_str() {
        "/auth/callback" => {
            let params: std::collections::HashMap<String, String> =
                parsed_url.query_pairs().into_owned().collect();
            let has_code = params.get("code").is_some_and(|code| !code.is_empty());
            let has_state = params.get("state").is_some_and(|state| !state.is_empty());
            let has_error = params.get("error").is_some_and(|error| !error.is_empty());
            let state_valid = params.get("state").map(String::as_str) == Some(state);
            info!(
                path = %path,
                has_code,
                has_state,
                has_error,
                state_valid,
                "received login callback"
            );
            if !state_valid {
                warn!(
                    path = %path,
                    has_code,
                    has_state,
                    has_error,
                    "login callback state mismatch"
                );
                return HandledRequest::Response(
                    Response::from_string("State mismatch").with_status_code(400),
                );
            }
            if let Some(error_code) = params.get("error") {
                let error_description = params.get("error_description").map(String::as_str);
                let message = oauth_callback_error_message(error_code, error_description);
                eprintln!("OAuth callback error: {message}");
                warn!(
                    error_code,
                    has_error_description = error_description.is_some_and(|s| !s.trim().is_empty()),
                    "oauth callback returned error"
                );
                return login_error_response(
                    &message,
                    io::ErrorKind::PermissionDenied,
                    Some(error_code),
                    error_description,
                );
            }
            let code = match params.get("code") {
                Some(c) if !c.is_empty() => c.clone(),
                _ => {
                    return login_error_response(
                        "Missing authorization code. Sign-in could not be completed.",
                        io::ErrorKind::InvalidData,
                        Some("missing_authorization_code"),
                        /*error_description*/ None,
                    );
                }
            };

            match exchange_code_for_tokens(
                &opts.issuer,
                &opts.client_id,
                redirect_uri,
                pkce,
                &code,
                opts.auth_route_config.as_ref(),
            )
            .await
            {
                Ok(tokens) => {
                    if let Err(message) = ensure_workspace_allowed(
                        opts.forced_chatgpt_workspace_id.as_deref(),
                        &tokens.id_token,
                    ) {
                        eprintln!("Workspace restriction error: {message}");
                        return login_error_response(
                            &message,
                            io::ErrorKind::PermissionDenied,
                            Some("workspace_restriction"),
                            /*error_description*/ None,
                        );
                    }
                    // 通过 token-exchange 获取 API key 并持久化
                    let api_key = obtain_api_key(
                        &opts.issuer,
                        &opts.client_id,
                        &tokens.id_token,
                        opts.auth_route_config.as_ref(),
                    )
                    .await
                    .ok();
                    if let Err(err) = persist_tokens_async(
                        &opts.codex_home,
                        api_key.clone(),
                        tokens.id_token.clone(),
                        tokens.access_token.clone(),
                        tokens.refresh_token.clone(),
                        opts.cli_auth_credentials_store_mode,
                        opts.auth_keyring_backend_kind,
                    )
                    .await
                    {
                        eprintln!("Persist error: {err}");
                        return login_error_response(
                            "Sign-in completed but credentials could not be saved locally.",
                            io::ErrorKind::Other,
                            Some("persist_failed"),
                            Some(&err.to_string()),
                        );
                    }

                    let success_url = compose_success_url(
                        actual_port,
                        &opts.issuer,
                        &tokens.id_token,
                        &tokens.access_token,
                        opts.codex_streamlined_login,
                    );
                    match tiny_http::Header::from_bytes(&b"Location"[..], success_url.as_bytes()) {
                        Ok(header) => HandledRequest::RedirectWithHeader(header),
                        Err(_) => login_error_response(
                            "Sign-in completed but redirecting back to Codex failed.",
                            io::ErrorKind::Other,
                            Some("redirect_failed"),
                            /*error_description*/ None,
                        ),
                    }
                }
                Err(err) => {
                    eprintln!("Token exchange error: {err}");
                    error!("login callback token exchange failed");
                    login_error_response(
                        &format!("Token exchange failed: {err}"),
                        io::ErrorKind::Other,
                        Some("token_exchange_failed"),
                        /*error_description*/ None,
                    )
                }
            }
        }
        "/success" => {
            let use_streamlined_success = parsed_url
                .query_pairs()
                .any(|(key, value)| key == "codex_streamlined_login" && value == "true");
            let body = if use_streamlined_success {
                include_str!("assets/success.html")
            } else {
                include_str!("assets/success_legacy.html")
            };
            HandledRequest::ResponseAndExit {
                headers: match Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"text/html; charset=utf-8"[..],
                ) {
                    Ok(header) => vec![header],
                    Err(_) => Vec::new(),
                },
                body: body.as_bytes().to_vec(),
                result: Ok(()),
            }
        }
        "/cancel" => HandledRequest::ResponseAndExit {
            headers: Vec::new(),
            body: b"Login cancelled".to_vec(),
            result: Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Login cancelled",
            )),
        },
        _ => HandledRequest::Response(Response::from_string("Not Found").with_status_code(404)),
    }
}

/// tiny_http 会从 `Response` 对象中过滤掉 `Connection` 头部，因此使用
/// `req.respond` 永远不会告知客户端（或库本身）keep-alive socket 应当关闭。
/// 这会导致每条连接的 worker 阻塞在循环中等待更多请求，进而使下一次登录尝试
/// 卡在旧连接上。本辅助函数绕过 tiny_http 的响应机制：直接获取底层 writer，
/// 手动打印 HTTP 响应，并始终追加 `Connection: close`，确保服务端关闭 socket。
/// 理想情况下 tiny_http 应提供控制服务端连接持久化的 API，但事实上并未提供。
fn send_response_with_disconnect(
    req: Request,
    mut headers: Vec<Header>,
    body: Vec<u8>,
) -> io::Result<()> {
    let status = StatusCode(200);
    let mut writer = req.into_writer();
    let reason = status.default_reason_phrase();
    write!(writer, "HTTP/1.1 {} {}\r\n", status.0, reason)?;
    headers.retain(|h| !h.field.equiv("Connection"));
    if let Ok(close_header) = Header::from_bytes(&b"Connection"[..], &b"close"[..]) {
        headers.push(close_header);
    }

    let content_length_value = format!("{}", body.len());
    if let Ok(content_length_header) =
        Header::from_bytes(&b"Content-Length"[..], content_length_value.as_bytes())
    {
        headers.push(content_length_header);
    }

    for header in headers {
        write!(
            writer,
            "{}: {}\r\n",
            header.field.as_str(),
            header.value.as_str()
        )?;
    }

    writer.write_all(b"\r\n")?;
    writer.write_all(&body)?;
    writer.flush()
}

fn build_authorize_url(
    issuer: &str,
    client_id: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
    state: &str,
    forced_chatgpt_workspace_ids: Option<&[String]>,
) -> String {
    let mut query = vec![
        ("response_type".to_string(), "code".to_string()),
        ("client_id".to_string(), client_id.to_string()),
        ("redirect_uri".to_string(), redirect_uri.to_string()),
        (
            "scope".to_string(),
            "openid profile email offline_access api.connectors.read api.connectors.invoke"
                .to_string(),
        ),
        (
            "code_challenge".to_string(),
            pkce.code_challenge.to_string(),
        ),
        ("code_challenge_method".to_string(), "S256".to_string()),
        ("id_token_add_organizations".to_string(), "true".to_string()),
        ("codex_cli_simplified_flow".to_string(), "true".to_string()),
        ("state".to_string(), state.to_string()),
        ("originator".to_string(), originator().value),
    ];
    if let Some(workspace_ids) = forced_chatgpt_workspace_ids {
        query.push(("allowed_workspace_id".to_string(), workspace_ids.join(",")));
    }
    let qs = query
        .into_iter()
        .map(|(k, v)| format!("{k}={}", urlencoding::encode(&v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{issuer}/oauth/authorize?{qs}")
}

fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn send_cancel_request(port: u16) -> io::Result<()> {
    let addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;

    stream.write_all(b"GET /cancel HTTP/1.1\r\n")?;
    stream.write_all(format!("Host: 127.0.0.1:{port}\r\n").as_bytes())?;
    stream.write_all(b"Connection: close\r\n\r\n")?;

    let mut buf = [0u8; 64];
    let _ = stream.read(&mut buf);
    Ok(())
}

fn bind_server(port: u16) -> io::Result<Server> {
    let preferred_bind_address = format!("127.0.0.1:{port}");
    let fallback_bind_address = format!("127.0.0.1:{FALLBACK_PORT}");
    let mut bind_address = preferred_bind_address.clone();
    let mut cancel_attempted = false;
    let mut attempts = 0;
    let mut using_fallback_port = false;
    const MAX_ATTEMPTS: u32 = 10;
    const RETRY_DELAY: Duration = Duration::from_millis(200);

    loop {
        match Server::http(&bind_address) {
            Ok(server) => return Ok(server),
            Err(err) => {
                attempts += 1;
                let is_addr_in_use = err
                    .downcast_ref::<io::Error>()
                    .map(|io_err| io_err.kind() == io::ErrorKind::AddrInUse)
                    .unwrap_or(false);

                // 地址被占用时，可能存在另一个 login server 实例在运行。
                // 尝试先取消它再重试，最后才回退到 fallback port。
                if is_addr_in_use {
                    if !cancel_attempted && !using_fallback_port {
                        cancel_attempted = true;
                        if let Err(cancel_err) = send_cancel_request(port) {
                            eprintln!("Failed to cancel previous login server: {cancel_err}");
                        }
                    }

                    thread::sleep(RETRY_DELAY);

                    if attempts >= MAX_ATTEMPTS {
                        if port == DEFAULT_PORT && !using_fallback_port {
                            warn!(
                                %preferred_bind_address,
                                %fallback_bind_address,
                                "default login callback port is unavailable; falling back to the registered fallback port"
                            );
                            bind_address = fallback_bind_address.clone();
                            attempts = 0;
                            using_fallback_port = true;
                            continue;
                        }

                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            format!("Port {bind_address} is already in use"),
                        ));
                    }

                    continue;
                }

                return Err(io::Error::other(err));
            }
        }
    }
}

/// OAuth authorization-code 交换返回的 token 集合。
pub(crate) struct ExchangedTokens {
    /// OIDC id_token，包含用户身份 claims（如 `chatgpt_account_id`）。
    pub id_token: String,
    /// 访问 API 用的 access_token（短期有效）。
    pub access_token: String,
    /// 用于续期 access_token 的 refresh_token（长期有效，可被撤销）。
    pub refresh_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TokenEndpointErrorDetail {
    error_code: Option<String>,
    error_message: Option<String>,
    display_message: String,
}

impl std::fmt::Display for TokenEndpointErrorDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.display_message.fmt(f)
    }
}

const REDACTED_URL_VALUE: &str = "<redacted>";
const SENSITIVE_URL_QUERY_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "client_secret",
    "code",
    "code_verifier",
    "id_token",
    "key",
    "refresh_token",
    "requested_token",
    "state",
    "subject_token",
    "token",
];

fn redact_sensitive_query_value(key: &str, value: &str) -> String {
    if SENSITIVE_URL_QUERY_KEYS
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(key))
    {
        REDACTED_URL_VALUE.to_string()
    } else {
        value.to_string()
    }
}

/// 脱敏 URL 中常见承载 auth secret 的部分，同时保留 host/path 形状。
///
/// 这样既能让开发者通过日志调试传输失败，又不会持久化 token、callback code、
/// fragment 或嵌入凭据。
fn redact_sensitive_url_parts(url: &mut url::Url) {
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);

    let query_pairs = url
        .query_pairs()
        .map(|(key, value)| {
            let key = key.into_owned();
            let value = value.into_owned();
            (key.clone(), redact_sensitive_query_value(&key, &value))
        })
        .collect::<Vec<_>>();

    if query_pairs.is_empty() {
        url.set_query(None);
        return;
    }

    let redacted_query = query_pairs
        .into_iter()
        .fold(
            url::form_urlencoded::Serializer::new(String::new()),
            |mut serializer, (key, value)| {
                serializer.append_pair(&key, &value);
                serializer
            },
        )
        .finish();
    url.set_query(Some(&redacted_query));
}

/// 在记录或返回 reqwest 传输错误前，对其附带的 URL 进行脱敏。
fn redact_sensitive_error_url(mut err: reqwest::Error) -> reqwest::Error {
    if let Some(url) = err.url_mut() {
        redact_sensitive_url_parts(url);
    }
    err
}

/// 对自由格式的 URL 字符串进行脱敏，用于结构化日志。
///
/// 用于调用方传入的 issuer 值——非默认部署下它可能携带凭据或 query 参数。
fn sanitize_url_for_logging(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut url) => {
            redact_sensitive_url_parts(&mut url);
            url.to_string()
        }
        Err(_) => "<invalid-url>".to_string(),
    }
}
/// 用 authorization code 换取 token 集合。
///
/// 返回的错误仍适用于 CLI/浏览器等面向用户的场景，因此 backend 返回的非 JSON 错误文本
/// 会原样保留。结构化日志则更克制：仅记录从 token 响应中解析出的已审核字段以及脱敏后的
/// 传输错误，不记录最终 callback 层的 `%err` 字符串。
pub(crate) async fn exchange_code_for_tokens(
    issuer: &str,
    client_id: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
    code: &str,
    auth_route_config: Option<&AuthRouteConfig>,
) -> io::Result<ExchangedTokens> {
    #[derive(serde::Deserialize)]
    struct TokenResponse {
        id_token: String,
        access_token: String,
        refresh_token: String,
    }

    // 为 issuer 选择的路由同样用于 token 交换；token endpoint 路径不单独解析。
    let client = build_raw_auth_reqwest_client(issuer.trim_end_matches('/'), auth_route_config)?;
    let token_endpoint = format!("{}/oauth/token", issuer.trim_end_matches('/'));
    info!(
        issuer = %sanitize_url_for_logging(issuer),
        token_endpoint = %sanitize_url_for_logging(&token_endpoint),
        redirect_uri = %redirect_uri,
        "starting oauth token exchange"
    );
    let resp = client
        .post(token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
            urlencoding::encode(code),
            urlencoding::encode(redirect_uri),
            urlencoding::encode(client_id),
            urlencoding::encode(&pkce.code_verifier)
        ))
        .send()
        .await;
    let resp = match resp {
        Ok(resp) => resp,
        Err(error) => {
            let error = redact_sensitive_error_url(error);
            error!(
                is_timeout = error.is_timeout(),
                is_connect = error.is_connect(),
                is_request = error.is_request(),
                error = %error,
                "oauth token exchange transport failure"
            );
            return Err(io::Error::other(error));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.map_err(io::Error::other)?;
        let detail = parse_token_endpoint_error(&body);
        warn!(
            %status,
            error_code = detail.error_code.as_deref().unwrap_or("unknown"),
            error_message = detail.error_message.as_deref().unwrap_or("unknown"),
            "oauth token exchange returned non-success status"
        );
        return Err(io::Error::other(format!(
            "token endpoint returned status {status}: {detail}"
        )));
    }

    let tokens: TokenResponse = resp.json().await.map_err(io::Error::other)?;
    info!(%status, "oauth token exchange succeeded");
    Ok(ExchangedTokens {
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// 使用配置好的本地 auth 存储后端持久化换得的凭据。
pub(crate) async fn persist_tokens_async(
    codex_home: &Path,
    api_key: Option<String>,
    id_token: String,
    access_token: String,
    refresh_token: String,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
) -> io::Result<()> {
    // 复用现有的同步逻辑，但放到异步 runtime 之外执行，避免阻塞。
    let codex_home = codex_home.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut tokens = TokenData {
            id_token: parse_chatgpt_jwt_claims(&id_token).map_err(io::Error::other)?,
            access_token,
            refresh_token,
            account_id: None,
        };
        if let Some(acc) = jwt_auth_claims(&id_token)
            .get("chatgpt_account_id")
            .and_then(|v| v.as_str())
        {
            tokens.account_id = Some(acc.to_string());
        }
        let auth = AuthDotJson {
            auth_mode: Some(AuthMode::Chatgpt),
            openai_api_key: api_key,
            tokens: Some(tokens),
            last_refresh: Some(Utc::now()),
            agent_identity: None,
            personal_access_token: None,
            bedrock_api_key: None,
        };
        save_auth(
            &codex_home,
            &auth,
            auth_credentials_store_mode,
            keyring_backend_kind,
        )
    })
    .await
    .map_err(|e| io::Error::other(format!("persist task failed: {e}")))?
}

fn compose_success_url(
    port: u16,
    issuer: &str,
    id_token: &str,
    access_token: &str,
    codex_streamlined_login: bool,
) -> String {
    let token_claims = jwt_auth_claims(id_token);
    let access_claims = jwt_auth_claims(access_token);

    let org_id = token_claims
        .get("organization_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let project_id = token_claims
        .get("project_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let completed_onboarding = token_claims
        .get("completed_platform_onboarding")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let is_org_owner = token_claims
        .get("is_org_owner")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let needs_setup = (!completed_onboarding) && is_org_owner;
    let plan_type = access_claims
        .get("chatgpt_plan_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let platform_url = if issuer == DEFAULT_ISSUER {
        "https://platform.openai.com"
    } else {
        "https://platform.api.openai.org"
    };

    let mut params = vec![
        ("id_token", id_token.to_string()),
        ("needs_setup", needs_setup.to_string()),
        ("org_id", org_id.to_string()),
        ("project_id", project_id.to_string()),
        ("plan_type", plan_type.to_string()),
        ("platform_url", platform_url.to_string()),
    ];
    if codex_streamlined_login {
        params.push(("codex_streamlined_login", "true".to_string()));
    }
    let qs = params
        .drain(..)
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(&v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("http://localhost:{port}/success?{qs}")
}

fn jwt_auth_claims(jwt: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut parts = jwt.split('.');
    let (_h, payload_b64, _s) = match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s)) if !h.is_empty() && !p.is_empty() && !s.is_empty() => (h, p, s),
        _ => {
            eprintln!("Invalid JWT format while extracting claims");
            return serde_json::Map::new();
        }
    };
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload_b64) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(mut v) => {
                if let Some(obj) = v
                    .get_mut("https://api.openai.com/auth")
                    .and_then(|x| x.as_object_mut())
                {
                    return obj.clone();
                }
                eprintln!("JWT payload missing expected 'https://api.openai.com/auth' object");
            }
            Err(e) => {
                eprintln!("Failed to parse JWT JSON payload: {e}");
            }
        },
        Err(e) => {
            eprintln!("Failed to base64url-decode JWT payload: {e}");
        }
    }
    serde_json::Map::new()
}

/// 校验 ID token 是否满足可选的 workspace 限制。
///
/// - `expected`：允许的 workspace ID 列表；为 `None` 表示不限制。
/// - `id_token`：待校验的 OIDC id_token。
///
/// 返回 `Ok(())` 表示通过；`Err(String)` 为面向用户的错误描述。
pub(crate) fn ensure_workspace_allowed(
    expected: Option<&[String]>,
    id_token: &str,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };

    let claims = jwt_auth_claims(id_token);
    let Some(actual) = claims.get("chatgpt_account_id").and_then(JsonValue::as_str) else {
        return Err("Login is restricted to a specific workspace, but the token did not include an chatgpt_account_id claim.".to_string());
    };

    ensure_workspace_account_allowed(Some(expected), actual)
}

/// 校验已知的 ChatGPT account ID 是否满足可选的 workspace 限制。
///
/// PAT 登录会直接调用本函数，因为 `/whoami` 已经返回 account ID 而无需 id_token。
///
/// - `expected`：允许的 workspace ID 列表；为 `None` 表示不限制。
/// - `actual`：待校验的 ChatGPT account ID。
pub(crate) fn ensure_workspace_account_allowed(
    expected: Option<&[String]>,
    actual: &str,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };

    if expected.iter().any(|workspace_id| workspace_id == actual) {
        Ok(())
    } else {
        Err(format!(
            "Login is restricted to workspace id(s) {}.",
            expected.join(", ")
        ))
    }
}

/// 构造登录失败时返回给终端的 callback 响应。
fn login_error_response(
    message: &str,
    kind: io::ErrorKind,
    error_code: Option<&str>,
    error_description: Option<&str>,
) -> HandledRequest {
    let mut headers = Vec::new();
    if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]) {
        headers.push(header);
    }
    let body = render_login_error_page(message, error_code, error_description);
    HandledRequest::ResponseAndExit {
        headers,
        body,
        result: Err(io::Error::new(kind, message.to_string())),
    }
}

/// 判断 OAuth callback 是否表示缺少 Codex entitlement。
fn is_missing_codex_entitlement_error(error_code: &str, error_description: Option<&str>) -> bool {
    error_code == "access_denied"
        && error_description.is_some_and(|description| {
            description
                .to_ascii_lowercase()
                .contains("missing_codex_entitlement")
        })
}

/// 将 OAuth callback 错误转换为面向用户的错误消息。
fn oauth_callback_error_message(error_code: &str, error_description: Option<&str>) -> String {
    if is_missing_codex_entitlement_error(error_code, error_description) {
        return "Codex is not enabled for your workspace. Contact your workspace administrator to request access to Codex.".to_string();
    }

    if let Some(description) = error_description
        && !description.trim().is_empty()
    {
        return format!("Sign-in failed: {description}");
    }

    format!("Sign-in failed: {error_code}")
}

/// 解析 token endpoint 错误细节，供结构化日志与调用方可见错误共同使用。
///
/// 解析出的 JSON 字段可以单独安全记录。若响应不是 JSON，原始 body 仅保留在返回的
/// 错误路径中，使 CLI/浏览器仍能展示 backend 细节；而结构化日志路径只使用上面显式
/// 解析出的安全字段。
fn parse_token_endpoint_error(body: &str) -> TokenEndpointErrorDetail {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return TokenEndpointErrorDetail {
            error_code: None,
            error_message: None,
            display_message: "unknown error".to_string(),
        };
    }

    let parsed = serde_json::from_str::<JsonValue>(trimmed).ok();
    if let Some(json) = parsed {
        let error_code = json
            .get("error")
            .and_then(JsonValue::as_str)
            .filter(|error_code| !error_code.trim().is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                json.get("error")
                    .and_then(JsonValue::as_object)
                    .and_then(|error_obj| error_obj.get("code"))
                    .and_then(JsonValue::as_str)
                    .filter(|code| !code.trim().is_empty())
                    .map(ToString::to_string)
            });
        if let Some(description) = json.get("error_description").and_then(JsonValue::as_str)
            && !description.trim().is_empty()
        {
            return TokenEndpointErrorDetail {
                error_code,
                error_message: Some(description.to_string()),
                display_message: description.to_string(),
            };
        }
        if let Some(error_obj) = json.get("error")
            && let Some(message) = error_obj.get("message").and_then(JsonValue::as_str)
            && !message.trim().is_empty()
        {
            return TokenEndpointErrorDetail {
                error_code,
                error_message: Some(message.to_string()),
                display_message: message.to_string(),
            };
        }
        if let Some(error_code) = error_code {
            return TokenEndpointErrorDetail {
                display_message: error_code.clone(),
                error_code: Some(error_code),
                error_message: None,
            };
        }
    }

    // 非 JSON 的 token endpoint body 仍保留到返回错误中，使 CLI/浏览器流程能展示
    // backend 细节；但通过仅记录上面显式解析的字段、避免在 callback 层使用 `%err`
    // 记录，可将这些文本排除在结构化日志之外。
    TokenEndpointErrorDetail {
        error_code: None,
        error_message: None,
        display_message: trimmed.to_string(),
    }
}

/// 渲染 callback 失败时使用的品牌化错误页面。
fn render_login_error_page(
    message: &str,
    error_code: Option<&str>,
    error_description: Option<&str>,
) -> Vec<u8> {
    let code = error_code.unwrap_or("unknown_error");
    let (title, display_message, display_description, help_text) =
        if is_missing_codex_entitlement_error(code, error_description) {
            (
                "You do not have access to Codex".to_string(),
                "This account is not currently authorized to use Codex in this workspace."
                    .to_string(),
                "Contact your workspace administrator to request access to Codex.".to_string(),
                "Contact your workspace administrator to get access to Codex, then return to Codex and try again."
                    .to_string(),
            )
        } else {
            (
                "Sign-in could not be completed".to_string(),
                message.to_string(),
                error_description.unwrap_or(message).to_string(),
                "Return to Codex to retry, switch accounts, or contact your workspace admin if access is restricted."
                    .to_string(),
            )
        };
    LOGIN_ERROR_PAGE_TEMPLATE
        .render([
            ("error_title", html_escape(&title)),
            ("error_message", html_escape(&display_message)),
            ("error_code", html_escape(code)),
            ("error_description", html_escape(&display_description)),
            ("error_help", html_escape(&help_text)),
        ])
        .unwrap_or_else(|err| panic!("login error page template must render: {err}"))
        .into_bytes()
}

/// 在将错误字符串插入 HTML 之前对其进行转义。
fn html_escape(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

/// 用已认证的 id_token 换取 API-key 风格的 access_token。
pub(crate) async fn obtain_api_key(
    issuer: &str,
    client_id: &str,
    id_token: &str,
    auth_route_config: Option<&AuthRouteConfig>,
) -> io::Result<String> {
    // 用于换取 API key access_token 的 token-exchange
    #[derive(serde::Deserialize)]
    struct ExchangeResp {
        access_token: String,
    }
    let token_endpoint = format!("{}/oauth/token", issuer.trim_end_matches('/'));
    let client = build_raw_auth_reqwest_client(&token_endpoint, auth_route_config)?;
    let resp = client
        .post(token_endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type={}&client_id={}&requested_token={}&subject_token={}&subject_token_type={}",
            urlencoding::encode("urn:ietf:params:oauth:grant-type:token-exchange"),
            urlencoding::encode(client_id),
            urlencoding::encode("openai-api-key"),
            urlencoding::encode(id_token),
            urlencoding::encode("urn:ietf:params:oauth:token-type:id_token")
        ))
        .send()
        .await
        .map_err(io::Error::other)?;
    if !resp.status().is_success() {
        return Err(io::Error::other(format!(
            "api key exchange failed with status {}",
            resp.status()
        )));
    }
    let body: ExchangeResp = resp.json().await.map_err(io::Error::other)?;
    Ok(body.access_token)
}
#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::DEFAULT_ISSUER;
    use super::TokenEndpointErrorDetail;
    use super::compose_success_url;
    use super::html_escape;
    use super::is_missing_codex_entitlement_error;
    use super::parse_token_endpoint_error;
    use super::redact_sensitive_query_value;
    use super::redact_sensitive_url_parts;
    use super::render_login_error_page;
    use super::sanitize_url_for_logging;

    #[test]
    fn parse_token_endpoint_error_prefers_error_description() {
        let detail = parse_token_endpoint_error(
            r#"{"error":"invalid_grant","error_description":"refresh token expired"}"#,
        );

        assert_eq!(
            detail,
            TokenEndpointErrorDetail {
                error_code: Some("invalid_grant".to_string()),
                error_message: Some("refresh token expired".to_string()),
                display_message: "refresh token expired".to_string(),
            }
        );
    }

    #[test]
    fn parse_token_endpoint_error_reads_nested_error_message_and_code() {
        let detail = parse_token_endpoint_error(
            r#"{"error":{"code":"proxy_auth_required","message":"proxy authentication required"}}"#,
        );

        assert_eq!(
            detail,
            TokenEndpointErrorDetail {
                error_code: Some("proxy_auth_required".to_string()),
                error_message: Some("proxy authentication required".to_string()),
                display_message: "proxy authentication required".to_string(),
            }
        );
    }

    #[test]
    fn parse_token_endpoint_error_falls_back_to_error_code() {
        let detail = parse_token_endpoint_error(r#"{"error":"temporarily_unavailable"}"#);

        assert_eq!(
            detail,
            TokenEndpointErrorDetail {
                error_code: Some("temporarily_unavailable".to_string()),
                error_message: None,
                display_message: "temporarily_unavailable".to_string(),
            }
        );
    }

    #[test]
    fn parse_token_endpoint_error_preserves_plain_text_for_display() {
        let detail = parse_token_endpoint_error("service unavailable");

        assert_eq!(
            detail,
            TokenEndpointErrorDetail {
                error_code: None,
                error_message: None,
                display_message: "service unavailable".to_string(),
            }
        );
    }

    #[test]
    fn redact_sensitive_query_value_only_scrubs_known_keys() {
        assert_eq!(
            redact_sensitive_query_value("code", "abc123"),
            "<redacted>".to_string()
        );
        assert_eq!(
            redact_sensitive_query_value("redirect_uri", "http://localhost:1455/auth/callback"),
            "http://localhost:1455/auth/callback".to_string()
        );
    }

    #[test]
    fn redact_sensitive_url_parts_preserves_safe_url_shape() {
        let mut url = url::Url::parse(
            "https://user:pass@auth.openai.com/oauth/token?code=abc123&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback#frag",
        )
        .expect("valid url");

        redact_sensitive_url_parts(&mut url);

        assert_eq!(
            url.as_str(),
            "https://auth.openai.com/oauth/token?code=%3Credacted%3E&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
        );
    }

    #[test]
    fn sanitize_url_for_logging_redacts_sensitive_issuer_parts() {
        let redacted =
            sanitize_url_for_logging("https://user:pass@example.com/base?token=abc123&env=prod");

        assert_eq!(
            redacted,
            "https://example.com/base?token=%3Credacted%3E&env=prod".to_string()
        );
    }

    #[test]
    fn compose_success_url_omits_streamlined_success_by_default() {
        let url = url::Url::parse(&compose_success_url(
            /*port*/ 1455,
            DEFAULT_ISSUER,
            "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnt9fQ.sig",
            "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnt9fQ.sig",
            /*codex_streamlined_login*/ false,
        ))
        .expect("success url should parse");

        assert_eq!(
            url.query_pairs()
                .find(|(key, _)| key == "codex_streamlined_login"),
            None
        );
    }

    #[test]
    fn compose_success_url_includes_streamlined_success_when_requested() {
        let url = url::Url::parse(&compose_success_url(
            /*port*/ 1455,
            DEFAULT_ISSUER,
            "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnt9fQ.sig",
            "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnt9fQ.sig",
            /*codex_streamlined_login*/ true,
        ))
        .expect("success url should parse");

        assert_eq!(
            url.query_pairs()
                .find(|(key, _)| key == "codex_streamlined_login")
                .map(|(_, value)| value.into_owned()),
            Some("true".to_string())
        );
    }

    #[test]
    fn render_login_error_page_escapes_dynamic_fields() {
        let body = String::from_utf8(render_login_error_page(
            "<bad>",
            Some("code&value"),
            Some("\"quoted\""),
        ))
        .expect("login error page should be utf-8");

        assert!(body.contains(&html_escape("Sign-in could not be completed")));
        assert!(body.contains("&lt;bad&gt;"));
        assert!(body.contains("code&amp;value"));
        assert!(body.contains("&quot;quoted&quot;"));
    }

    #[test]
    fn render_login_error_page_uses_entitlement_copy() {
        let error_description = Some("missing_codex_entitlement");
        assert!(is_missing_codex_entitlement_error(
            "access_denied",
            error_description
        ));

        let body = String::from_utf8(render_login_error_page(
            "access denied",
            Some("access_denied"),
            error_description,
        ))
        .expect("login error page should be utf-8");

        assert!(body.contains("You do not have access to Codex"));
        assert!(body.contains("Contact your workspace administrator"));
        assert!(!body.contains("missing_codex_entitlement"));
    }
}

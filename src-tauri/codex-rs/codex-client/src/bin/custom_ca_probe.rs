//! 用于在测试中验证共享 custom CA 环境处理的 helper binary。
//!
//! 共享的 reqwest client 遵循 `CODEX_CA_CERTIFICATE` 与 `SSL_CERT_FILE`，但这些环境变量是
//! 进程级全局的，在并行测试执行中修改它们不安全。该 probe 在保持被测行为的同时，让集成测试
//! （`tests/ca_env.rs`）可以按进程设置 env vars，验证以下内容：
//!
//! - env 优先级被正确遵守，
//! - 多 certificate 的 PEM bundle 能正常加载，
//! - CA 文件无效时错误消息能引导用户修正。
//! - 可选的 HTTPS probe 能通过构造的 client 完成一次请求。
//!
//! 关于此处"hermetic"含义的详细说明位于 `codex_client::custom_ca`。
//! 该 binary 的存在使测试能在独立进程中调用
//! [`codex_client::build_reqwest_client_for_subprocess_tests`]，而无需重复 client 构造逻辑。

use std::env;
use std::process;
use std::time::Duration;

const PROBE_TLS13_ENV: &str = "CODEX_CUSTOM_CA_PROBE_TLS13";
const PROBE_PROXY_ENV: &str = "CODEX_CUSTOM_CA_PROBE_PROXY";
const PROBE_URL_ENV: &str = "CODEX_CUSTOM_CA_PROBE_URL";

fn main() {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("failed to create probe runtime: {error}");
            process::exit(1);
        }
    };

    match runtime.block_on(run_probe()) {
        Ok(()) => println!("ok"),
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    }
}

async fn run_probe() -> Result<(), String> {
    let proxy_url = env::var(PROBE_PROXY_ENV).ok();
    let target_url = env::var(PROBE_URL_ENV).ok();
    let mut builder = reqwest::Client::builder();
    if target_url.is_some() {
        builder = builder.timeout(Duration::from_secs(5));
    }
    if env::var_os(PROBE_TLS13_ENV).is_some() {
        builder = builder.min_tls_version(reqwest::tls::Version::TLS_1_3);
    }

    let client = build_probe_client(builder, proxy_url.as_deref())?;
    if let Some(url) = target_url {
        post_probe_request(&client, &url).await?;
    }
    Ok(())
}

fn build_probe_client(
    builder: reqwest::ClientBuilder,
    proxy_url: Option<&str>,
) -> Result<reqwest::Client, String> {
    if let Some(proxy_url) = proxy_url {
        let proxy = reqwest::Proxy::https(proxy_url)
            .map_err(|error| format!("failed to configure probe proxy {proxy_url}: {error}"))?;
        return codex_client::build_reqwest_client_with_custom_ca(builder.proxy(proxy))
            .map_err(|error| error.to_string());
    }

    codex_client::build_reqwest_client_for_subprocess_tests(builder)
        .map_err(|error| error.to_string())
}

async fn post_probe_request(client: &reqwest::Client, url: &str) -> Result<(), String> {
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=authorization_code&code=test")
        .send()
        .await
        .map_err(|error| format!("probe request failed: {error:?}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("failed to read probe response body: {error}"))?;
    if !status.is_success() {
        return Err(format!("probe request returned {status}: {body}"));
    }
    if body != "ok" {
        return Err(format!("probe response body mismatch: {body}"));
    }
    Ok(())
}

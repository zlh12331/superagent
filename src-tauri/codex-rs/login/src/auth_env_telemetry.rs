//! 登录相关环境变量的遥测采集。
//!
//! 仅记录环境变量是否存在、是否启用等布尔值，不会泄露具体内容，
//! 用于在遥测报告中反映用户当前的认证环境配置。

use codex_model_provider_info::ModelProviderInfo;
use codex_otel::AuthEnvTelemetryMetadata;

use crate::CODEX_API_KEY_ENV_VAR;
use crate::OPENAI_API_KEY_ENV_VAR;
use crate::REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR;

/// 登录相关环境变量存在性快照。
///
/// 所有字段仅表示布尔状态，不包含环境变量的实际值，
/// 适合安全地嵌入到遥测事件中。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthEnvTelemetry {
    /// `OPENAI_API_KEY` 环境变量是否存在且非空。
    pub openai_api_key_env_present: bool,
    /// `CODEX_API_KEY` 环境变量是否存在且非空。
    pub codex_api_key_env_present: bool,
    /// 当前会话是否允许从 `CODEX_API_KEY` 环境变量加载 API Key。
    pub codex_api_key_env_enabled: bool,
    /// 模型 provider 配置的环境变量名称标识（仅记录 "configured"，不泄露键名）。
    pub provider_env_key_name: Option<String>,
    /// 模型 provider 配置的环境变量是否存在且非空。
    pub provider_env_key_present: Option<bool>,
    /// 刷新令牌 URL 覆盖环境变量是否存在。
    pub refresh_token_url_override_present: bool,
}

impl AuthEnvTelemetry {
    /// 将当前遥测快照转换为 OTEL 元数据结构。
    pub fn to_otel_metadata(&self) -> AuthEnvTelemetryMetadata {
        AuthEnvTelemetryMetadata {
            openai_api_key_env_present: self.openai_api_key_env_present,
            codex_api_key_env_present: self.codex_api_key_env_present,
            codex_api_key_env_enabled: self.codex_api_key_env_enabled,
            provider_env_key_name: self.provider_env_key_name.clone(),
            provider_env_key_present: self.provider_env_key_present,
            refresh_token_url_override_present: self.refresh_token_url_override_present,
        }
    }
}

/// 采集当前进程的登录相关环境变量遥测信息。
///
/// 参数：
/// - `provider`：当前选中的模型 provider 信息，用于检查其声明的 env_key。
/// - `codex_api_key_env_enabled`：是否启用从 `CODEX_API_KEY` 环境变量读取 API Key。
pub fn collect_auth_env_telemetry(
    provider: &ModelProviderInfo,
    codex_api_key_env_enabled: bool,
) -> AuthEnvTelemetry {
    AuthEnvTelemetry {
        openai_api_key_env_present: env_var_present(OPENAI_API_KEY_ENV_VAR),
        codex_api_key_env_present: env_var_present(CODEX_API_KEY_ENV_VAR),
        codex_api_key_env_enabled,
        provider_env_key_name: provider.env_key.as_ref().map(|_| "configured".to_string()),
        provider_env_key_present: provider.env_key.as_deref().map(env_var_present),
        refresh_token_url_override_present: env_var_present(REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR),
    }
}

/// 判断指定环境变量是否存在且值为非空字符串。
///
/// 非 UTF-8 的值视为存在（避免遗漏），未设置视为不存在。
fn env_var_present(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => !value.trim().is_empty(),
        Err(std::env::VarError::NotUnicode(_)) => true,
        Err(std::env::VarError::NotPresent) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_model_provider_info::WireApi;
    use pretty_assertions::assert_eq;

    #[test]
    fn collect_auth_env_telemetry_buckets_provider_env_key_name() {
        let provider = ModelProviderInfo {
            name: "Custom".to_string(),
            base_url: None,
            env_key: Some("sk-should-not-leak".to_string()),
            env_key_instructions: None,
            experimental_bearer_token: None,
            auth: None,
            aws: None,
            wire_api: WireApi::Responses,
            query_params: None,
            http_headers: None,
            env_http_headers: None,
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: false,
            supports_websockets: false,
        };

        let telemetry =
            collect_auth_env_telemetry(&provider, /*codex_api_key_env_enabled*/ false);

        assert_eq!(
            telemetry.provider_env_key_name,
            Some("configured".to_string())
        );
    }
}

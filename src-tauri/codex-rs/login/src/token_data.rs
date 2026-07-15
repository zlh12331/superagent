//! JWT 令牌数据解析与存储模型。
//!
//! 提供 [`TokenData`] 与 [`IdTokenInfo`] 等结构，用于从 auth.json 中
//! 读取 OAuth 令牌并解析其中嵌入的 ChatGPT 相关声明（claims）。
//!
//! 主要功能：
//! - 解析 id_token / access_token / refresh_token 三类令牌。
//! - 从 JWT payload 中提取 email、plan_type、account_id 等关键字段。
//! - 自定义 serde 序列化：id_token 在磁盘上存为原始 JWT 字符串，加载时反序列化为 [`IdTokenInfo`]。

use base64::Engine;
use chrono::DateTime;
use chrono::Utc;
use codex_protocol::auth::PlanType;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;

/// 持久化的 OAuth 令牌数据。
///
/// 对应 `$CODEX_HOME/auth.json` 中 `tokens` 字段的结构。
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
pub struct TokenData {
    /// 从 id_token JWT 中解析出的扁平声明集合。
    ///
    /// 序列化时写回原始 JWT 字符串，反序列化时重新解析。
    #[serde(
        deserialize_with = "deserialize_id_token",
        serialize_with = "serialize_id_token"
    )]
    pub id_token: IdTokenInfo,

    /// 访问令牌（JWT 格式），用于 bearer 认证。
    pub access_token: String,

    /// 刷新令牌，用于在 access_token 过期后获取新的令牌。
    pub refresh_token: String,

    /// 当前选中的 ChatGPT 工作区（account）ID。
    pub account_id: Option<String>,
}

/// 从 id_token JWT 中提取的有用声明（claims）的扁平子集。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct IdTokenInfo {
    /// 用户邮箱地址（如果 JWT 中包含）。
    pub email: Option<String>,
    /// ChatGPT 订阅计划类型
    /// （如 "free"、"plus"、"pro"、"business"、"enterprise"、"edu"）。
    /// 注意：实际取值以后端为准。
    pub chatgpt_plan_type: Option<PlanType>,
    /// 令牌关联的 ChatGPT 用户 ID（如果存在）。
    pub chatgpt_user_id: Option<String>,
    /// 令牌关联的组织 / 工作区 ID（如果存在）。
    pub chatgpt_account_id: Option<String>,
    /// 当前选中的 ChatGPT 工作区是否需要通过 FedRAMP 边缘路由。
    pub chatgpt_account_is_fedramp: bool,
    /// 原始 JWT 字符串，保留以便后续重新解析或透传。
    pub raw_jwt: String,
}

impl IdTokenInfo {
    /// 返回 plan_type 的展示名称（用于 UI 显示）。
    pub fn get_chatgpt_plan_type(&self) -> Option<String> {
        self.chatgpt_plan_type.as_ref().map(|t| match t {
            PlanType::Known(plan) => plan.display_name().to_string(),
            PlanType::Unknown(s) => s.clone(),
        })
    }

    /// 返回 plan_type 的原始字符串值（用于遥测或日志）。
    pub fn get_chatgpt_plan_type_raw(&self) -> Option<String> {
        self.chatgpt_plan_type.as_ref().map(|t| match t {
            PlanType::Known(plan) => plan.raw_value().to_string(),
            PlanType::Unknown(s) => s.clone(),
        })
    }

    /// 判断当前账户是否为工作区（workspace）类型账户。
    pub fn is_workspace_account(&self) -> bool {
        matches!(
            self.chatgpt_plan_type,
            Some(PlanType::Known(plan)) if plan.is_workspace_account()
        )
    }

    /// 判断当前账户是否为 FedRAMP 账户。
    pub fn is_fedramp_account(&self) -> bool {
        self.chatgpt_account_is_fedramp
    }
}

#[derive(Deserialize)]
struct IdClaims {
    #[serde(default)]
    email: Option<String>,
    #[serde(rename = "https://api.openai.com/profile", default)]
    profile: Option<ProfileClaims>,
    #[serde(rename = "https://api.openai.com/auth", default)]
    auth: Option<AuthClaims>,
}

#[derive(Deserialize)]
struct ProfileClaims {
    #[serde(default)]
    email: Option<String>,
}

#[derive(Deserialize)]
struct AuthClaims {
    #[serde(default)]
    chatgpt_plan_type: Option<PlanType>,
    #[serde(default)]
    chatgpt_user_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    chatgpt_account_id: Option<String>,
    #[serde(default)]
    chatgpt_account_is_fedramp: bool,
}

#[derive(Deserialize)]
struct StandardJwtClaims {
    #[serde(default)]
    exp: Option<i64>,
}

/// JWT 令牌解析错误。
#[derive(Debug, Error)]
pub enum IdTokenInfoError {
    /// JWT 格式无效（非 header.payload.signature 三段式）。
    #[error("invalid ID token format")]
    InvalidFormat,
    /// base64 解码失败。
    #[error(transparent)]
    Base64(#[from] base64::DecodeError),
    /// JSON 反序列化失败。
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// 解码 JWT 的 payload 部分。
///
/// JWT 格式为 `header.payload.signature`，本函数仅解码 payload 并反序列化为目标类型。
fn decode_jwt_payload<T: DeserializeOwned>(jwt: &str) -> Result<T, IdTokenInfoError> {
    // JWT 格式：header.payload.signature
    let mut parts = jwt.split('.');
    let (_header_b64, payload_b64, _sig_b64) = match (parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s)) if !h.is_empty() && !p.is_empty() && !s.is_empty() => (h, p, s),
        _ => return Err(IdTokenInfoError::InvalidFormat),
    };

    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload_b64)?;
    let claims = serde_json::from_slice(&payload_bytes)?;
    Ok(claims)
}

/// 解析 JWT 的过期时间（`exp` 声明）。
///
/// 参数：
/// - `jwt`：JWT 字符串。
///
/// 返回值：
/// - `Ok(Some(datetime))`：存在有效的 exp 声明。
/// - `Ok(None)`：JWT 中无 exp 声明。
/// - `Err`：JWT 格式或解码错误。
pub fn parse_jwt_expiration(jwt: &str) -> Result<Option<DateTime<Utc>>, IdTokenInfoError> {
    let claims: StandardJwtClaims = decode_jwt_payload(jwt)?;
    Ok(claims
        .exp
        .and_then(|exp| DateTime::<Utc>::from_timestamp(exp, 0)))
}

/// 从 ChatGPT id_token JWT 中解析出 [`IdTokenInfo`]。
///
/// 提取 email、plan_type、chatgpt_user_id、chatgpt_account_id 等字段，
/// 同时保留原始 JWT 字符串以便后续使用。
pub fn parse_chatgpt_jwt_claims(jwt: &str) -> Result<IdTokenInfo, IdTokenInfoError> {
    let claims: IdClaims = decode_jwt_payload(jwt)?;
    let email = claims
        .email
        .or_else(|| claims.profile.and_then(|profile| profile.email));

    match claims.auth {
        Some(auth) => Ok(IdTokenInfo {
            email,
            raw_jwt: jwt.to_string(),
            chatgpt_plan_type: auth.chatgpt_plan_type,
            chatgpt_user_id: auth.chatgpt_user_id.or(auth.user_id),
            chatgpt_account_id: auth.chatgpt_account_id,
            chatgpt_account_is_fedramp: auth.chatgpt_account_is_fedramp,
        }),
        None => Ok(IdTokenInfo {
            email,
            raw_jwt: jwt.to_string(),
            chatgpt_plan_type: None,
            chatgpt_user_id: None,
            chatgpt_account_id: None,
            chatgpt_account_is_fedramp: false,
        }),
    }
}

/// 自定义反序列化：从 JWT 字符串解析为 [`IdTokenInfo`]。
fn deserialize_id_token<'de, D>(deserializer: D) -> Result<IdTokenInfo, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    parse_chatgpt_jwt_claims(&s).map_err(serde::de::Error::custom)
}

/// 自定义序列化：将 [`IdTokenInfo`] 序列化为原始 JWT 字符串。
fn serialize_id_token<S>(id_token: &IdTokenInfo, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&id_token.raw_jwt)
}

#[cfg(test)]
#[path = "token_data_tests.rs"]
mod tests;

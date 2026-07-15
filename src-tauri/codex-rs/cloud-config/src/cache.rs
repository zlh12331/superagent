//! 云端配置 bundle 的本地签名缓存。
//!
//! 缓存以已认证的 ChatGPT 用户和账号为作用域，TTL 较短，
//! 并通过 HMAC 签名保证被篡改或编辑过的文件以"失败即关闭"（fail closed）方式拒绝读取。

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use chrono::DateTime;
use chrono::Duration as ChronoDuration;
use chrono::Utc;
use codex_config::AbsolutePathBuf;
use codex_config::CloudConfigBundle;
use hmac::Hmac;
use hmac::Mac;
use serde::Deserialize;
use serde::Serialize;
use sha2::Sha256;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use tokio::fs;

/// 缓存文件格式版本；发生破坏性变更时递增。
const CLOUD_CONFIG_BUNDLE_CACHE_VERSION: u32 = 1;
/// 缓存文件名，位于 codex_home 根目录下。
pub(super) const CLOUD_CONFIG_BUNDLE_CACHE_FILENAME: &str = "cloud-config-bundle-cache.json";
/// 缓存条目的存活时间（TTL），超时后视为过期。
const CLOUD_CONFIG_BUNDLE_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// 写入时使用的 HMAC 密钥。
const CLOUD_CONFIG_BUNDLE_CACHE_WRITE_HMAC_KEY: &[u8] =
    b"codex-cloud-config-bundle-cache-v1-6160ae70-bcfd-4ca8-a99b-40f73b3b072e";
/// 读取时接受的 HMAC 密钥集合（支持密钥轮换，目前仅与写入密钥相同）。
const CLOUD_CONFIG_BUNDLE_CACHE_READ_HMAC_KEYS: &[&[u8]] =
    &[CLOUD_CONFIG_BUNDLE_CACHE_WRITE_HMAC_KEY];

type HmacSha256 = Hmac<Sha256>;

/// 云端配置 bundle 缓存的访问句柄，按 `codex_home` 路径定位缓存文件。
#[derive(Clone)]
pub(super) struct CloudConfigBundleCache {
    path: AbsolutePathBuf,
}

impl CloudConfigBundleCache {
    /// 创建一个新的缓存句柄，缓存文件位于 `codex_home` 根目录下。
    pub(super) fn new(codex_home: AbsolutePathBuf) -> Self {
        Self {
            path: codex_home.join(CLOUD_CONFIG_BUNDLE_CACHE_FILENAME),
        }
    }

    /// 返回缓存文件的磁盘路径。
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// 读取并校验缓存。
    ///
    /// 校验流程：身份信息完整 → 文件存在 → JSON 可解析 → HMAC 签名有效 →
    /// 版本一致 → 缓存身份匹配 → 未过期。
    pub(super) async fn load(
        &self,
        chatgpt_user_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<CloudConfigBundleCacheSignedPayload, CacheLoadStatus> {
        let (Some(chatgpt_user_id), Some(account_id)) = (chatgpt_user_id, account_id) else {
            return Err(CacheLoadStatus::AuthIdentityIncomplete);
        };

        let bytes = match fs::read(&self.path).await {
            Ok(bytes) => bytes,
            Err(err) => {
                if err.kind() != std::io::ErrorKind::NotFound {
                    return Err(CacheLoadStatus::CacheReadFailed(err.to_string()));
                }
                return Err(CacheLoadStatus::CacheFileNotFound);
            }
        };

        let cache_file: CloudConfigBundleCacheFile = match serde_json::from_slice(&bytes) {
            Ok(cache_file) => cache_file,
            Err(err) => {
                return Err(CacheLoadStatus::CacheParseFailed(err.to_string()));
            }
        };
        let payload_bytes = match cache_payload_bytes(&cache_file.signed_payload) {
            Some(payload_bytes) => payload_bytes,
            None => {
                return Err(CacheLoadStatus::CacheParseFailed(
                    "failed to serialize cache payload".to_string(),
                ));
            }
        };
        if !verify_cache_signature(&payload_bytes, &cache_file.signature) {
            return Err(CacheLoadStatus::CacheSignatureInvalid);
        }
        if cache_file.signed_payload.version != CLOUD_CONFIG_BUNDLE_CACHE_VERSION {
            return Err(CacheLoadStatus::CacheVersionUnsupported(
                cache_file.signed_payload.version,
            ));
        }

        let (Some(cached_chatgpt_user_id), Some(cached_account_id)) = (
            cache_file.signed_payload.chatgpt_user_id.as_deref(),
            cache_file.signed_payload.account_id.as_deref(),
        ) else {
            return Err(CacheLoadStatus::CacheIdentityIncomplete);
        };

        if cached_chatgpt_user_id != chatgpt_user_id || cached_account_id != account_id {
            return Err(CacheLoadStatus::CacheIdentityMismatch);
        }

        if cache_file.signed_payload.expires_at <= Utc::now() {
            return Err(CacheLoadStatus::CacheExpired);
        }

        Ok(cache_file.signed_payload)
    }

    /// 根据 [`CacheLoadStatus`] 上报缓存读取结果。
    ///
    /// `CacheFileNotFound` 不输出日志（属于正常的冷启动场景）；
    /// 文件读取/解析/签名失败输出 warn，其它情况输出 info。
    pub(super) fn log_load_status(&self, status: &CacheLoadStatus) {
        if matches!(status, CacheLoadStatus::CacheFileNotFound) {
            return;
        }

        let warn = matches!(
            status,
            CacheLoadStatus::CacheReadFailed(_)
                | CacheLoadStatus::CacheParseFailed(_)
                | CacheLoadStatus::CacheSignatureInvalid
        );

        if warn {
            tracing::warn!(path = %self.path.display(), "{status}");
        } else {
            tracing::info!(path = %self.path.display(), "{status}");
        }
    }

    /// 将 bundle 连同身份信息和过期时间签名写入磁盘。
    pub(super) async fn save(
        &self,
        chatgpt_user_id: Option<String>,
        account_id: Option<String>,
        bundle: CloudConfigBundle,
    ) -> Result<(), CloudConfigBundleCacheError> {
        let now = Utc::now();
        let expires_at = now
            .checked_add_signed(
                ChronoDuration::from_std(CLOUD_CONFIG_BUNDLE_CACHE_TTL)
                    .map_err(|_| CloudConfigBundleCacheError)?,
            )
            .ok_or(CloudConfigBundleCacheError)?;
        let signed_payload = CloudConfigBundleCacheSignedPayload {
            version: CLOUD_CONFIG_BUNDLE_CACHE_VERSION,
            cached_at: now,
            expires_at,
            chatgpt_user_id,
            account_id,
            bundle,
        };
        let payload_bytes =
            cache_payload_bytes(&signed_payload).ok_or(CloudConfigBundleCacheError)?;
        let serialized = serde_json::to_vec_pretty(&CloudConfigBundleCacheFile {
            signature: sign_cache_payload(&payload_bytes).ok_or(CloudConfigBundleCacheError)?,
            signed_payload,
        })
        .map_err(|_| CloudConfigBundleCacheError)?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|_| CloudConfigBundleCacheError)?;
        }

        fs::write(&self.path, serialized)
            .await
            .map_err(|_| CloudConfigBundleCacheError)?;
        Ok(())
    }
}

/// 缓存读取阶段可能返回的各种状态。
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub(super) enum CacheLoadStatus {
    /// 认证身份信息不完整，无法安全读取缓存。
    #[error("Skipping cloud config bundle cache read because auth identity is incomplete.")]
    AuthIdentityIncomplete,
    /// 缓存文件不存在（冷启动正常情况）。
    #[error("Cloud config bundle cache file not found.")]
    CacheFileNotFound,
    /// 读取缓存文件失败（IO 错误）。
    #[error("Failed to read cloud config bundle cache: {0}.")]
    CacheReadFailed(String),
    /// 解析缓存文件失败（JSON 损坏）。
    #[error("Failed to parse cloud config bundle cache: {0}.")]
    CacheParseFailed(String),
    /// 缓存签名校验失败，可能被篡改。
    #[error("Cloud config bundle cache failed signature verification.")]
    CacheSignatureInvalid,
    /// 缓存条目中的身份信息不完整。
    #[error("Ignoring cloud config bundle cache because cached identity is incomplete.")]
    CacheIdentityIncomplete,
    /// 缓存条目身份与当前认证身份不匹配。
    #[error("Ignoring cloud config bundle cache for different auth identity.")]
    CacheIdentityMismatch,
    /// 缓存版本不被当前代码支持。
    #[error("Ignoring cloud config bundle cache with unsupported version {0}.")]
    CacheVersionUnsupported(u32),
    /// 缓存已超过 TTL。
    #[error("Cloud config bundle cache expired.")]
    CacheExpired,
    /// 缓存中的 bundle 内容无效。
    #[error("Ignoring cloud config bundle cache because the cached bundle is invalid.")]
    CacheInvalidBundle,
}

/// 写入缓存时发生的错误（目前所有失败统一归为一类）。
#[derive(Debug, Error)]
#[error("failed to write cloud config bundle cache")]
pub(super) struct CloudConfigBundleCacheError;

/// 落盘的缓存文件结构，包含签名载荷与对应签名。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(super) struct CloudConfigBundleCacheFile {
    /// 被签名的载荷部分。
    pub(super) signed_payload: CloudConfigBundleCacheSignedPayload,
    /// 对 `signed_payload` 序列化字节串计算出的 Base64 HMAC-SHA256 签名。
    pub(super) signature: String,
}

/// 缓存载荷，包含元数据（版本、过期时间、身份）与 bundle 本身。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(super) struct CloudConfigBundleCacheSignedPayload {
    /// 缓存文件格式版本。
    pub(super) version: u32,
    /// 缓存写入时间（UTC）。
    pub(super) cached_at: DateTime<Utc>,
    /// 缓存过期时间（UTC）。
    pub(super) expires_at: DateTime<Utc>,
    /// 写入时的 ChatGPT 用户 ID。
    pub(super) chatgpt_user_id: Option<String>,
    /// 写入时的账号 ID。
    pub(super) account_id: Option<String>,
    /// 实际缓存的云端配置 bundle。
    pub(super) bundle: CloudConfigBundle,
}

/// 将载荷序列化为字节串，用于签名或校验。
pub(super) fn cache_payload_bytes(
    payload: &CloudConfigBundleCacheSignedPayload,
) -> Option<Vec<u8>> {
    serde_json::to_vec(&payload).ok()
}

/// 使用写入密钥对载荷字节串计算 HMAC-SHA256 并返回 Base64 编码结果。
pub(super) fn sign_cache_payload(payload_bytes: &[u8]) -> Option<String> {
    let mut mac = HmacSha256::new_from_slice(CLOUD_CONFIG_BUNDLE_CACHE_WRITE_HMAC_KEY).ok()?;
    mac.update(payload_bytes);
    let signature = mac.finalize().into_bytes();
    Some(BASE64_STANDARD.encode(signature))
}

/// 校验载荷字节串与签名的对应关系，支持密钥轮换（任意一个读取密钥匹配即通过）。
pub(super) fn verify_cache_signature(payload_bytes: &[u8], signature: &str) -> bool {
    let signature_bytes = match BASE64_STANDARD.decode(signature) {
        Ok(signature_bytes) => signature_bytes,
        Err(_) => return false,
    };

    CLOUD_CONFIG_BUNDLE_CACHE_READ_HMAC_KEYS
        .iter()
        .any(|key| verify_cache_signature_with_key(payload_bytes, &signature_bytes, key))
}

fn verify_cache_signature_with_key(
    payload_bytes: &[u8],
    signature_bytes: &[u8],
    key: &[u8],
) -> bool {
    let mut mac = match HmacSha256::new_from_slice(key) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(payload_bytes);
    mac.verify_slice(signature_bytes).is_ok()
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;

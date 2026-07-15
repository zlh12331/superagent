//! OAuth PKCE（Proof Key for Code Exchange）实现。
//!
//! 用于 OAuth 授权码流程中防止授权码拦截攻击。
//! 生成一对 verifier / challenge，verifier 由客户端保管，
//! challenge 在授权请求中发送给认证服务器。

use base64::Engine;
use rand::RngCore;
use sha2::Digest;
use sha2::Sha256;

/// PKCE 流程所需的 verifier 与 challenge 对。
#[derive(Debug, Clone)]
pub struct PkceCodes {
    /// 客户端持有的随机串，需在令牌交换阶段原样发送给认证服务器。
    pub code_verifier: String,
    /// 由 verifier 派生出的挑战值（S256），在授权请求阶段发送。
    pub code_challenge: String,
}

/// 生成一组新的 PKCE verifier / challenge。
///
/// verifier 为 64 字节随机数的 URL-safe base64 编码（无填充），
/// challenge 为 verifier 的 SHA-256 哈希的 URL-safe base64 编码（无填充）。
pub fn generate_pkce() -> PkceCodes {
    let mut bytes = [0u8; 64];
    rand::rng().fill_bytes(&mut bytes);

    // verifier：URL-safe base64 无填充编码（长度在 43..128 字符之间）
    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);

    // challenge（S256 算法）：BASE64URL-ENCODE(SHA256(verifier)) 无填充
    let digest = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);

    PkceCodes {
        code_verifier,
        code_challenge,
    }
}

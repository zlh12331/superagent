//! Attestation 模块。
//!
//! 定义请求级 attestation header(`x-oai-attestation`)的生成 trait,
//! 用于在调用模型 API 时附加设备 / 客户端 attestation 信息。

use std::future::Future;
use std::pin::Pin;

use codex_protocol::ThreadId;
use http::HeaderValue;

pub(crate) const X_OAI_ATTESTATION_HEADER: &str = "x-oai-attestation";

pub type GenerateAttestationFuture<'a> =
    Pin<Box<dyn Future<Output = Option<HeaderValue>> + Send + 'a>>;

/// Request context that host integrations can use when deciding whether to
/// generate an attestation header value.
#[derive(Clone, Copy, Debug)]
pub struct AttestationContext {
    /// Thread whose upstream request is being prepared.
    pub thread_id: ThreadId,
}

/// Host integration boundary for just-in-time attestation header values.
///
/// Implementations own the policy for when attestation should be attempted and
/// return the upstream `x-oai-attestation` header value when one should be sent.
pub trait AttestationProvider: std::fmt::Debug + Send + Sync {
    fn header_for_request(&self, context: AttestationContext) -> GenerateAttestationFuture<'_>;
}

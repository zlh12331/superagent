use crate::error::TransportError;
use crate::request::Request;
use rand::Rng;
use std::future::Future;
use std::time::Duration;
use tokio::time::sleep;

/// 重试策略。
///
/// 控制重试的最大尝试次数、基础退避延迟以及触发重试的条件。
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// 最大尝试次数（含首次请求；达到后不再重试）。
    pub max_attempts: u64,
    /// 退避的基础延迟；实际延迟按指数退避算法计算。
    pub base_delay: Duration,
    /// 触发重试的条件配置。
    pub retry_on: RetryOn,
}

/// 触发重试的条件集合。
#[derive(Debug, Clone)]
pub struct RetryOn {
    /// 是否对 HTTP 429（Too Many Requests）重试。
    pub retry_429: bool,
    /// 是否对 5xx 服务端错误重试。
    pub retry_5xx: bool,
    /// 是否对传输层错误（超时、网络异常）重试。
    pub retry_transport: bool,
}

impl RetryOn {
    /// 判断给定错误是否应触发重试。
    ///
    /// 在以下情况下返回 `false`：
    /// - 已达到最大尝试次数；
    /// - 错误类型不在配置的触发条件内（如 `Build` 错误始终不重试）。
    pub fn should_retry(&self, err: &TransportError, attempt: u64, max_attempts: u64) -> bool {
        if attempt >= max_attempts {
            return false;
        }
        match err {
            TransportError::Http { status, .. } => {
                (self.retry_429 && status.as_u16() == 429)
                    || (self.retry_5xx && status.is_server_error())
            }
            TransportError::Timeout | TransportError::Network(_) => self.retry_transport,
            _ => false,
        }
    }
}

/// 指数退避算法（含 ±10% 抖动）。
///
/// 计算公式：`base * 2^(attempt-1)`，再乘以 [0.9, 1.1) 区间内的随机抖动系数。
/// 当 `attempt == 0` 时直接返回 `base`，避免首次重试过快。
pub fn backoff(base: Duration, attempt: u64) -> Duration {
    if attempt == 0 {
        return base;
    }
    let exp = 2u64.saturating_pow(attempt as u32 - 1);
    let millis = base.as_millis() as u64;
    let raw = millis.saturating_mul(exp);
    let jitter: f64 = rand::rng().random_range(0.9..1.1);
    Duration::from_millis((raw as f64 * jitter) as u64)
}

/// 按给定策略运行异步操作，并在可重试错误发生时自动重试。
///
/// 参数：
/// - `policy`：重试策略。
/// - `make_req`：每次尝试时构造请求的回调（重试时会重新调用以生成新请求）。
/// - `op`：实际执行的异步操作，接收请求与当前尝试序号（从 0 开始）。
///
/// 返回操作成功结果；若达到上限仍未成功，返回 [`TransportError::RetryLimit`]。
pub async fn run_with_retry<T, F, Fut>(
    policy: RetryPolicy,
    mut make_req: impl FnMut() -> Request,
    op: F,
) -> Result<T, TransportError>
where
    F: Fn(Request, u64) -> Fut,
    Fut: Future<Output = Result<T, TransportError>>,
{
    for attempt in 0..=policy.max_attempts {
        let req = make_req();
        match op(req, attempt).await {
            Ok(resp) => return Ok(resp),
            Err(err)
                if policy
                    .retry_on
                    .should_retry(&err, attempt, policy.max_attempts) =>
            {
                sleep(backoff(policy.base_delay, attempt + 1)).await;
            }
            Err(err) => return Err(err),
        }
    }
    Err(TransportError::RetryLimit)
}

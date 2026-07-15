//! 异步工具集合，提供对 `Future` 的取消（cancel）扩展。
//!
//! 通过 [`OrCancelExt::or_cancel`] 可将任意 `Future` 与一个
//! [`CancellationToken`](tokio_util::sync::CancellationToken) 关联起来：
//! 当 token 被取消时，future 立即返回 `Err(CancelErr::Cancelled)`；
//! 否则正常返回 future 的结果。

use std::future::Future;
use tokio_util::sync::CancellationToken;

/// 调用 [`OrCancelExt::or_cancel`] 时，若被取消则返回此错误。
#[derive(Debug, PartialEq, Eq)]
pub enum CancelErr {
    /// 表示 future 因外部 `CancellationToken` 被取消而提前结束。
    Cancelled,
}

/// 为所有 [`Future`] 提供"可取消"语义的扩展 trait。
///
/// 使用方式：
/// ```ignore
/// use codex_async_utils::OrCancelExt;
///
/// let result = some_future.or_cancel(&token).await;
/// ```
pub trait OrCancelExt: Sized {
    /// future 自身的输出类型。
    type Output;

    /// 让 future 与一个取消 token 关联。
    ///
    /// - `token` 被取消时，返回 `Err(CancelErr::Cancelled)`；
    /// - future 先完成时，返回 `Ok(Self::Output)`。
    fn or_cancel(
        self,
        token: &CancellationToken,
    ) -> impl Future<Output = Result<Self::Output, CancelErr>> + Send;
}

impl<F> OrCancelExt for F
where
    F: Future + Send,
    F::Output: Send,
{
    type Output = F::Output;

    async fn or_cancel(self, token: &CancellationToken) -> Result<Self::Output, CancelErr> {
        tokio::select! {
            _ = token.cancelled() => Err(CancelErr::Cancelled),
            res = self => Ok(res),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::time::Duration;
    use tokio::task;
    use tokio::time::sleep;

    #[tokio::test]
    async fn returns_ok_when_future_completes_first() {
        let token = CancellationToken::new();
        let value = async { 42 };

        let result = value.or_cancel(&token).await;

        assert_eq!(Ok(42), result);
    }

    #[tokio::test]
    async fn returns_err_when_token_cancelled_first() {
        let token = CancellationToken::new();
        let token_clone = token.clone();

        let cancel_handle = task::spawn(async move {
            sleep(Duration::from_millis(10)).await;
            token_clone.cancel();
        });

        let result = async {
            sleep(Duration::from_millis(100)).await;
            7
        }
        .or_cancel(&token)
        .await;

        cancel_handle.await.expect("cancel task panicked");
        assert_eq!(Err(CancelErr::Cancelled), result);
    }

    #[tokio::test]
    async fn returns_err_when_token_already_cancelled() {
        let token = CancellationToken::new();
        token.cancel();

        let result = async {
            sleep(Duration::from_millis(50)).await;
            5
        }
        .or_cancel(&token)
        .await;

        assert_eq!(Err(CancelErr::Cancelled), result);
    }
}

use crate::error::StreamError;
use crate::transport::ByteStream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::time::Duration;
use tokio::time::timeout;

/// 极简 SSE 辅助函数：将底层字节流中的原始 `data:` 帧以 UTF-8 字符串形式转发。
///
/// 错误与空闲超时会以 `Err(StreamError)` 形式发送，然后任务退出。
///
/// 参数：
/// - `stream`：底层字节流（通常是 HTTP 响应体）。
/// - `idle_timeout`：两次事件之间的最大允许间隔，超时即报错退出。
/// - `tx`：用于推送 `Result<String, StreamError>` 的 mpsc 发送端。
pub fn sse_stream(
    stream: ByteStream,
    idle_timeout: Duration,
    tx: mpsc::Sender<Result<String, StreamError>>,
) {
    tokio::spawn(async move {
        let mut stream = stream
            .map(|res| res.map_err(|e| StreamError::Stream(e.to_string())))
            .eventsource();

        loop {
            match timeout(idle_timeout, stream.next()).await {
                Ok(Some(Ok(ev))) => {
                    if tx.send(Ok(ev.data.clone())).await.is_err() {
                        return;
                    }
                }
                Ok(Some(Err(e))) => {
                    let _ = tx.send(Err(StreamError::Stream(e.to_string()))).await;
                    return;
                }
                Ok(None) => {
                    let _ = tx
                        .send(Err(StreamError::Stream(
                            "stream closed before completion".into(),
                        )))
                        .await;
                    return;
                }
                Err(_) => {
                    let _ = tx.send(Err(StreamError::Timeout)).await;
                    return;
                }
            }
        }
    });
}

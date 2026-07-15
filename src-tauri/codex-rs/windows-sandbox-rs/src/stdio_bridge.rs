use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use codex_utils_pty::SpawnedProcess;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

/// 将当前进程的 stdio 转发给 Windows sandbox session，并返回 session 的退出码。
pub async fn forward_sandbox_session_stdio(spawned: SpawnedProcess) -> i32 {
    let session = Arc::new(spawned.session);
    let tokio_runtime = tokio::runtime::Handle::current();
    // 给大体积或慢速的尾部 output 更多时间完成排空，同时避免罕见的 EOF 问题
    // 导致 wrapper 无限挂起。
    let output_drain_timeout = Duration::from_secs(5);
    // 一个 helper thread 监视我们的 stdin。当输入源关闭时，该 thread
    // 会通知主异步代码，以便我们同时关闭 sandboxed child process 的 stdin。
    let (stdin_eof_tx, stdin_eof_rx) = oneshot::channel();

    // 启动 background threads 来复制 stdin/stdout/stderr。我们有意不保留
    // 它们的 JoinHandles；丢弃 handle 并不会停止 thread，只是意味着后续不再等待它结束。
    // 这些 thread 会在管道关闭或 EOF 后自然退出。
    drop(spawn_input_forwarder(
        std::io::stdin(),
        session.writer_sender(),
        stdin_eof_tx,
    ));
    let (stdout_forwarder, stdout_forwarder_done_rx) =
        spawn_output_forwarder(tokio_runtime.clone(), spawned.stdout_rx, std::io::stdout());
    drop(stdout_forwarder);
    let (stderr_forwarder, stderr_forwarder_done_rx) =
        spawn_output_forwarder(tokio_runtime.clone(), spawned.stderr_rx, std::io::stderr());
    drop(stderr_forwarder);

    let stdin_close_task = tokio::spawn({
        let session = Arc::clone(&session);
        async move {
            let _ = stdin_eof_rx.await;
            session.close_stdin();
        }
    });

    let mut exit_rx = spawned.exit_rx;
    let exit_code = tokio::select! {
        res = &mut exit_rx => res.unwrap_or(-1),
        res = tokio::signal::ctrl_c() => {
            if let Ok(()) = res {
                session.request_terminate();
            }
            exit_rx.await.unwrap_or(-1)
        }
    };

    stdin_close_task.abort();
    let _ = tokio::time::timeout(output_drain_timeout, async {
        let _ = stdout_forwarder_done_rx.await;
        let _ = stderr_forwarder_done_rx.await;
    })
    .await;
    exit_code
}

fn spawn_input_forwarder<R>(
    mut input: R,
    writer_tx: mpsc::Sender<Vec<u8>>,
    stdin_eof_tx: oneshot::Sender<()>,
) -> std::thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    const STDIN_FORWARD_CHUNK_SIZE: usize = 8 * 1024;
    std::thread::spawn(move || {
        let mut buffer = [0_u8; STDIN_FORWARD_CHUNK_SIZE];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if writer_tx.blocking_send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => {
                    eprintln!("windows sandbox stdin forwarder failed: {err}");
                    break;
                }
            }
        }
        let _ = stdin_eof_tx.send(());
    })
}

fn spawn_output_forwarder<W>(
    tokio_runtime: tokio::runtime::Handle,
    output_rx: mpsc::Receiver<Vec<u8>>,
    mut writer: W,
) -> (std::thread::JoinHandle<()>, oneshot::Receiver<()>)
where
    W: Write + Send + 'static,
{
    let (done_tx, done_rx) = oneshot::channel();
    // sandbox session 通过 Tokio channels 发送 output，但从 dedicated 的阻塞 thread
    // 写入调用方的 stdio 最为简单，因为 stdio 的写入是阻塞 I/O 操作，
    // 不适合在 Tokio 的异步上下文中直接执行。
    let handle = std::thread::spawn(move || {
        let mut output_rx = output_rx;
        while let Some(chunk) = tokio_runtime.block_on(output_rx.recv()) {
            if let Err(err) = writer.write_all(&chunk) {
                eprintln!("windows sandbox output forwarder failed to write: {err}");
                break;
            }
            if let Err(err) = writer.flush() {
                eprintln!("windows sandbox output forwarder failed to flush: {err}");
                break;
            }
        }
        let _ = done_tx.send(());
    });
    (handle, done_rx)
}

#[cfg(test)]
#[path = "stdio_bridge_tests.rs"]
mod tests;

use crate::error_code::invalid_request;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingMessageSender;
use codex_app_server_protocol::FsChangedNotification;
use codex_app_server_protocol::FsUnwatchParams;
use codex_app_server_protocol::FsUnwatchResponse;
use codex_app_server_protocol::FsWatchParams;
use codex_app_server_protocol::FsWatchResponse;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::ServerNotification;
use codex_file_watcher::DebouncedWatchReceiver;
use codex_file_watcher::FileWatcher;
use codex_file_watcher::FileWatcherSubscriber;
use codex_file_watcher::WatchPath;
use codex_file_watcher::WatchRegistration;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::hash::Hash;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
#[cfg(test)]
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tracing::warn;

/// 文件变更通知的去抖动间隔，避免短时间内大量通知刷屏。
const FS_CHANGED_NOTIFICATION_DEBOUNCE: Duration = Duration::from_millis(200);

/// 文件系统监视管理器。
///
/// 为每个 `(connection_id, watch_id)` 维护一个独立的 watch 条目，将底层
/// `FileWatcher` 的事件转换为 app-server 协议的 `FsChangedNotification` 通知
/// 下发给对应连接。当连接关闭时，所有属于该连接的 watch 会被一并清理。
#[derive(Clone)]
pub(crate) struct FsWatchManager {
    outgoing: Arc<OutgoingMessageSender>,
    file_watcher: Arc<FileWatcher>,
    state: Arc<AsyncMutex<FsWatchState>>,
}

/// `FsWatchManager` 的可变状态。
///
/// 通过 `AsyncMutex` 保护，按 `WatchKey` 索引 watch 条目。
#[derive(Default)]
struct FsWatchState {
    entries: HashMap<WatchKey, WatchEntry>,
}

/// 单个 watch 条目。
///
/// 持有终止信号 sender、文件订阅者与路径注册句柄。当条目被 drop 时，
/// `_subscriber` / `_registration` 会自动解除订阅与取消注册。
struct WatchEntry {
    terminate_tx: oneshot::Sender<oneshot::Sender<()>>,
    _subscriber: FileWatcherSubscriber,
    _registration: WatchRegistration,
}

/// watch 条目的唯一键。
///
/// 由 `(connection_id, watch_id)` 组成，确保同一连接内 `watch_id` 唯一，
/// 不同连接可复用 `watch_id`。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct WatchKey {
    connection_id: ConnectionId,
    watch_id: String,
}

impl FsWatchManager {
    /// 创建一个新的 `FsWatchManager`。
    ///
    /// 尝试初始化底层 `FileWatcher`；若失败（例如平台不支持），回退到 no-op
    /// watcher，使服务器仍可启动但不会下发任何文件变更通知。
    pub(crate) fn new(outgoing: Arc<OutgoingMessageSender>) -> Self {
        let file_watcher = match FileWatcher::new() {
            Ok(file_watcher) => Arc::new(file_watcher),
            Err(err) => {
                warn!("filesystem watch manager falling back to noop core watcher: {err}");
                Arc::new(FileWatcher::noop())
            }
        };
        Self::new_with_file_watcher(outgoing, file_watcher)
    }

    /// 使用指定的 `FileWatcher` 构造管理器，主要用于测试注入。
    fn new_with_file_watcher(
        outgoing: Arc<OutgoingMessageSender>,
        file_watcher: Arc<FileWatcher>,
    ) -> Self {
        Self {
            outgoing,
            file_watcher,
            state: Arc::new(AsyncMutex::new(FsWatchState::default())),
        }
    }

    /// 为指定连接注册一个新的文件监视。
    ///
    /// 创建订阅者、注册监视路径，并启动一个独立任务监听文件变更事件，将其
    /// 转换为 `FsChangedNotification` 下发给对应连接。
    ///
    /// # 参数
    ///
    /// - `connection_id`: 发起 watch 的连接 ID
    /// - `params`: watch 参数，包含 `watch_id` 与 `path`
    ///
    /// # 错误
    ///
    /// 当 `watch_id` 在该连接内已存在时，返回 `invalid_request` 错误。
    pub(crate) async fn watch(
        &self,
        connection_id: ConnectionId,
        params: FsWatchParams,
    ) -> Result<FsWatchResponse, JSONRPCErrorError> {
        let watch_id = params.watch_id;
        let watch_key = WatchKey {
            connection_id,
            watch_id: watch_id.clone(),
        };
        let outgoing = self.outgoing.clone();
        let (subscriber, rx) = self.file_watcher.add_subscriber();
        let watch_root = params.path.clone();
        let registration = subscriber.register_paths(vec![WatchPath {
            path: params.path.to_path_buf(),
            recursive: false,
        }]);
        let (terminate_tx, terminate_rx) = oneshot::channel();

        match self.state.lock().await.entries.entry(watch_key) {
            Entry::Occupied(_) => {
                return Err(invalid_request(format!(
                    "watchId already exists: {watch_id}"
                )));
            }
            Entry::Vacant(entry) => {
                entry.insert(WatchEntry {
                    terminate_tx,
                    _subscriber: subscriber,
                    _registration: registration,
                });
            }
        }

        let task_watch_id = watch_id.clone();
        tokio::spawn(async move {
            let mut rx = DebouncedWatchReceiver::new(rx, FS_CHANGED_NOTIFICATION_DEBOUNCE);
            tokio::pin!(terminate_rx);
            loop {
                let event = tokio::select! {
                    biased;
                    _ = &mut terminate_rx => break,
                    event = rx.recv() => match event {
                        Some(event) => event,
                        None => break,
                    },
                };
                let mut changed_paths = event
                    .paths
                    .into_iter()
                    .map(|path| watch_root.join(path))
                    .collect::<Vec<_>>();
                changed_paths.sort_by(|left, right| left.as_path().cmp(right.as_path()));
                if !changed_paths.is_empty() {
                    outgoing
                        .send_server_notification_to_connection_and_wait(
                            connection_id,
                            ServerNotification::FsChanged(FsChangedNotification {
                                watch_id: task_watch_id.clone(),
                                changed_paths,
                            }),
                        )
                        .await;
                }
            }
        });

        Ok(FsWatchResponse { path: params.path })
    }

    /// 取消指定连接的某个 watch。
    ///
    /// 移除对应的 watch 条目，并通过 oneshot 通知 watch 任务退出。
    /// 等待 watch 任务确认退出后再返回，确保 unwatch 响应之后不会再有
    /// 该 watch 的通知下发。
    ///
    /// # 参数
    ///
    /// - `connection_id`: 发起 unwatch 的连接 ID
    /// - `params`: unwatch 参数，包含 `watch_id`
    ///
    /// # 返回值
    ///
    /// 始终返回空的 `FsUnwatchResponse`；若 `watch_id` 不存在则为 no-op。
    pub(crate) async fn unwatch(
        &self,
        connection_id: ConnectionId,
        params: FsUnwatchParams,
    ) -> Result<FsUnwatchResponse, JSONRPCErrorError> {
        let watch_key = WatchKey {
            connection_id,
            watch_id: params.watch_id,
        };
        let entry = self.state.lock().await.entries.remove(&watch_key);
        if let Some(entry) = entry {
            // 等待 oneshot 被 watch 任务销毁，确保 unwatch 响应之后
            // 不会再下发任何通知。
            let (done_tx, done_rx) = oneshot::channel();
            let _ = entry.terminate_tx.send(done_tx);
            let _ = done_rx.await;
        }
        Ok(FsUnwatchResponse {})
    }

    /// 当连接关闭时调用，清理该连接下的所有 watch 条目。
    ///
    /// 注意：此方法仅移除状态表中的条目，watch 任务会因 `_subscriber` /
    /// `_registration` 被 drop 而自然退出，不显式等待任务结束。
    pub(crate) async fn connection_closed(&self, connection_id: ConnectionId) {
        let mut state = self.state.lock().await;
        state
            .entries
            .extract_if(|key, _| key.connection_id == connection_id)
            .count();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use pretty_assertions::assert_eq;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn absolute_path(path: PathBuf) -> AbsolutePathBuf {
        assert!(
            path.is_absolute(),
            "path must be absolute: {}",
            path.display()
        );
        AbsolutePathBuf::try_from(path).expect("path should be absolute")
    }

    fn manager_with_noop_watcher() -> FsWatchManager {
        const OUTGOING_BUFFER: usize = 1;
        let (tx, _rx) = mpsc::channel(OUTGOING_BUFFER);
        FsWatchManager::new_with_file_watcher(
            Arc::new(OutgoingMessageSender::new(
                tx,
                codex_analytics::AnalyticsEventsClient::disabled(),
            )),
            Arc::new(FileWatcher::noop()),
        )
    }

    #[tokio::test]
    async fn watch_uses_client_id_and_tracks_the_owner_scoped_entry() {
        let temp_dir = TempDir::new().expect("temp dir");
        let head_path = temp_dir.path().join("HEAD");
        std::fs::write(&head_path, "ref: refs/heads/main\n").expect("write HEAD");

        let manager = manager_with_noop_watcher();
        let path = absolute_path(head_path);
        let watch_id = "watch-head".to_string();
        let response = manager
            .watch(
                ConnectionId(1),
                FsWatchParams {
                    watch_id: watch_id.clone(),
                    path: path.clone(),
                },
            )
            .await
            .expect("watch should succeed");

        assert_eq!(response.path, path);

        let state = manager.state.lock().await;
        assert_eq!(
            state.entries.keys().cloned().collect::<HashSet<_>>(),
            HashSet::from([WatchKey {
                connection_id: ConnectionId(1),
                watch_id,
            }])
        );
    }

    #[tokio::test]
    async fn unwatch_is_scoped_to_the_connection_that_created_the_watch() {
        let temp_dir = TempDir::new().expect("temp dir");
        let head_path = temp_dir.path().join("HEAD");
        std::fs::write(&head_path, "ref: refs/heads/main\n").expect("write HEAD");

        let manager = manager_with_noop_watcher();
        manager
            .watch(
                ConnectionId(1),
                FsWatchParams {
                    watch_id: "watch-head".to_string(),
                    path: absolute_path(head_path),
                },
            )
            .await
            .expect("watch should succeed");
        let watch_key = WatchKey {
            connection_id: ConnectionId(1),
            watch_id: "watch-head".to_string(),
        };

        manager
            .unwatch(
                ConnectionId(2),
                FsUnwatchParams {
                    watch_id: "watch-head".to_string(),
                },
            )
            .await
            .expect("foreign unwatch should be a no-op");
        assert!(manager.state.lock().await.entries.contains_key(&watch_key));

        manager
            .unwatch(
                ConnectionId(1),
                FsUnwatchParams {
                    watch_id: "watch-head".to_string(),
                },
            )
            .await
            .expect("owner unwatch should succeed");
        assert!(!manager.state.lock().await.entries.contains_key(&watch_key));
    }

    #[tokio::test]
    async fn watch_rejects_duplicate_id_for_the_same_connection() {
        let temp_dir = TempDir::new().expect("temp dir");
        let head_path = temp_dir.path().join("HEAD");
        let fetch_head_path = temp_dir.path().join("FETCH_HEAD");
        std::fs::write(&head_path, "ref: refs/heads/main\n").expect("write HEAD");
        std::fs::write(&fetch_head_path, "old-fetch\n").expect("write FETCH_HEAD");

        let manager = manager_with_noop_watcher();
        manager
            .watch(
                ConnectionId(1),
                FsWatchParams {
                    watch_id: "watch-head".to_string(),
                    path: absolute_path(head_path),
                },
            )
            .await
            .expect("first watch should succeed");

        let error = manager
            .watch(
                ConnectionId(1),
                FsWatchParams {
                    watch_id: "watch-head".to_string(),
                    path: absolute_path(fetch_head_path),
                },
            )
            .await
            .expect_err("duplicate watch should fail");

        assert_eq!(error.message, "watchId already exists: watch-head");
        assert_eq!(manager.state.lock().await.entries.len(), 1);
    }

    #[tokio::test]
    async fn connection_closed_removes_only_that_connections_watches() {
        let temp_dir = TempDir::new().expect("temp dir");
        let head_path = temp_dir.path().join("HEAD");
        let fetch_head_path = temp_dir.path().join("FETCH_HEAD");
        let packed_refs_path = temp_dir.path().join("packed-refs");
        std::fs::write(&head_path, "ref: refs/heads/main\n").expect("write HEAD");
        std::fs::write(&fetch_head_path, "old-fetch\n").expect("write FETCH_HEAD");
        std::fs::write(&packed_refs_path, "refs\n").expect("write packed-refs");

        let manager = manager_with_noop_watcher();
        let response = manager
            .watch(
                ConnectionId(1),
                FsWatchParams {
                    watch_id: "watch-head".to_string(),
                    path: absolute_path(head_path.clone()),
                },
            )
            .await
            .expect("first watch should succeed");
        manager
            .watch(
                ConnectionId(1),
                FsWatchParams {
                    watch_id: "watch-fetch-head".to_string(),
                    path: absolute_path(fetch_head_path),
                },
            )
            .await
            .expect("second watch should succeed");
        manager
            .watch(
                ConnectionId(2),
                FsWatchParams {
                    watch_id: "watch-packed-refs".to_string(),
                    path: absolute_path(packed_refs_path),
                },
            )
            .await
            .expect("third watch should succeed");

        manager.connection_closed(ConnectionId(1)).await;

        assert_eq!(
            manager
                .state
                .lock()
                .await
                .entries
                .keys()
                .cloned()
                .collect::<HashSet<_>>(),
            HashSet::from([WatchKey {
                connection_id: ConnectionId(2),
                watch_id: "watch-packed-refs".to_string(),
            }])
        );
        assert_eq!(response.path, absolute_path(head_path));
    }
}

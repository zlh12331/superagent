//! 文件监视模块。
//!
//! 本 crate 监视已订阅的文件或目录，并将粗粒度的变更通知路由到
//! 拥有匹配监视路径的订阅者。基于 `notify` crate 实现跨平台文件系统监控，
//! 支持多订阅者、引用计数、路径规范化、缺失路径回退等高级特性。

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use notify::Event;
use notify::EventKind;
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify::Watcher;
use tokio::runtime::Handle;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio::time::sleep_until;
use tracing::warn;

/// 合并后的文件变更通知，发送给单个订阅者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileWatcherEvent {
    /// 变更路径列表（已排序并去重）。
    pub paths: Vec<PathBuf>,
}

/// 由 [`FileWatcherSubscriber`] 注册的路径订阅。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WatchPath {
    /// 要监视的根路径。
    pub path: PathBuf,
    /// `path` 下的事件是否递归匹配。
    pub recursive: bool,
}

type SubscriberId = u64;

#[derive(Default)]
struct WatchState {
    next_subscriber_id: SubscriberId,
    path_ref_counts: HashMap<PathBuf, PathWatchCounts>,
    subscribers: HashMap<SubscriberId, SubscriberState>,
}

struct SubscriberState {
    watched_paths: HashMap<SubscriberWatchKey, SubscriberWatchState>,
    tx: WatchSender,
}

/// 不可变的每订阅者监视标识。
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SubscriberWatchKey {
    /// 订阅者请求的原始路径。通知以此命名空间报告，
    /// 使客户端不会看到规范化产生的路径差异。
    requested: WatchPath,
    /// `requested` 的规范化等价路径，用于匹配后端事件。
    /// 某些后端会报告规范化路径（如 `/private/var/...`），
    /// 即使监视是通过 `/var/...` 注册的。
    matched: WatchPath,
}

/// 可变的每订阅者监视状态。
struct SubscriberWatchState {
    /// 传递给 OS watcher 并用于引用计数的实际路径。
    /// 通常为 `requested`，但缺失目标会使用已有的祖先路径。
    actual: WatchPath,
    count: usize,
    /// 上次处理祖先事件时，请求路径是否存在。
    /// 用于为回退监视保留删除通知。
    last_exists: bool,
    /// 此监视是否始于缺失路径的回退。
    /// 此类监视将祖先的创建/删除事件归一化回 `requested`。
    fallback: bool,
}

/// 注册时的监视数据，在合并到订阅者状态之前使用。
///
/// key 用于注销时保持稳定标识，而 `actual` 可能随后续路径组件的创建
/// 逐渐移近请求路径。
#[derive(Clone)]
struct SubscriberWatchRegistration {
    /// 此注册的不可变订阅者可见标识。
    key: SubscriberWatchKey,
    /// 初始传递给 OS watcher 的已有路径。
    actual: WatchPath,
    /// 注册是否始于缺失路径回退。
    fallback: bool,
}

/// 接收单个订阅者的合并变更通知。
pub struct Receiver {
    inner: Arc<ReceiverInner>,
}

struct WatchSender {
    inner: Arc<ReceiverInner>,
}

struct ReceiverInner {
    changed_paths: AsyncMutex<BTreeSet<PathBuf>>,
    notify: Notify,
    sender_count: AtomicUsize,
}

impl Receiver {
    /// 等待下一批变更路径，或在对应订阅者被移除且不再有事件时返回 `None`。
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        loop {
            let notified = self.inner.notify.notified();
            {
                let mut changed_paths = self.inner.changed_paths.lock().await;
                if !changed_paths.is_empty() {
                    return Some(FileWatcherEvent {
                        paths: std::mem::take(&mut *changed_paths).into_iter().collect(),
                    });
                }
                if self.inner.sender_count.load(Ordering::Acquire) == 0 {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl WatchSender {
    async fn add_changed_paths(&self, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }

        let mut changed_paths = self.inner.changed_paths.lock().await;
        let previous_len = changed_paths.len();
        changed_paths.extend(paths.iter().cloned());
        if changed_paths.len() != previous_len {
            self.inner.notify.notify_one();
        }
    }
}

impl Clone for WatchSender {
    fn clone(&self) -> Self {
        self.inner.sender_count.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl Drop for WatchSender {
    fn drop(&mut self) {
        if self.inner.sender_count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.inner.notify.notify_waiters();
        }
    }
}

fn watch_channel() -> (WatchSender, Receiver) {
    let inner = Arc::new(ReceiverInner {
        changed_paths: AsyncMutex::new(BTreeSet::new()),
        notify: Notify::new(),
        sender_count: AtomicUsize::new(1),
    });
    (
        WatchSender {
            inner: Arc::clone(&inner),
        },
        Receiver { inner },
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PathWatchCounts {
    non_recursive: usize,
    recursive: usize,
}

impl PathWatchCounts {
    fn increment(&mut self, recursive: bool, amount: usize) {
        if recursive {
            self.recursive += amount;
        } else {
            self.non_recursive += amount;
        }
    }

    fn decrement(&mut self, recursive: bool, amount: usize) {
        if recursive {
            self.recursive = self.recursive.saturating_sub(amount);
        } else {
            self.non_recursive = self.non_recursive.saturating_sub(amount);
        }
    }

    fn effective_mode(self) -> Option<RecursiveMode> {
        if self.recursive > 0 {
            Some(RecursiveMode::Recursive)
        } else if self.non_recursive > 0 {
            Some(RecursiveMode::NonRecursive)
        } else {
            None
        }
    }

    fn is_empty(self) -> bool {
        self.non_recursive == 0 && self.recursive == 0
    }
}

struct FileWatcherInner {
    watcher: RecommendedWatcher,
    watched_paths: HashMap<PathBuf, RecursiveMode>,
}

/// 合并突发监视通知，在每个时间间隔内最多发出一次。
pub struct ThrottledWatchReceiver {
    rx: Receiver,
    interval: Duration,
    next_allowed: Option<Instant>,
}

impl ThrottledWatchReceiver {
    /// 在原始 watcher [`Receiver`] 外包裹一层节流逻辑。
    pub fn new(rx: Receiver, interval: Duration) -> Self {
        Self {
            rx,
            interval,
            next_allowed: None,
        }
    }

    /// 接收下一个事件，在上次发出后强制执行配置的最小延迟。
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        if let Some(next_allowed) = self.next_allowed {
            sleep_until(next_allowed).await;
        }

        let event = self.rx.recv().await;
        if event.is_some() {
            self.next_allowed = Some(Instant::now() + self.interval);
        }
        event
    }
}

/// 合并文件 watcher 通知，在每批首个事件后的固定去抖窗口内收集变更。
pub struct DebouncedWatchReceiver {
    rx: Receiver,
    interval: Duration,
    changed_paths: BTreeSet<PathBuf>,
}

impl DebouncedWatchReceiver {
    /// 在原始 watcher [`Receiver`] 外包裹一层去抖逻辑。
    pub fn new(rx: Receiver, interval: Duration) -> Self {
        Self {
            rx,
            interval,
            changed_paths: BTreeSet::new(),
        }
    }

    /// 接收下一个去抖后的事件批次。
    pub async fn recv(&mut self) -> Option<FileWatcherEvent> {
        while self.changed_paths.is_empty() {
            self.changed_paths.extend(self.rx.recv().await?.paths);
        }
        let deadline = Instant::now() + self.interval;

        loop {
            tokio::select! {
                event = self.rx.recv() => match event {
                    Some(event) => self.changed_paths.extend(event.paths),
                    None => break,
                },
                _ = sleep_until(deadline) => break,
            }
        }

        Some(FileWatcherEvent {
            paths: std::mem::take(&mut self.changed_paths)
                .into_iter()
                .collect(),
        })
    }
}

/// 用于为单个逻辑消费者注册监视路径的句柄。
pub struct FileWatcherSubscriber {
    id: SubscriberId,
    file_watcher: Arc<FileWatcher>,
}

impl FileWatcherSubscriber {
    /// 为此订阅者注册提供的路径，返回一个 RAII 守卫，
    /// 在 drop 时自动注销这些路径。
    pub fn register_paths(&self, watched_paths: Vec<WatchPath>) -> WatchRegistration {
        let watched_paths = dedupe_watched_paths(watched_paths)
            .into_iter()
            .map(|requested| {
                let (actual, matched, fallback) = actual_watch_path(&requested);
                let key = SubscriberWatchKey { requested, matched };
                SubscriberWatchRegistration {
                    key,
                    actual,
                    fallback,
                }
            })
            .collect::<Vec<_>>();
        self.file_watcher.register_paths(self.id, &watched_paths);

        WatchRegistration {
            file_watcher: Arc::downgrade(&self.file_watcher),
            subscriber_id: self.id,
            watched_paths: watched_paths
                .iter()
                .map(|watch| watch.key.clone())
                .collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn register_path(&self, path: PathBuf, recursive: bool) -> WatchRegistration {
        self.register_paths(vec![WatchPath { path, recursive }])
    }
}

impl Drop for FileWatcherSubscriber {
    fn drop(&mut self) {
        self.file_watcher.remove_subscriber(self.id);
    }
}

/// 一组活动路径注册的 RAII 守卫。
pub struct WatchRegistration {
    file_watcher: std::sync::Weak<FileWatcher>,
    subscriber_id: SubscriberId,
    watched_paths: Vec<SubscriberWatchKey>,
}

impl Default for WatchRegistration {
    fn default() -> Self {
        Self {
            file_watcher: std::sync::Weak::new(),
            subscriber_id: 0,
            watched_paths: Vec::new(),
        }
    }
}

impl Drop for WatchRegistration {
    fn drop(&mut self) {
        if let Some(file_watcher) = self.file_watcher.upgrade() {
            file_watcher.unregister_paths(self.subscriber_id, &self.watched_paths);
        }
    }
}

/// 基于 `notify` 的多订阅者文件 watcher。
pub struct FileWatcher {
    inner: Option<Arc<Mutex<FileWatcherInner>>>,
    state: Arc<RwLock<WatchState>>,
}

impl FileWatcher {
    /// 创建活跃的文件系统 watcher，并在当前 Tokio runtime 上启动后台事件循环。
    pub fn new() -> notify::Result<Self> {
        let (raw_tx, raw_rx) = mpsc::unbounded_channel();
        let raw_tx_clone = raw_tx;
        let watcher = notify::recommended_watcher(move |res| {
            let _ = raw_tx_clone.send(res);
        })?;
        let inner = FileWatcherInner {
            watcher,
            watched_paths: HashMap::new(),
        };
        let state = Arc::new(RwLock::new(WatchState::default()));
        let file_watcher = Self {
            inner: Some(Arc::new(Mutex::new(inner))),
            state,
        };
        file_watcher.spawn_event_loop(raw_rx);
        Ok(file_watcher)
    }

    /// 创建一个惰性 watcher，仅支持测试驱动的合成通知。
    pub fn noop() -> Self {
        Self {
            inner: None,
            state: Arc::new(RwLock::new(WatchState::default())),
        }
    }

    /// 添加新订阅者，返回其注册句柄和专属事件接收器。
    pub fn add_subscriber(self: &Arc<Self>) -> (FileWatcherSubscriber, Receiver) {
        let (tx, rx) = watch_channel();
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let subscriber_id = state.next_subscriber_id;
        state.next_subscriber_id += 1;
        state.subscribers.insert(
            subscriber_id,
            SubscriberState {
                watched_paths: HashMap::new(),
                tx,
            },
        );

        let subscriber = FileWatcherSubscriber {
            id: subscriber_id,
            file_watcher: self.clone(),
        };
        (subscriber, rx)
    }

    fn register_paths(
        &self,
        subscriber_id: SubscriberId,
        watched_paths: &[SubscriberWatchRegistration],
    ) {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut inner_guard: Option<std::sync::MutexGuard<'_, FileWatcherInner>> = None;

        for registration in watched_paths {
            let actual = {
                let Some(subscriber) = state.subscribers.get_mut(&subscriber_id) else {
                    return;
                };
                match subscriber.watched_paths.entry(registration.key.clone()) {
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        entry.get_mut().count += 1;
                        entry.get().actual.clone()
                    }
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(SubscriberWatchState {
                            actual: registration.actual.clone(),
                            count: 1,
                            last_exists: registration.key.matched.path.exists(),
                            fallback: registration.fallback,
                        });
                        registration.actual.clone()
                    }
                }
            };

            let counts = state
                .path_ref_counts
                .entry(actual.path.clone())
                .or_default();
            let previous_mode = counts.effective_mode();
            counts.increment(actual.recursive, /*amount*/ 1);
            let next_mode = counts.effective_mode();
            if previous_mode != next_mode {
                self.reconfigure_watch(&actual.path, next_mode, &mut inner_guard);
            }
        }
    }

    fn unregister_paths(&self, subscriber_id: SubscriberId, watched_paths: &[SubscriberWatchKey]) {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut inner_guard: Option<std::sync::MutexGuard<'_, FileWatcherInner>> = None;

        for subscriber_watch in watched_paths {
            let actual = {
                let Some(subscriber) = state.subscribers.get_mut(&subscriber_id) else {
                    return;
                };
                let Some(subscriber_watch_state) =
                    subscriber.watched_paths.get_mut(subscriber_watch)
                else {
                    continue;
                };
                let actual = subscriber_watch_state.actual.clone();
                subscriber_watch_state.count = subscriber_watch_state.count.saturating_sub(1);
                if subscriber_watch_state.count == 0 {
                    subscriber.watched_paths.remove(subscriber_watch);
                }
                actual
            };

            let Some(counts) = state.path_ref_counts.get_mut(&actual.path) else {
                continue;
            };
            let previous_mode = counts.effective_mode();
            counts.decrement(actual.recursive, /*amount*/ 1);
            let next_mode = counts.effective_mode();
            if counts.is_empty() {
                state.path_ref_counts.remove(&actual.path);
            }
            if previous_mode != next_mode {
                self.reconfigure_watch(&actual.path, next_mode, &mut inner_guard);
            }
        }
    }

    fn remove_subscriber(&self, subscriber_id: SubscriberId) {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(subscriber) = state.subscribers.remove(&subscriber_id) else {
            return;
        };

        let mut inner_guard: Option<std::sync::MutexGuard<'_, FileWatcherInner>> = None;
        for (_subscriber_watch, subscriber_watch_state) in subscriber.watched_paths {
            let Some(path_counts) = state
                .path_ref_counts
                .get_mut(&subscriber_watch_state.actual.path)
            else {
                continue;
            };
            let previous_mode = path_counts.effective_mode();
            path_counts.decrement(
                subscriber_watch_state.actual.recursive,
                subscriber_watch_state.count,
            );
            let next_mode = path_counts.effective_mode();
            if path_counts.is_empty() {
                state
                    .path_ref_counts
                    .remove(&subscriber_watch_state.actual.path);
            }
            if previous_mode != next_mode {
                self.reconfigure_watch(
                    &subscriber_watch_state.actual.path,
                    next_mode,
                    &mut inner_guard,
                );
            }
        }
    }

    fn reconfigure_watch<'a>(
        &'a self,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) {
        Self::reconfigure_watch_inner(self.inner.as_ref(), path, next_mode, inner_guard);
    }

    fn reconfigure_watch_inner<'a>(
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        path: &Path,
        next_mode: Option<RecursiveMode>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) {
        let Some(inner) = inner else {
            return;
        };
        if inner_guard.is_none() {
            let guard = inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *inner_guard = Some(guard);
        }
        let Some(guard) = inner_guard.as_mut() else {
            return;
        };

        let existing_mode = guard.watched_paths.get(path).copied();
        if existing_mode == next_mode {
            return;
        }

        if existing_mode.is_some() {
            if let Err(err) = guard.watcher.unwatch(path) {
                warn!("failed to unwatch {}: {err}", path.display());
            }
            guard.watched_paths.remove(path);
        }

        let Some(next_mode) = next_mode else {
            return;
        };
        if !path.exists() {
            return;
        }

        if let Err(err) = guard.watcher.watch(path, next_mode) {
            warn!("failed to watch {}: {err}", path.display());
            return;
        }
        guard.watched_paths.insert(path.to_path_buf(), next_mode);
    }

    fn apply_actual_watch_move<'a>(
        path_ref_counts: &mut HashMap<PathBuf, PathWatchCounts>,
        old_actual: WatchPath,
        new_actual: WatchPath,
        count: usize,
        inner: Option<&'a Arc<Mutex<FileWatcherInner>>>,
        inner_guard: &mut Option<std::sync::MutexGuard<'a, FileWatcherInner>>,
    ) {
        if old_actual == new_actual {
            return;
        }

        if let Some(counts) = path_ref_counts.get_mut(&old_actual.path) {
            let previous_mode = counts.effective_mode();
            counts.decrement(old_actual.recursive, count);
            let next_mode = counts.effective_mode();
            if counts.is_empty() {
                path_ref_counts.remove(&old_actual.path);
            }
            if previous_mode != next_mode {
                Self::reconfigure_watch_inner(inner, &old_actual.path, next_mode, inner_guard);
            }
        }

        let counts = path_ref_counts.entry(new_actual.path.clone()).or_default();
        let previous_mode = counts.effective_mode();
        counts.increment(new_actual.recursive, count);
        let next_mode = counts.effective_mode();
        if previous_mode != next_mode {
            Self::reconfigure_watch_inner(inner, &new_actual.path, next_mode, inner_guard);
        }
    }

    // 将 `notify` 的回调式事件桥接到 Tokio runtime，
    // 并通知匹配的订阅者。
    fn spawn_event_loop(&self, mut raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>) {
        if let Ok(handle) = Handle::try_current() {
            let state = Arc::clone(&self.state);
            let inner = self.inner.as_ref().map(Arc::downgrade);
            handle.spawn(async move {
                loop {
                    match raw_rx.recv().await {
                        Some(Ok(event)) => {
                            if !is_mutating_event(&event) {
                                continue;
                            }
                            if event.paths.is_empty() {
                                continue;
                            }
                            let inner = inner.as_ref().and_then(std::sync::Weak::upgrade);
                            Self::notify_subscribers(&state, inner.as_ref(), &event.paths).await;
                        }
                        Some(Err(err)) => {
                            warn!("file watcher error: {err}");
                        }
                        None => break,
                    }
                }
            });
        } else {
            warn!("file watcher loop skipped: no Tokio runtime available");
        }
    }

    async fn notify_subscribers(
        state: &RwLock<WatchState>,
        inner: Option<&Arc<Mutex<FileWatcherInner>>>,
        event_paths: &[PathBuf],
    ) {
        let subscribers_to_notify: Vec<(WatchSender, Vec<PathBuf>)> = {
            let mut state = state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut actual_watch_moves = Vec::new();
            let mut subscribers_to_notify = Vec::new();

            for subscriber in state.subscribers.values_mut() {
                let mut changed_paths = Vec::new();
                for event_path in event_paths {
                    for (subscriber_watch, subscriber_watch_state) in &mut subscriber.watched_paths
                    {
                        if let Some(path) = changed_path_for_event(
                            subscriber_watch,
                            subscriber_watch_state,
                            event_path,
                        ) {
                            changed_paths.push(path);
                        }

                        let (new_actual, _new_matched, fallback) =
                            actual_watch_path(&subscriber_watch.requested);
                        subscriber_watch_state.fallback |= fallback;
                        if subscriber_watch_state.actual != new_actual {
                            let old_actual = subscriber_watch_state.actual.clone();
                            let count = subscriber_watch_state.count;
                            subscriber_watch_state.actual = new_actual.clone();
                            actual_watch_moves.push((old_actual, new_actual, count));
                        }
                    }
                }
                if !changed_paths.is_empty() {
                    subscribers_to_notify.push((subscriber.tx.clone(), changed_paths));
                }
            }

            let mut inner_guard: Option<std::sync::MutexGuard<'_, FileWatcherInner>> = None;
            for (old_actual, new_actual, count) in actual_watch_moves {
                Self::apply_actual_watch_move(
                    &mut state.path_ref_counts,
                    old_actual,
                    new_actual,
                    count,
                    inner,
                    &mut inner_guard,
                );
            }

            subscribers_to_notify
        };

        for (subscriber, changed_paths) in subscribers_to_notify {
            subscriber.add_changed_paths(&changed_paths).await;
        }
    }

    #[cfg(test)]
    pub(crate) async fn send_paths_for_test(&self, paths: Vec<PathBuf>) {
        Self::notify_subscribers(&self.state, self.inner.as_ref(), &paths).await;
    }

    #[cfg(test)]
    pub(crate) fn spawn_event_loop_for_test(
        &self,
        raw_rx: mpsc::UnboundedReceiver<notify::Result<Event>>,
    ) {
        self.spawn_event_loop(raw_rx);
    }

    #[cfg(test)]
    pub(crate) fn watch_counts_for_test(&self, path: &Path) -> Option<(usize, usize)> {
        let state = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .path_ref_counts
            .get(path)
            .map(|counts| (counts.non_recursive, counts.recursive))
    }
}

fn is_mutating_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn dedupe_watched_paths(mut watched_paths: Vec<WatchPath>) -> Vec<WatchPath> {
    watched_paths.sort_unstable_by(|a, b| {
        a.path
            .as_os_str()
            .cmp(b.path.as_os_str())
            .then(a.recursive.cmp(&b.recursive))
    });
    watched_paths.dedup();
    watched_paths
}

/// 返回请求路径对应的实际 OS 监视路径和规范化匹配路径。
///
/// 缺失目标会通过最近的已有目录祖先进行非递归监视。
/// 随着路径组件的出现，实际监视会移近请求路径，
/// 因此永远不需要宽泛的递归祖先监视。
fn actual_watch_path(requested: &WatchPath) -> (WatchPath, WatchPath, bool) {
    if requested.path.exists() {
        let matched_path = requested
            .path
            .canonicalize()
            .unwrap_or_else(|_| requested.path.clone());
        let actual = requested.clone();
        let matched = WatchPath {
            path: matched_path,
            recursive: requested.recursive,
        };
        return (actual, matched, false);
    }

    let requested_parent = requested.path.parent();
    let mut ancestor = requested_parent;
    while let Some(path) = ancestor {
        if path.is_dir() {
            let actual_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            let matched_path = requested
                .path
                .strip_prefix(path)
                .map(|suffix| actual_path.join(suffix))
                .unwrap_or_else(|_| requested.path.clone());
            let actual = WatchPath {
                path: path.to_path_buf(),
                recursive: false,
            };
            let matched = WatchPath {
                path: matched_path,
                recursive: requested.recursive,
            };
            return (actual, matched, true);
        }
        ancestor = path.parent();
    }

    (requested.clone(), requested.clone(), false)
}

/// 将一个原始后端事件路径转换为订阅者可见路径。
///
/// 匹配首先使用许多 OS 后端报告的规范化路径命名空间，
/// 然后回退到原始请求的命名空间，适用于合成测试和保留输入拼写的后端。
fn changed_path_for_event(
    subscriber_watch: &SubscriberWatchKey,
    subscriber_watch_state: &mut SubscriberWatchState,
    event_path: &Path,
) -> Option<PathBuf> {
    if let Some(path) = changed_path_for_matched_path(
        subscriber_watch,
        subscriber_watch_state,
        &subscriber_watch.matched,
        event_path,
    ) {
        return Some(path);
    }
    if subscriber_watch.matched.path == subscriber_watch.requested.path {
        return None;
    }
    changed_path_for_matched_path(
        subscriber_watch,
        subscriber_watch_state,
        &subscriber_watch.requested,
        event_path,
    )
}

/// 在一个路径命名空间中应用监视匹配规则，
/// 将任何发出的路径映射回订阅者请求的命名空间。
fn changed_path_for_matched_path(
    subscriber_watch: &SubscriberWatchKey,
    subscriber_watch_state: &mut SubscriberWatchState,
    matched: &WatchPath,
    event_path: &Path,
) -> Option<PathBuf> {
    let requested = &subscriber_watch.requested;
    if event_path == matched.path {
        subscriber_watch_state.last_exists = matched.path.exists();
        return Some(requested.path.clone());
    }
    if matched.path.starts_with(event_path) {
        let now_exists = matched.path.exists();
        if subscriber_watch_state.fallback {
            let should_notify = now_exists || subscriber_watch_state.last_exists;
            subscriber_watch_state.last_exists = now_exists;
            return should_notify.then(|| requested.path.clone());
        }
        if subscriber_watch_state.actual.path != matched.path {
            let should_notify = now_exists || subscriber_watch_state.last_exists;
            subscriber_watch_state.last_exists = now_exists;
            return should_notify.then(|| requested.path.clone());
        }
        subscriber_watch_state.last_exists = now_exists;
        return Some(event_path.to_path_buf());
    }
    if !event_path.starts_with(&matched.path) {
        return None;
    }
    if !(matched.recursive || event_path.parent() == Some(matched.path.as_path())) {
        return None;
    }
    subscriber_watch_state.last_exists = matched.path.exists();
    Some(
        event_path
            .strip_prefix(&matched.path)
            .map(|suffix| requested.path.join(suffix))
            .unwrap_or_else(|_| event_path.to_path_buf()),
    )
}

#[cfg(test)]
#[path = "file_watcher_tests.rs"]
mod tests;

#![allow(warnings, clippy::all)]

use codex_utils_path as path_utils;
use std::cmp::Reverse;
use std::ffi::OsStr;
use std::io;
use std::num::NonZero;
use std::ops::ControlFlow;
use std::path::Path;
use std::path::PathBuf;
use time::OffsetDateTime;
use time::PrimitiveDateTime;
use time::format_description::FormatItem;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use uuid::Uuid;

use super::ARCHIVED_SESSIONS_SUBDIR;
use super::SESSIONS_SUBDIR;
use super::compression;
use crate::protocol::EventMsg;
use crate::state_db;
use codex_file_search as file_search;
use codex_protocol::ThreadId;
use codex_protocol::protocol::RolloutItem;
use codex_protocol::protocol::RolloutLine;
use codex_protocol::protocol::SessionMetaLine;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::ThreadHistoryMode;
use codex_protocol::protocol::USER_MESSAGE_BEGIN;
use serde_json::Value;

/// 返回的 thread（线程）摘要分页结果。
#[derive(Debug, Default, PartialEq)]
pub struct ThreadsPage {
    /// 按从新到旧排序的 thread 摘要列表。
    pub items: Vec<ThreadItem>,
    /// 用于在最后一个条目之后继续分页的不透明游标；若已到末尾则为 `None`。
    pub next_cursor: Option<Cursor>,
    /// 本次请求扫描的文件总数。
    pub num_scanned_files: usize,
    /// 是否触发了扫描上限；若为 `true`，可考虑使用 `next_cursor` 继续。
    pub reached_scan_cap: bool,
}

/// 单个 thread rollout 文件的摘要信息。
#[derive(Debug, PartialEq, Default)]
pub struct ThreadItem {
    /// rollout 文件的绝对路径。
    pub path: PathBuf,
    /// 来自会话元数据的 thread ID。
    pub thread_id: Option<ThreadId>,
    /// 该 thread 中捕获到的第一条用户消息（若存在）。
    pub first_user_message: Option<String>,
    /// 用于发现与列表展示的最佳面向用户预览文本。
    pub preview: Option<String>,
    /// 来自会话元数据的工作目录。
    pub cwd: Option<PathBuf>,
    /// 来自会话元数据的 git 分支。
    pub git_branch: Option<String>,
    /// 来自会话元数据的 git commit SHA。
    pub git_sha: Option<String>,
    /// 来自会话元数据的 git origin URL。
    pub git_origin_url: Option<String>,
    /// 来自会话元数据的会话来源。
    pub source: Option<SessionSource>,
    /// 创建该 thread 时所选的持久化历史模式。
    pub history_mode: ThreadHistoryMode,
    /// 来自会话元数据的直接控制/派生父 thread ID。
    pub parent_thread_id: Option<ThreadId>,
    /// 来自会话元数据的随机唯一昵称，仅用于 AgentControl 派生的 sub-agent。
    pub agent_nickname: Option<String>,
    /// 来自会话元数据的角色（agent_role），仅用于 AgentControl 派生的 sub-agent。
    pub agent_role: Option<String>,
    /// 来自会话元数据的模型 provider。
    pub model_provider: Option<String>,
    /// 来自会话元数据的 CLI 版本。
    pub cli_version: Option<String>,
    /// 会话创建时间的 RFC3339 时间戳字符串（若可用）。
    /// created_at 来源于文件名中的时间戳，精度为秒。
    pub created_at: Option<String>,
    /// 最近一次更新的 RFC3339 时间戳字符串（来自文件 mtime）。
    pub updated_at: Option<String>,
    /// 用于产品 recency 排序的 RFC3339 时间戳字符串。
    pub recency_at: Option<String>,
}

#[allow(dead_code)]
#[deprecated(note = "use ThreadItem")]
pub type ConversationItem = ThreadItem;
#[allow(dead_code)]
#[deprecated(note = "use ThreadsPage")]
pub type ConversationsPage = ThreadsPage;

#[derive(Default)]
struct HeadTailSummary {
    saw_session_meta: bool,
    thread_id: Option<ThreadId>,
    first_user_message: Option<String>,
    preview: Option<String>,
    cwd: Option<PathBuf>,
    git_branch: Option<String>,
    git_sha: Option<String>,
    git_origin_url: Option<String>,
    source: Option<SessionSource>,
    history_mode: ThreadHistoryMode,
    parent_thread_id: Option<ThreadId>,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
    model_provider: Option<String>,
    cli_version: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// 用于限制单次请求最坏情况工作量的硬上限。
const MAX_SCAN_FILES: usize = 10000;
const HEAD_RECORD_LIMIT: usize = 10;
const USER_EVENT_SCAN_LIMIT: usize = 200;

/// thread 列表的排序键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadSortKey {
    /// 按创建时间排序。
    CreatedAt,
    /// 按更新时间排序。
    UpdatedAt,
    /// 按 recency 排序。
    RecencyAt,
}

/// 排序方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    /// 升序。
    Asc,
    /// 降序。
    Desc,
}

/// thread 列表的布局方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadListLayout {
    /// 按日期嵌套目录布局（YYYY/MM/DD）。
    NestedByDate,
    /// 平铺布局。
    Flat,
}

/// thread 列表查询配置。
pub struct ThreadListConfig<'a> {
    /// 允许的会话来源列表。
    pub allowed_sources: &'a [SessionSource],
    /// 可选的模型 provider 过滤列表。
    pub model_providers: Option<&'a [String]>,
    /// 可选的工作目录过滤列表。
    pub cwd_filters: Option<&'a [PathBuf]>,
    /// 默认模型 provider ID。
    pub default_provider: &'a str,
    /// 列表布局方式。
    pub layout: ThreadListLayout,
}

/// 标识分页中最后一项的分页游标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    ts: OffsetDateTime,
    id: Option<ThreadId>,
}

impl Cursor {
    pub(crate) fn new(ts: OffsetDateTime) -> Self {
        Self { ts, id: None }
    }

    pub(crate) fn with_thread_id(ts: OffsetDateTime, id: ThreadId) -> Self {
        Self { ts, id: Some(id) }
    }

    pub(crate) fn timestamp(&self) -> OffsetDateTime {
        self.ts
    }

    pub(crate) fn thread_id(&self) -> Option<ThreadId> {
        self.id
    }
}

/// 跟踪分页列表上次中断位置的状态。
///
/// 文件扫描从新到旧进行：在通过上一页最后一个时间戳之前忽略所有条目，
/// 之后开始返回结果。即使分页过程中有新文件出现，分页也保持稳定。
struct AnchorState {
    ts: OffsetDateTime,
    passed: bool,
}

impl AnchorState {
    fn new(anchor: Option<Cursor>) -> Self {
        match anchor {
            Some(cursor) => Self {
                ts: cursor.ts,
                passed: false,
            },
            None => Self {
                ts: OffsetDateTime::UNIX_EPOCH,
                passed: true,
            },
        }
    }

    fn should_skip(&mut self, ts: OffsetDateTime, _id: Uuid) -> bool {
        if self.passed {
            return false;
        }
        if ts < self.ts {
            self.passed = true;
            false
        } else {
            true
        }
    }
}

/// 在 `walk_rollout_files` 中访问每个 rollout 文件时自定义行为的 visitor 接口。
///
/// 当最终需要按 created_at 或 updated_at 排序返回 thread 时，
/// 需要应用不同的逻辑。
trait RolloutFileVisitor {
    fn visit(
        &mut self,
        ts: OffsetDateTime,
        id: Uuid,
        path: PathBuf,
        scanned: usize,
    ) -> impl std::future::Future<Output = ControlFlow<()>> + Send;
}

/// 在目录遍历过程中按 created_at 顺序收集 thread item，
/// 并在遍历过程中应用分页与过滤。
struct FilesByCreatedAtVisitor<'a> {
    items: &'a mut Vec<ThreadItem>,
    page_size: usize,
    anchor_state: AnchorState,
    more_matches_available: bool,
    allowed_sources: &'a [SessionSource],
    provider_matcher: Option<&'a ProviderMatcher<'a>>,
    cwd_filters: Option<&'a [PathBuf]>,
}

impl<'a> RolloutFileVisitor for FilesByCreatedAtVisitor<'a> {
    async fn visit(
        &mut self,
        ts: OffsetDateTime,
        id: Uuid,
        path: PathBuf,
        scanned: usize,
    ) -> ControlFlow<()> {
        if scanned >= MAX_SCAN_FILES && self.items.len() >= self.page_size {
            self.more_matches_available = true;
            return ControlFlow::Break(());
        }
        if self.anchor_state.should_skip(ts, id) {
            return ControlFlow::Continue(());
        }
        if self.items.len() == self.page_size {
            self.more_matches_available = true;
            return ControlFlow::Break(());
        }
        let updated_at = file_modified_time(&path)
            .await
            .unwrap_or(None)
            .and_then(format_rfc3339);
        if let Some(item) = build_thread_item(
            path,
            self.allowed_sources,
            self.provider_matcher,
            self.cwd_filters,
            updated_at,
        )
        .await
        {
            self.items.push(item);
        }
        ControlFlow::Continue(())
    }
}

/// 收集轻量级文件候选（path + id + mtime）。
/// 在所有文件收集完成后再按 mtime 排序。
struct FilesByUpdatedAtVisitor<'a> {
    candidates: &'a mut Vec<ThreadCandidate>,
}

impl<'a> RolloutFileVisitor for FilesByUpdatedAtVisitor<'a> {
    async fn visit(
        &mut self,
        _ts: OffsetDateTime,
        id: Uuid,
        path: PathBuf,
        _scanned: usize,
    ) -> ControlFlow<()> {
        let updated_at = file_modified_time(&path).await.unwrap_or(None);
        self.candidates.push(ThreadCandidate {
            path,
            id,
            updated_at,
        });
        ControlFlow::Continue(())
    }
}

impl serde::Serialize for Cursor {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let ts_str = self
            .ts
            .format(&Rfc3339)
            .map_err(|e| serde::ser::Error::custom(format!("format error: {e}")))?;
        match self.id {
            Some(id) => serializer.serialize_str(&format!("{ts_str}|{id}")),
            None => serializer.serialize_str(&ts_str),
        }
    }
}

impl<'de> serde::Deserialize<'de> for Cursor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        parse_cursor(&s).ok_or_else(|| serde::de::Error::custom("invalid cursor"))
    }
}

impl From<codex_state::Anchor> for Cursor {
    fn from(anchor: codex_state::Anchor) -> Self {
        let ts = anchor
            .ts
            .timestamp_nanos_opt()
            .and_then(|nanos| OffsetDateTime::from_unix_timestamp_nanos(nanos as i128).ok())
            .unwrap_or(OffsetDateTime::UNIX_EPOCH);
        Self { ts, id: anchor.id }
    }
}

/// 通过 token 分页获取已记录的 thread 文件路径。
///
/// 返回的 `next_cursor` 可在下一次调用时传入以在最后一个返回项之后继续分页，
/// 且对并发追加的新会话具有弹性。排序按请求的 sort key（timestamp desc）稳定进行。
///
/// # 参数
/// - `codex_home`: Codex 主目录
/// - `page_size`: 单页大小
/// - `cursor`: 可选的分页游标
/// - `sort_key`: 排序键
/// - `allowed_sources`: 允许的会话来源
/// - `model_providers`: 可选的模型 provider 过滤列表
/// - `cwd_filters`: 可选的工作目录过滤列表
/// - `default_provider`: 默认模型 provider ID
///
/// # 返回值
/// 返回 [`ThreadsPage`]；若发生 IO 错误则返回 `Err`。
pub async fn get_threads(
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    model_providers: Option<&[String]>,
    cwd_filters: Option<&[PathBuf]>,
    default_provider: &str,
) -> io::Result<ThreadsPage> {
    let root = codex_home.join(SESSIONS_SUBDIR);
    get_threads_in_root(
        root,
        page_size,
        cursor,
        sort_key,
        ThreadListConfig {
            allowed_sources,
            model_providers,
            cwd_filters,
            default_provider,
            layout: ThreadListLayout::NestedByDate,
        },
    )
    .await
}

/// 从指定根目录获取 thread 列表。
///
/// 与 [`get_threads`] 类似，但允许自定义根目录与查询配置。
///
/// # 参数
/// - `root`: 根目录路径
/// - `page_size`: 单页大小
/// - `cursor`: 可选的分页游标
/// - `sort_key`: 排序键
/// - `config`: 列表查询配置
///
/// # 返回值
/// 返回 [`ThreadsPage`]；若发生 IO 错误则返回 `Err`。
pub async fn get_threads_in_root(
    root: PathBuf,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    config: ThreadListConfig<'_>,
) -> io::Result<ThreadsPage> {
    if !root.exists() {
        return Ok(ThreadsPage {
            items: Vec::new(),
            next_cursor: None,
            num_scanned_files: 0,
            reached_scan_cap: false,
        });
    }

    let anchor = cursor.cloned();

    let provider_matcher = config
        .model_providers
        .and_then(|filters| ProviderMatcher::new(filters, config.default_provider));

    let result = match config.layout {
        ThreadListLayout::NestedByDate => {
            traverse_directories_for_paths(
                root.clone(),
                page_size,
                anchor,
                sort_key,
                config.allowed_sources,
                provider_matcher.as_ref(),
                config.cwd_filters,
            )
            .await?
        }
        ThreadListLayout::Flat => {
            traverse_flat_paths(
                root.clone(),
                page_size,
                anchor,
                sort_key,
                config.allowed_sources,
                provider_matcher.as_ref(),
                config.cwd_filters,
            )
            .await?
        }
    };
    Ok(result)
}

/// 通过目录遍历从磁盘加载 thread 文件路径。
///
/// 目录布局：`~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`
/// 返回结果按 sort key 从新到旧排序。
async fn traverse_directories_for_paths(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
) -> io::Result<ThreadsPage> {
    match sort_key {
        ThreadSortKey::CreatedAt => {
            traverse_directories_for_paths_created(
                root,
                page_size,
                anchor,
                allowed_sources,
                provider_matcher,
                cwd_filters,
            )
            .await
        }
        ThreadSortKey::UpdatedAt | ThreadSortKey::RecencyAt => {
            traverse_directories_for_paths_updated(
                root,
                page_size,
                anchor,
                allowed_sources,
                provider_matcher,
                cwd_filters,
            )
            .await
        }
    }
}

async fn traverse_flat_paths(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
) -> io::Result<ThreadsPage> {
    match sort_key {
        ThreadSortKey::CreatedAt => {
            traverse_flat_paths_created(
                root,
                page_size,
                anchor,
                allowed_sources,
                provider_matcher,
                cwd_filters,
            )
            .await
        }
        ThreadSortKey::UpdatedAt | ThreadSortKey::RecencyAt => {
            traverse_flat_paths_updated(
                root,
                page_size,
                anchor,
                allowed_sources,
                provider_matcher,
                cwd_filters,
            )
            .await
        }
    }
}

/// 按时间倒序遍历 rollout 目录树并收集 item，
/// 直到填满当前页或触发扫描上限。
///
/// 排序依据目录/文件名排序，因此 created_at 来自文件名中的时间戳。
/// 分页由 anchor cursor 处理，确保严格从上次返回的 `(ts, id)` 之后继续。
async fn traverse_directories_for_paths_created(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
) -> io::Result<ThreadsPage> {
    let mut items: Vec<ThreadItem> = Vec::with_capacity(page_size);
    let mut scanned_files = 0usize;
    let mut more_matches_available = false;
    let mut visitor = FilesByCreatedAtVisitor {
        items: &mut items,
        page_size,
        anchor_state: AnchorState::new(anchor),
        more_matches_available,
        allowed_sources,
        provider_matcher,
        cwd_filters,
    };
    walk_rollout_files(&root, &mut scanned_files, &mut visitor).await?;
    more_matches_available = visitor.more_matches_available;

    let reached_scan_cap = scanned_files >= MAX_SCAN_FILES;
    if reached_scan_cap && !items.is_empty() {
        more_matches_available = true;
    }

    let next = if more_matches_available {
        build_next_cursor(&items, ThreadSortKey::CreatedAt)
    } else {
        None
    };
    Ok(ThreadsPage {
        items,
        next_cursor: next,
        num_scanned_files: scanned_files,
        reached_scan_cap,
    })
}

/// 遍历 rollout 目录树按 updated_at 收集文件，
/// 然后按文件 mtime（updated_at）排序，再依次应用分页与过滤。
///
/// 由于 updated_at 不在文件名中编码，此路径需要扫描到上限为止的所有文件，
/// 然后按 anchor cursor 进行排序与过滤。
///
/// 注意：未来若在磁盘上缓存 updated_at 时间戳，则可优化此路径。
async fn traverse_directories_for_paths_updated(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
) -> io::Result<ThreadsPage> {
    let mut items: Vec<ThreadItem> = Vec::with_capacity(page_size);
    let mut scanned_files = 0usize;
    let mut anchor_state = AnchorState::new(anchor);
    let mut more_matches_available = false;

    let mut candidates = collect_files_by_updated_at(&root, &mut scanned_files).await?;
    candidates.sort_by_key(|candidate| {
        let ts = candidate.updated_at.unwrap_or(OffsetDateTime::UNIX_EPOCH);
        (Reverse(ts), Reverse(candidate.id))
    });

    for candidate in candidates.into_iter() {
        let ts = candidate.updated_at.unwrap_or(OffsetDateTime::UNIX_EPOCH);
        if anchor_state.should_skip(ts, candidate.id) {
            continue;
        }
        if items.len() == page_size {
            more_matches_available = true;
            break;
        }

        let updated_at_fallback = candidate.updated_at.and_then(format_rfc3339);
        if let Some(item) = build_thread_item(
            candidate.path,
            allowed_sources,
            provider_matcher,
            cwd_filters,
            updated_at_fallback,
        )
        .await
        {
            items.push(item);
        }
    }

    let reached_scan_cap = scanned_files >= MAX_SCAN_FILES;
    if reached_scan_cap && !items.is_empty() {
        more_matches_available = true;
    }

    let next = if more_matches_available {
        build_next_cursor(&items, ThreadSortKey::UpdatedAt)
    } else {
        None
    };
    Ok(ThreadsPage {
        items,
        next_cursor: next,
        num_scanned_files: scanned_files,
        reached_scan_cap,
    })
}

async fn traverse_flat_paths_created(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
) -> io::Result<ThreadsPage> {
    let mut items: Vec<ThreadItem> = Vec::with_capacity(page_size);
    let mut scanned_files = 0usize;
    let mut anchor_state = AnchorState::new(anchor);
    let mut more_matches_available = false;

    let files = collect_flat_rollout_files(&root, &mut scanned_files).await?;
    for (ts, id, path) in files.into_iter() {
        if anchor_state.should_skip(ts, id) {
            continue;
        }
        if items.len() == page_size {
            more_matches_available = true;
            break;
        }
        let updated_at = file_modified_time(&path)
            .await
            .unwrap_or(None)
            .and_then(format_rfc3339);
        if let Some(item) = build_thread_item(
            path,
            allowed_sources,
            provider_matcher,
            cwd_filters,
            updated_at,
        )
        .await
        {
            items.push(item);
        }
    }

    let reached_scan_cap = scanned_files >= MAX_SCAN_FILES;
    if reached_scan_cap && !items.is_empty() {
        more_matches_available = true;
    }

    let next = if more_matches_available {
        build_next_cursor(&items, ThreadSortKey::CreatedAt)
    } else {
        None
    };
    Ok(ThreadsPage {
        items,
        next_cursor: next,
        num_scanned_files: scanned_files,
        reached_scan_cap,
    })
}

async fn traverse_flat_paths_updated(
    root: PathBuf,
    page_size: usize,
    anchor: Option<Cursor>,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
) -> io::Result<ThreadsPage> {
    let mut items: Vec<ThreadItem> = Vec::with_capacity(page_size);
    let mut scanned_files = 0usize;
    let mut anchor_state = AnchorState::new(anchor);
    let mut more_matches_available = false;

    let mut candidates = collect_flat_files_by_updated_at(&root, &mut scanned_files).await?;
    candidates.sort_by_key(|candidate| {
        let ts = candidate.updated_at.unwrap_or(OffsetDateTime::UNIX_EPOCH);
        (Reverse(ts), Reverse(candidate.id))
    });

    for candidate in candidates.into_iter() {
        let ts = candidate.updated_at.unwrap_or(OffsetDateTime::UNIX_EPOCH);
        if anchor_state.should_skip(ts, candidate.id) {
            continue;
        }
        if items.len() == page_size {
            more_matches_available = true;
            break;
        }

        let updated_at_fallback = candidate.updated_at.and_then(format_rfc3339);
        if let Some(item) = build_thread_item(
            candidate.path,
            allowed_sources,
            provider_matcher,
            cwd_filters,
            updated_at_fallback,
        )
        .await
        {
            items.push(item);
        }
    }

    let reached_scan_cap = scanned_files >= MAX_SCAN_FILES;
    if reached_scan_cap && !items.is_empty() {
        more_matches_available = true;
    }

    let next = if more_matches_available {
        build_next_cursor(&items, ThreadSortKey::UpdatedAt)
    } else {
        None
    };
    Ok(ThreadsPage {
        items,
        next_cursor: next,
        num_scanned_files: scanned_files,
        reached_scan_cap,
    })
}

/// 分页游标 token 格式：一个 RFC3339 时间戳，可附加可选的 thread ID 作为 tie-breaker。
///
/// # 参数
/// - `token`: 游标 token 字符串
///
/// # 返回值
/// 返回解析后的 [`Cursor`]；若格式非法则返回 `None`。
pub fn parse_cursor(token: &str) -> Option<Cursor> {
    let (timestamp, id) = match token.rsplit_once('|') {
        Some((timestamp, id)) => (timestamp, Some(ThreadId::from_string(id).ok()?)),
        None => (token, None),
    };

    let ts = OffsetDateTime::parse(timestamp, &Rfc3339)
        .ok()
        .or_else(|| {
            let format: &[FormatItem] =
                format_description!("[year]-[month]-[day]T[hour]-[minute]-[second]");
            PrimitiveDateTime::parse(timestamp, format)
                .ok()
                .map(PrimitiveDateTime::assume_utc)
        })?;

    Some(Cursor { ts, id })
}

fn build_next_cursor(items: &[ThreadItem], sort_key: ThreadSortKey) -> Option<Cursor> {
    let last = items.last()?;
    let file_name = last.path.file_name()?.to_string_lossy();
    let (created_ts, id) = parse_timestamp_uuid_from_filename(&file_name)?;
    let ts = match sort_key {
        ThreadSortKey::CreatedAt => created_ts,
        ThreadSortKey::UpdatedAt => {
            let updated_at = last.updated_at.as_deref()?;
            OffsetDateTime::parse(updated_at, &Rfc3339).ok()?
        }
        ThreadSortKey::RecencyAt => {
            let recency_at = last.recency_at.as_deref().or(last.updated_at.as_deref())?;
            OffsetDateTime::parse(recency_at, &Rfc3339).ok()?
        }
    };
    match sort_key {
        ThreadSortKey::RecencyAt => Some(Cursor::with_thread_id(
            ts,
            ThreadId::from_string(&id.to_string()).ok()?,
        )),
        ThreadSortKey::CreatedAt | ThreadSortKey::UpdatedAt => Some(Cursor::new(ts)),
    }
}

async fn build_thread_item(
    path: PathBuf,
    allowed_sources: &[SessionSource],
    provider_matcher: Option<&ProviderMatcher<'_>>,
    cwd_filters: Option<&[PathBuf]>,
    updated_at: Option<String>,
) -> Option<ThreadItem> {
    // 读取头部并检测包含预览的事件；goal 预览可能出现在第一条普通用户消息之前。
    let summary = read_head_summary(&path, HEAD_RECORD_LIMIT)
        .await
        .unwrap_or_default();
    if !allowed_sources.is_empty()
        && !summary
            .source
            .as_ref()
            .is_some_and(|source| allowed_sources.contains(source))
    {
        return None;
    }
    if let Some(matcher) = provider_matcher
        && !matcher.matches(summary.model_provider.as_deref())
    {
        return None;
    }
    if let Some(cwd_filters) = cwd_filters
        && !summary.cwd.as_ref().is_some_and(|cwd| {
            cwd_filters
                .iter()
                .any(|filter| path_utils::paths_match_after_normalization(cwd, filter))
        })
    {
        return None;
    }
    // 应用过滤：必须存在 session meta 且能发现预览。
    if summary.saw_session_meta && summary.preview.is_some() {
        let HeadTailSummary {
            thread_id,
            first_user_message,
            preview,
            cwd,
            git_branch,
            git_sha,
            git_origin_url,
            source,
            history_mode,
            parent_thread_id,
            agent_nickname,
            agent_role,
            model_provider,
            cli_version,
            created_at,
            updated_at: mut summary_updated_at,
            ..
        } = summary;
        if summary_updated_at.is_none() {
            summary_updated_at = updated_at.or_else(|| created_at.clone());
        }
        return Some(ThreadItem {
            path,
            thread_id,
            first_user_message,
            preview,
            cwd,
            git_branch,
            git_sha,
            git_origin_url,
            source,
            history_mode,
            parent_thread_id,
            agent_nickname,
            agent_role,
            model_provider,
            cli_version,
            created_at,
            recency_at: summary_updated_at.clone(),
            updated_at: summary_updated_at,
        });
    }
    None
}

/// 将单个 rollout 文件读取为与 thread 列表相同的摘要 item 形态。
///
/// 适用于已经解析出 rollout 路径、但不需要扫描整个 sessions 树
/// 而需要与列表操作相同的元数据/预览提取逻辑的调用方。
///
/// # 参数
/// - `path`: rollout 文件路径
///
/// # 返回值
/// 返回 [`ThreadItem`]；若文件不可用或不满足条件则返回 `None`。
pub async fn read_thread_item_from_rollout(path: PathBuf) -> Option<ThreadItem> {
    build_thread_item(
        path,
        &[],
        /*provider_matcher*/ None,
        /*cwd_filters*/ None,
        /*updated_at*/ None,
    )
    .await
}

/// 收集 `parent` 的直接子目录，使用 `parse` 解析其（字符串）名称，
/// 并按解析得到的 key 降序返回。
async fn collect_dirs_desc<T, F>(parent: &Path, parse: F) -> io::Result<Vec<(T, PathBuf)>>
where
    T: Ord + Copy,
    F: Fn(&str) -> Option<T>,
{
    let mut dir = tokio::fs::read_dir(parent).await?;
    let mut vec: Vec<(T, PathBuf)> = Vec::new();
    while let Some(entry) = dir.next_entry().await? {
        if entry
            .file_type()
            .await
            .map(|ft| ft.is_dir())
            .unwrap_or(false)
            && let Some(s) = entry.file_name().to_str()
            && let Some(v) = parse(s)
        {
            vec.push((v, entry.path()));
        }
    }
    vec.sort_by_key(|(v, _)| Reverse(*v));
    Ok(vec)
}

/// 收集目录中的文件并使用 `parse` 解析其名称。
async fn collect_files<T, F>(parent: &Path, parse: F) -> io::Result<Vec<T>>
where
    F: Fn(&str, &Path) -> Option<T>,
{
    let mut dir = tokio::fs::read_dir(parent).await?;
    let mut collected: Vec<T> = Vec::new();
    while let Some(entry) = dir.next_entry().await? {
        if entry
            .file_type()
            .await
            .map(|ft| ft.is_file())
            .unwrap_or(false)
            && let Some(s) = entry.file_name().to_str()
            && let Some(v) = parse(s, &entry.path())
        {
            collected.push(v);
        }
    }
    Ok(collected)
}

async fn collect_flat_rollout_files(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<(OffsetDateTime, Uuid, PathBuf)>> {
    let mut dir = tokio::fs::read_dir(root).await?;
    let mut collected = Vec::new();
    while let Some(entry) = dir.next_entry().await? {
        if *scanned_files >= MAX_SCAN_FILES {
            break;
        }
        if !entry
            .file_type()
            .await
            .map(|ft| ft.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(rollout_file) = compression::RolloutFile::from_path(entry.path()) else {
            continue;
        };
        let Some((ts, id)) = parse_timestamp_uuid_from_filename(rollout_file.plain_file_name())
        else {
            continue;
        };
        *scanned_files += 1;
        if *scanned_files > MAX_SCAN_FILES {
            break;
        }
        collected.push((ts, id, rollout_file.into_path()));
    }
    collected.sort_by_key(|(ts, sid, _path)| (Reverse(*ts), Reverse(*sid)));
    Ok(collected)
}

async fn collect_rollout_day_files(
    day_path: &Path,
) -> io::Result<Vec<(OffsetDateTime, Uuid, PathBuf)>> {
    let mut day_files = collect_files(day_path, |_name_str, path| {
        let rollout_file = compression::RolloutFile::from_path(path.to_path_buf())?;
        parse_timestamp_uuid_from_filename(rollout_file.plain_file_name())
            .map(|(ts, id)| (ts, id, rollout_file.into_path()))
    })
    .await?;
    // 同一秒内的稳定排序：(timestamp desc, uuid desc)
    day_files.sort_by_key(|(ts, sid, _path)| (Reverse(*ts), Reverse(*sid)));
    Ok(day_files)
}

/// 从 rollout 文件名中解析出时间戳与 UUID。
///
/// # 参数
/// - `name`: rollout 文件名
///
/// # 返回值
/// 返回 `(OffsetDateTime, Uuid)`；若文件名格式不匹配则返回 `None`。
pub(crate) fn parse_timestamp_uuid_from_filename(name: &str) -> Option<(OffsetDateTime, Uuid)> {
    // 期望格式：rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl[.zst]
    let name = compression::parse_rollout_file_name(name)?;
    let core = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;

    // 从右向左扫描 '-'，直到后缀可解析为 UUID。
    let (sep_idx, uuid) = core
        .match_indices('-')
        .rev()
        .find_map(|(i, _)| Uuid::parse_str(&core[i + 1..]).ok().map(|u| (i, u)))?;

    let ts_str = &core[..sep_idx];
    let format: &[FormatItem] =
        format_description!("[year]-[month]-[day]T[hour]-[minute]-[second]");
    let ts = PrimitiveDateTime::parse(ts_str, format).ok()?.assume_utc();
    Some((ts, uuid))
}

struct ThreadCandidate {
    path: PathBuf,
    id: Uuid,
    updated_at: Option<OffsetDateTime>,
}

async fn collect_files_by_updated_at(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<ThreadCandidate>> {
    let mut candidates = Vec::new();
    let mut visitor = FilesByUpdatedAtVisitor {
        candidates: &mut candidates,
    };
    walk_rollout_files(root, scanned_files, &mut visitor).await?;

    Ok(candidates)
}

async fn collect_flat_files_by_updated_at(
    root: &Path,
    scanned_files: &mut usize,
) -> io::Result<Vec<ThreadCandidate>> {
    let mut candidates = Vec::new();
    let mut dir = tokio::fs::read_dir(root).await?;
    while let Some(entry) = dir.next_entry().await? {
        if *scanned_files >= MAX_SCAN_FILES {
            break;
        }
        if !entry
            .file_type()
            .await
            .map(|ft| ft.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(rollout_file) = compression::RolloutFile::from_path(entry.path()) else {
            continue;
        };
        let Some((_ts, id)) = parse_timestamp_uuid_from_filename(rollout_file.plain_file_name())
        else {
            continue;
        };
        *scanned_files += 1;
        if *scanned_files > MAX_SCAN_FILES {
            break;
        }
        let updated_at = file_modified_time(rollout_file.path())
            .await
            .unwrap_or(None);
        candidates.push(ThreadCandidate {
            path: rollout_file.into_path(),
            id,
            updated_at,
        });
    }

    Ok(candidates)
}

async fn walk_rollout_files(
    root: &Path,
    scanned_files: &mut usize,
    visitor: &mut impl RolloutFileVisitor,
) -> io::Result<()> {
    let year_dirs = collect_dirs_desc(root, |s| s.parse::<u16>().ok()).await?;

    'outer: for (_year, year_path) in year_dirs.iter() {
        if *scanned_files >= MAX_SCAN_FILES {
            break;
        }
        let month_dirs = collect_dirs_desc(year_path, |s| s.parse::<u8>().ok()).await?;
        for (_month, month_path) in month_dirs.iter() {
            if *scanned_files >= MAX_SCAN_FILES {
                break 'outer;
            }
            let day_dirs = collect_dirs_desc(month_path, |s| s.parse::<u8>().ok()).await?;
            for (_day, day_path) in day_dirs.iter() {
                if *scanned_files >= MAX_SCAN_FILES {
                    break 'outer;
                }
                let day_files = collect_rollout_day_files(day_path).await?;
                for (ts, id, path) in day_files.into_iter() {
                    *scanned_files += 1;
                    if *scanned_files > MAX_SCAN_FILES {
                        break 'outer;
                    }
                    if let ControlFlow::Break(()) =
                        visitor.visit(ts, id, path, *scanned_files).await
                    {
                        break 'outer;
                    }
                }
            }
        }
    }

    Ok(())
}

struct ProviderMatcher<'a> {
    filters: &'a [String],
    matches_default_provider: bool,
}

impl<'a> ProviderMatcher<'a> {
    fn new(filters: &'a [String], default_provider: &'a str) -> Option<Self> {
        if filters.is_empty() {
            return None;
        }

        let matches_default_provider = filters.iter().any(|provider| provider == default_provider);
        Some(Self {
            filters,
            matches_default_provider,
        })
    }

    fn matches(&self, session_provider: Option<&str>) -> bool {
        match session_provider {
            Some(provider) => self.filters.iter().any(|candidate| candidate == provider),
            None => self.matches_default_provider,
        }
    }
}

async fn read_head_summary(path: &Path, head_limit: usize) -> io::Result<HeadTailSummary> {
    let mut lines = compression::open_rollout_line_reader(path).await?;
    let mut summary = HeadTailSummary::default();
    let mut lines_scanned = 0usize;

    while lines_scanned < head_limit
        || (summary.saw_session_meta
            && (summary.preview.is_none() || summary.first_user_message.is_none())
            && lines_scanned < head_limit + USER_EVENT_SCAN_LIMIT)
    {
        let line_opt = lines.next_line().await?;
        let Some(line) = line_opt else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        lines_scanned += 1;

        let parsed: Result<RolloutLine, _> = serde_json::from_str(trimmed);
        let rollout_line = match parsed {
            Ok(rollout_line) => rollout_line,
            Err(_) => {
                if !summary.saw_session_meta
                    && let Ok(value) = serde_json::from_str::<Value>(trimmed)
                {
                    // The first SessionMeta belongs to this rollout. Later SessionMeta lines can
                    // be copied from fork history, so only an unknown mode before the first parsed
                    // SessionMeta should make this thread unreadable.
                    crate::recorder::reject_unknown_thread_history_mode(&value)?;
                }
                continue;
            }
        };

        match rollout_line.item {
            RolloutItem::SessionMeta(session_meta_line) => {
                if !summary.saw_session_meta {
                    summary.source = Some(session_meta_line.meta.source.clone());
                    summary.history_mode = session_meta_line.meta.history_mode;
                    summary.parent_thread_id = session_meta_line.meta.parent_thread_id;
                    summary.agent_nickname = session_meta_line.meta.agent_nickname.clone();
                    summary.agent_role = session_meta_line.meta.agent_role.clone();
                    summary.model_provider = session_meta_line.meta.model_provider.clone();
                    summary.thread_id = Some(session_meta_line.meta.id);
                    summary.cwd = Some(session_meta_line.meta.cwd.clone());
                    summary.git_branch = session_meta_line
                        .git
                        .as_ref()
                        .and_then(|git| git.branch.clone());
                    summary.git_sha = session_meta_line
                        .git
                        .as_ref()
                        .and_then(|git| git.commit_hash.as_ref().map(|sha| sha.0.clone()));
                    summary.git_origin_url = session_meta_line
                        .git
                        .as_ref()
                        .and_then(|git| git.repository_url.clone());
                    summary.cli_version = Some(session_meta_line.meta.cli_version);
                    summary.created_at = Some(session_meta_line.meta.timestamp.clone());
                    summary.saw_session_meta = true;
                }
            }
            RolloutItem::ResponseItem(_) | RolloutItem::InterAgentCommunication(_) => {
                summary
                    .created_at
                    .get_or_insert_with(|| rollout_line.timestamp.clone());
            }
            RolloutItem::InterAgentCommunicationMetadata { .. } => {}
            RolloutItem::TurnContext(_) => {
                // Not included in `head`; skip.
            }
            RolloutItem::WorldState(_) => {
                // Not included in `head`; skip.
            }
            RolloutItem::Compacted(_) => {
                // Not included in `head`; skip.
            }
            RolloutItem::EventMsg(ev) => {
                if let Some(preview) = event_msg_preview(&ev) {
                    if summary.preview.is_none() {
                        summary.preview = Some(preview.clone());
                    }
                    if let EventMsg::UserMessage(_) = ev
                        && summary.first_user_message.is_none()
                    {
                        summary.first_user_message = Some(preview);
                    }
                }
            }
        }

        if summary.saw_session_meta
            && summary.preview.is_some()
            && summary.first_user_message.is_some()
        {
            break;
        }
    }

    Ok(summary)
}

/// 从 `path` 指向的 rollout 文件起始处读取最多 `HEAD_RECORD_LIMIT` 条记录。
/// 这应当足以产出包含 session meta 行的摘要。
///
/// # 参数
/// - `path`: rollout 文件路径
///
/// # 返回值
/// 返回 head 记录的 JSON 值列表；若发生 IO 错误则返回 `Err`。
pub async fn read_head_for_summary(path: &Path) -> io::Result<Vec<serde_json::Value>> {
    let mut lines = compression::open_rollout_line_reader(path).await?;
    let mut head = Vec::new();

    while head.len() < HEAD_RECORD_LIMIT {
        let Some(line) = lines.next_line().await? else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(rollout_line) = serde_json::from_str::<RolloutLine>(trimmed) {
            match rollout_line.item {
                RolloutItem::SessionMeta(session_meta_line) => {
                    if let Ok(value) = serde_json::to_value(session_meta_line) {
                        head.push(value);
                    }
                }
                RolloutItem::ResponseItem(item) => {
                    if let Ok(value) = serde_json::to_value(item) {
                        head.push(value);
                    }
                }
                RolloutItem::InterAgentCommunication(communication) => {
                    if let Ok(value) = serde_json::to_value(communication.to_model_input_item()) {
                        head.push(value);
                    }
                }
                RolloutItem::InterAgentCommunicationMetadata { .. }
                | RolloutItem::Compacted(_)
                | RolloutItem::TurnContext(_)
                | RolloutItem::WorldState(_)
                | RolloutItem::EventMsg(_) => {}
            }
        }
    }

    Ok(head)
}

fn strip_user_message_prefix(text: &str) -> &str {
    match text.find(USER_MESSAGE_BEGIN) {
        Some(idx) => text[idx + USER_MESSAGE_BEGIN.len()..].trim(),
        None => text.trim(),
    }
}

fn event_msg_preview(event: &EventMsg) -> Option<String> {
    match event {
        EventMsg::UserMessage(user) => {
            let message = strip_user_message_prefix(user.message.as_str());
            if !message.is_empty() {
                return Some(message.to_string());
            }
            if user
                .images
                .as_ref()
                .is_some_and(|images| !images.is_empty())
                || !user.local_images.is_empty()
            {
                return Some("[Image]".to_string());
            }
            None
        }
        EventMsg::ThreadGoalUpdated(event) => {
            let objective = event.goal.objective.trim();
            (!objective.is_empty()).then(|| objective.to_string())
        }
        _ => None,
    }
}

/// 从 rollout 文件头部读取 [`SessionMetaLine`]，
/// 供需要会话元数据的调用方复用（例如推导 config 所需的 cwd）。
///
/// # 参数
/// - `path`: rollout 文件路径
///
/// # 返回值
/// 返回 [`SessionMetaLine`]；若文件为空或不以 session metadata 开头则返回 `Err`。
pub async fn read_session_meta_line(path: &Path) -> io::Result<SessionMetaLine> {
    let head = read_head_for_summary(path).await?;
    let Some(first) = head.first() else {
        return Err(io::Error::other(format!(
            "rollout at {} is empty",
            path.display()
        )));
    };
    serde_json::from_value::<SessionMetaLine>(first.clone()).map_err(|_| {
        io::Error::other(format!(
            "rollout at {} does not start with session metadata",
            path.display()
        ))
    })
}

async fn file_modified_time(path: &Path) -> io::Result<Option<OffsetDateTime>> {
    Ok(compression::file_modified_time(path)
        .await?
        .and_then(truncate_to_millis))
}

fn format_rfc3339(dt: OffsetDateTime) -> Option<String> {
    dt.format(&Rfc3339).ok()
}

fn truncate_to_millis(dt: OffsetDateTime) -> Option<OffsetDateTime> {
    let millis_nanos = (dt.nanosecond() / 1_000_000) * 1_000_000;
    dt.replace_nanosecond(millis_nanos).ok()
}

async fn find_thread_path_by_id_str_in_subdir(
    codex_home: &Path,
    subdir: &str,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>> {
    // 尽早校验 UUID 格式。
    if Uuid::parse_str(id_str).is_err() {
        return Ok(None);
    }

    // 优先 DB 查询，再回退到 rollout 文件搜索。
    // TODO(jif): sqlite migration phase 1
    let archived_only = match subdir {
        SESSIONS_SUBDIR => Some(false),
        ARCHIVED_SESSIONS_SUBDIR => Some(true),
        _ => None,
    };
    let thread_id = ThreadId::from_string(id_str).ok();
    let mut unverified_db_path = None;
    let mut fallback_reason = state_db_ctx.is_none().then_some("db_unavailable");
    if let Some(state_db_ctx) = state_db_ctx
        && let Some(thread_id) = thread_id
    {
        match state_db_ctx
            .find_rollout_path_by_id(thread_id, archived_only)
            .await
        {
            Ok(Some(db_path)) => {
                if let Some(existing_db_path) =
                    compression::existing_rollout_path(db_path.as_path()).await
                {
                    match read_session_meta_line(&existing_db_path).await {
                        Ok(meta_line) if meta_line.meta.id == thread_id => {
                            return Ok(Some(existing_db_path));
                        }
                        Ok(meta_line) => {
                            tracing::error!(
                                "state db returned rollout path for thread {id_str} but file belongs to thread {}: {}",
                                meta_line.meta.id,
                                existing_db_path.display()
                            );
                            tracing::warn!(
                                "state db discrepancy during find_thread_path_by_id_str_in_subdir: mismatched_db_path"
                            );
                            codex_state::record_fallback(
                                "find_thread_path",
                                "mismatch",
                                /*telemetry_override*/ None,
                            );
                        }
                        Err(err) => {
                            tracing::debug!(
                                "state db returned rollout path for thread {id_str} that could not be verified: {}: {err}",
                                existing_db_path.display()
                            );
                            unverified_db_path = Some(existing_db_path);
                        }
                    }
                } else {
                    tracing::error!(
                        "state db returned stale rollout path for thread {id_str}: {}",
                        db_path.display()
                    );
                    tracing::warn!(
                        "state db discrepancy during find_thread_path_by_id_str_in_subdir: stale_db_path"
                    );
                    codex_state::record_fallback(
                        "find_thread_path",
                        "stale_path",
                        /*telemetry_override*/ None,
                    );
                }
            }
            Ok(None) => fallback_reason = Some("missing_row"),
            Err(err) => {
                tracing::warn!(
                    "state db find_rollout_path_by_id failed during find_path_query: {err}"
                );
                fallback_reason = Some("db_error");
            }
        }
    }

    let mut root = codex_home.to_path_buf();
    root.push(subdir);
    if !root.exists() {
        return Ok(unverified_db_path);
    }
    let (filename_match, filename_scan_error) = match find_rollout_path_by_id_from_filenames(
        root.as_path(),
        id_str,
    )
    .await
    {
        Ok(path) => (path, None),
        Err(err) => {
            tracing::warn!(
                "rollout filename lookup failed during find_thread_path_by_id_str_in_subdir: {err}"
            );
            (None, Some(err))
        }
    };

    let found = match filename_match {
        Some(path) => Some(path),
        None => {
            // This is safe because we know the values are valid.
            #[allow(clippy::unwrap_used)]
            let limit = NonZero::new(1).unwrap();
            let options = file_search::FileSearchOptions {
                limit,
                compute_indices: false,
                respect_gitignore: false,
                ..Default::default()
            };

            let results = file_search::run(
                id_str,
                vec![root.clone()],
                options,
                /*cancel_flag*/ None,
            )
            .map_err(|e| io::Error::other(format!("file search failed: {e}")))?;

            let found = results
                .matches
                .into_iter()
                .map(|m| m.full_path())
                .find_map(compression::RolloutFile::from_path)
                .map(compression::RolloutFile::into_path);

            if found.is_none()
                && let Some(err) = filename_scan_error
            {
                return Err(err);
            }
            found
        }
    };
    if let Some(found_path) = found.as_ref() {
        tracing::debug!("state db missing rollout path for thread {id_str}");
        tracing::warn!(
            "state db discrepancy during find_thread_path_by_id_str_in_subdir: falling_back"
        );
        if let Some(reason) = fallback_reason {
            codex_state::record_fallback(
                "find_thread_path",
                reason,
                /*telemetry_override*/ None,
            );
        }
        state_db::read_repair_rollout_path(
            state_db_ctx,
            thread_id,
            archived_only,
            found_path.as_path(),
        )
        .await;
    }

    Ok(found.or(unverified_db_path))
}

async fn find_rollout_path_by_id_from_filenames(
    root: &Path,
    id_str: &str,
) -> io::Result<Option<PathBuf>> {
    let Ok(target) = Uuid::parse_str(id_str) else {
        return Ok(None);
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut read_dir = match tokio::fs::read_dir(dir.as_path()).await {
            Ok(read_dir) => read_dir,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(rollout_file) = compression::RolloutFile::from_path(path) else {
                continue;
            };
            let Some((_ts, id)) =
                parse_timestamp_uuid_from_filename(rollout_file.plain_file_name())
            else {
                continue;
            };
            if id == target {
                return Ok(Some(rollout_file.into_path()));
            }
        }
    }
    Ok(None)
}

/// 通过 UUID 字符串定位已记录的 thread rollout 文件，使用现有的分页列表实现。
///
/// # 参数
/// - `codex_home`: Codex 主目录
/// - `id_str`: thread UUID 字符串
/// - `state_db_ctx`: 可选的 state DB 运行时上下文
///
/// # 返回值
/// 找到则返回 `Ok(Some(path))`；不存在或 ID 非法则返回 `Ok(None)`；发生 IO 错误则返回 `Err`。
pub async fn find_thread_path_by_id_str(
    codex_home: &Path,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>> {
    find_thread_path_by_id_str_in_subdir(codex_home, SESSIONS_SUBDIR, id_str, state_db_ctx).await
}

/// 通过 UUID 字符串定位已归档的 thread rollout 文件。
///
/// # 参数
/// - `codex_home`: Codex 主目录
/// - `id_str`: thread UUID 字符串
/// - `state_db_ctx`: 可选的 state DB 运行时上下文
///
/// # 返回值
/// 找到则返回 `Ok(Some(path))`；不存在则返回 `Ok(None)`；发生 IO 错误则返回 `Err`。
pub async fn find_archived_thread_path_by_id_str(
    codex_home: &Path,
    id_str: &str,
    state_db_ctx: Option<&codex_state::StateRuntime>,
) -> io::Result<Option<PathBuf>> {
    find_thread_path_by_id_str_in_subdir(codex_home, ARCHIVED_SESSIONS_SUBDIR, id_str, state_db_ctx)
        .await
}

/// 从 rollout 文件名中提取 `YYYY/MM/DD` 目录组件。
///
/// # 参数
/// - `file_name`: rollout 文件名
///
/// # 返回值
/// 返回 `(year, month, day)` 字符串元组；若文件名格式不匹配则返回 `None`。
pub fn rollout_date_parts(file_name: &OsStr) -> Option<(String, String, String)> {
    let name = file_name.to_string_lossy();
    let date = name.strip_prefix("rollout-")?.get(..10)?;
    let year = date.get(..4)?.to_string();
    let month = date.get(5..7)?.to_string();
    let day = date.get(8..10)?.to_string();
    Some((year, month, day))
}

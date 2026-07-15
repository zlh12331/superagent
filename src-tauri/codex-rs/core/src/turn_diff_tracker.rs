//! Turn diff 追踪器模块。
//!
//! 跟踪当前 turn 内由 apply_patch 变更产生的文本 diff，
//! 无需重新读取工作区文件系统。基于内存中的基线内容和当前内容，
//! 生成 unified diff 格式的变更摘要，供 UI 展示和日志记录使用。

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use sha1::digest::Output;

use codex_apply_patch::AppliedPatchChange;
use codex_apply_patch::AppliedPatchDelta;
use codex_apply_patch::AppliedPatchFileChange;

const ZERO_OID: &str = "0000000000000000000000000000000000000000";
const DEV_NULL: &str = "/dev/null";
const REGULAR_FILE_MODE: &str = "100644";
// 普通编辑在 100 ms 内即可完成；病态输入会回退到粗粒度但内容精确的 diff，
// 不会阻塞工具完成。
const DIFF_TIMEOUT: Duration = Duration::from_millis(100);

struct TrackedContent {
    content: String,
    revision: u64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TrackedPath {
    environment_id: String,
    path: PathBuf,
}

impl TrackedPath {
    fn new(environment_id: &str, path: &Path) -> Self {
        Self {
            environment_id: environment_id.to_string(),
            path: path.to_path_buf(),
        }
    }
}

#[derive(Eq, Hash, PartialEq)]
struct DiffCacheKey {
    left_path: TrackedPath,
    left_revision: Option<u64>,
    right_path: TrackedPath,
    right_revision: Option<u64>,
}

/// 跟踪当前 turn 内由已提交的 apply_patch 变更产生的净文本 diff，
/// 无需重新读取工作区文件系统。
pub struct TurnDiffTracker {
    valid: bool,
    display_roots_by_environment: HashMap<String, PathBuf>,
    baseline_by_path: HashMap<TrackedPath, TrackedContent>,
    current_by_path: HashMap<TrackedPath, TrackedContent>,
    origin_by_current_path: HashMap<TrackedPath, TrackedPath>,
    next_revision: u64,
    rendered_diffs: HashMap<DiffCacheKey, Option<String>>,
    unified_diff: Option<String>,
    #[cfg(test)]
    rendered_diff_count: std::cell::Cell<usize>,
}

impl Default for TurnDiffTracker {
    fn default() -> Self {
        Self {
            valid: true,
            display_roots_by_environment: HashMap::new(),
            baseline_by_path: HashMap::new(),
            current_by_path: HashMap::new(),
            origin_by_current_path: HashMap::new(),
            next_revision: 0,
            rendered_diffs: HashMap::new(),
            unified_diff: None,
            #[cfg(test)]
            rendered_diff_count: std::cell::Cell::new(0),
        }
    }
}

impl TurnDiffTracker {
    /// 创建一个默认的 `TurnDiffTracker` 实例。
    pub fn new() -> Self {
        Self::default()
    }

    /// 创建一个带有环境显示根路径映射的 `TurnDiffTracker` 实例。
    ///
    /// 显示根路径用于在 diff 输出中将绝对路径转换为相对于环境根目录的相对路径，
    /// 使 diff 输出更简洁易读。
    pub fn with_environment_display_roots(
        display_roots: impl IntoIterator<Item = (String, PathBuf)>,
    ) -> Self {
        let mut tracker = Self::new();
        tracker.display_roots_by_environment = display_roots.into_iter().collect();
        tracker
    }

    /// 跟踪一个 apply_patch delta 变更，更新内部状态并刷新 unified diff。
    ///
    /// 若 delta 不是精确变更（`is_exact()` 返回 `false`），则使追踪器失效。
    pub fn track_delta(&mut self, environment_id: &str, delta: &AppliedPatchDelta) {
        if !self.valid {
            return;
        }

        if !delta.is_exact() {
            self.invalidate();
            return;
        }

        for change in delta.changes() {
            self.apply_change(environment_id, change);
        }
        self.refresh_unified_diff();
    }

    /// 使追踪器失效，清除所有缓存的 diff 数据。
    ///
    /// 当遇到无法精确跟踪的变更时调用，后续 `get_unified_diff` 将返回 `None`。
    pub fn invalidate(&mut self) {
        self.valid = false;
        self.rendered_diffs.clear();
        self.unified_diff = None;
    }

    /// 返回当前 turn 的 unified diff 字符串。
    ///
    /// 若追踪器已失效或没有任何变更，返回 `None`。
    pub fn get_unified_diff(&self) -> Option<String> {
        self.unified_diff.clone()
    }

    pub(crate) fn has_unified_diff(&self) -> bool {
        self.unified_diff.is_some()
    }

    fn refresh_unified_diff(&mut self) {
        let rename_pairs = self.rename_pairs();
        let paired_destinations = rename_pairs.values().cloned().collect::<HashSet<_>>();
        let mut handled = HashSet::new();
        let mut paths = self
            .baseline_by_path
            .keys()
            .chain(self.current_by_path.keys())
            .cloned()
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| self.display_path(path));
        paths.dedup();

        let mut previous_diffs = std::mem::take(&mut self.rendered_diffs);
        let mut rendered_diffs = HashMap::new();
        let mut aggregated = String::new();
        for path in paths {
            if !handled.insert(path.clone()) {
                continue;
            }

            if paired_destinations.contains(&path) {
                continue;
            }

            let (left_path, right_path) = if let Some(dest) = rename_pairs.get(&path) {
                handled.insert(dest.clone());
                (&path, dest)
            } else {
                (&path, &path)
            };

            let left_content = self.baseline_by_path.get(left_path);
            let right_content = self.current_by_path.get(right_path);
            let key = DiffCacheKey {
                left_path: left_path.clone(),
                left_revision: left_content.map(|content| content.revision),
                right_path: right_path.clone(),
                right_revision: right_content.map(|content| content.revision),
            };
            let rendered = previous_diffs.remove(&key).unwrap_or_else(|| {
                self.render_diff(
                    left_path,
                    left_content.map(|content| content.content.as_str()),
                    right_path,
                    right_content.map(|content| content.content.as_str()),
                )
            });

            if let Some(diff) = rendered.as_deref() {
                aggregated.push_str(diff);
                if !aggregated.ends_with('\n') {
                    aggregated.push('\n');
                }
            }
            rendered_diffs.insert(key, rendered);
        }

        self.rendered_diffs = rendered_diffs;
        self.unified_diff = (!aggregated.is_empty()).then_some(aggregated);
    }

    fn apply_change(&mut self, environment_id: &str, change: &AppliedPatchChange) {
        let source_path = TrackedPath::new(environment_id, change.path.as_path());
        match &change.change {
            AppliedPatchFileChange::Add {
                content,
                overwritten_content,
            } => self.apply_add(source_path, content, overwritten_content.as_deref()),
            AppliedPatchFileChange::Delete { content } => self.apply_delete(source_path, content),
            AppliedPatchFileChange::Update {
                move_path,
                old_content,
                overwritten_move_content,
                new_content,
            } => {
                let move_path = move_path
                    .as_deref()
                    .map(|path| TrackedPath::new(environment_id, path));
                self.apply_update(
                    source_path,
                    move_path,
                    old_content,
                    overwritten_move_content.as_deref(),
                    new_content,
                )
            }
        }
    }

    fn apply_add(&mut self, path: TrackedPath, content: &str, overwritten_content: Option<&str>) {
        self.origin_by_current_path.remove(&path);
        if !self.current_by_path.contains_key(&path)
            && !self.baseline_by_path.contains_key(&path)
            && let Some(overwritten_content) = overwritten_content
        {
            let overwritten_content = self.tracked_content(overwritten_content);
            self.baseline_by_path
                .insert(path.clone(), overwritten_content);
        }
        let content = self.tracked_content(content);
        self.current_by_path.insert(path, content);
    }

    fn apply_delete(&mut self, path: TrackedPath, content: &str) {
        if self.current_by_path.remove(&path).is_none()
            && !self.baseline_by_path.contains_key(&path)
        {
            let content = self.tracked_content(content);
            self.baseline_by_path.insert(path.clone(), content);
        }
        self.origin_by_current_path.remove(&path);
    }

    fn apply_update(
        &mut self,
        source_path: TrackedPath,
        move_path: Option<TrackedPath>,
        old_content: &str,
        overwritten_move_content: Option<&str>,
        new_content: &str,
    ) {
        if !self.current_by_path.contains_key(&source_path)
            && !self.baseline_by_path.contains_key(&source_path)
        {
            let old_content = self.tracked_content(old_content);
            self.baseline_by_path
                .insert(source_path.clone(), old_content);
        }

        match move_path {
            Some(dest_path) => {
                if !self.current_by_path.contains_key(&dest_path)
                    && !self.baseline_by_path.contains_key(&dest_path)
                    && let Some(overwritten_move_content) = overwritten_move_content
                {
                    let overwritten_move_content = self.tracked_content(overwritten_move_content);
                    self.baseline_by_path
                        .insert(dest_path.clone(), overwritten_move_content);
                }
                let origin = self
                    .origin_by_current_path
                    .remove(&source_path)
                    .unwrap_or_else(|| source_path.clone());
                self.current_by_path.remove(&source_path);
                let new_content = self.tracked_content(new_content);
                self.current_by_path.insert(dest_path.clone(), new_content);
                self.origin_by_current_path.remove(&dest_path);
                if dest_path != origin {
                    self.origin_by_current_path.insert(dest_path, origin);
                }
            }
            None => {
                let new_content = self.tracked_content(new_content);
                self.current_by_path.insert(source_path, new_content);
            }
        }
    }

    fn tracked_content(&mut self, content: &str) -> TrackedContent {
        let revision = self.next_revision;
        self.next_revision += 1;
        TrackedContent {
            content: content.to_string(),
            revision,
        }
    }

    fn rename_pairs(&self) -> HashMap<TrackedPath, TrackedPath> {
        self.origin_by_current_path
            .iter()
            .filter_map(|(dest_path, origin_path)| {
                if dest_path == origin_path
                    || self.current_by_path.contains_key(origin_path)
                    || !self.current_by_path.contains_key(dest_path)
                    || !self.baseline_by_path.contains_key(origin_path)
                    || self.baseline_by_path.contains_key(dest_path)
                {
                    return None;
                }

                Some((origin_path.clone(), dest_path.clone()))
            })
            .collect()
    }

    fn render_diff(
        &self,
        left_path: &TrackedPath,
        left_content: Option<&str>,
        right_path: &TrackedPath,
        right_content: Option<&str>,
    ) -> Option<String> {
        if left_content == right_content {
            return None;
        }

        #[cfg(test)]
        self.rendered_diff_count
            .set(self.rendered_diff_count.get() + 1);

        let left_display = self.display_path(left_path);
        let right_display = self.display_path(right_path);
        let left_oid = left_content.map_or_else(
            || ZERO_OID.to_string(),
            |content| git_blob_oid(content.as_bytes()),
        );
        let right_oid = right_content.map_or_else(
            || ZERO_OID.to_string(),
            |content| git_blob_oid(content.as_bytes()),
        );

        let mut diff = format!("diff --git a/{left_display} b/{right_display}\n");
        match (left_content, right_content) {
            (None, Some(_)) => diff.push_str(&format!("new file mode {REGULAR_FILE_MODE}\n")),
            (Some(_), None) => diff.push_str(&format!("deleted file mode {REGULAR_FILE_MODE}\n")),
            (Some(_), Some(_)) => {}
            (None, None) => return None,
        }

        diff.push_str(&format!("index {left_oid}..{right_oid}\n"));

        let old_header = if left_content.is_some() {
            format!("a/{left_display}")
        } else {
            DEV_NULL.to_string()
        };
        let new_header = if right_content.is_some() {
            format!("b/{right_display}")
        } else {
            DEV_NULL.to_string()
        };

        let mut config = similar::TextDiff::configure();
        config.timeout(DIFF_TIMEOUT);
        let unified = config
            .diff_lines(left_content.unwrap_or(""), right_content.unwrap_or(""))
            .unified_diff()
            .context_radius(3)
            .header(&old_header, &new_header)
            .to_string();
        diff.push_str(&unified);
        Some(diff)
    }

    #[cfg(test)]
    fn rendered_diff_count(&self) -> usize {
        self.rendered_diff_count.get()
    }

    fn display_path(&self, path: &TrackedPath) -> String {
        let display = self
            .display_roots_by_environment
            .get(&path.environment_id)
            .and_then(|root| path.path.strip_prefix(root).ok())
            .unwrap_or(path.path.as_path());
        let display = display.display().to_string().replace('\\', "/");
        if self.display_roots_by_environment.len() > 1 && !path.environment_id.is_empty() {
            format!("{}/{display}", path.environment_id)
        } else {
            display
        }
    }
}

fn git_blob_oid(data: &[u8]) -> String {
    format!("{:x}", git_blob_sha1_hex_bytes(data))
}

/// 计算给定内容（字节）的 Git SHA-1 blob object ID。
fn git_blob_sha1_hex_bytes(data: &[u8]) -> Output<sha1::Sha1> {
    let header = format!("blob {}\0", data.len());
    use sha1::Digest;
    let mut hasher = sha1::Sha1::new();
    hasher.update(header.as_bytes());
    hasher.update(data);
    hasher.finalize()
}

#[cfg(test)]
#[path = "turn_diff_tracker_tests.rs"]
mod tests;

//! Git baseline 仓库管理模块。
//!
//! 用于内部目录（如 memories 目录）以 git 作为差异计算的实现细节。
//! baseline 仓库仅保留一次提交：reset 时会用全新的一次提交替换现有 `.git` 元数据，
//! 之后通过 [`diff_since_latest_init`] 计算当前目录与该提交之间的差异。
//!
//! 这些操作对 `root/.git` 是破坏性的，仅适用于内部目录，不应用于用户仓库。

use anyhow::Context;
use gix::hash::ObjectId;
use gix::objs::Tree;
use gix::objs::tree::Entry;
use gix::objs::tree::EntryKind;
use gix::objs::tree::EntryMode;
use similar::TextDiff;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use tokio::task;

use crate::operations::run_git_for_status;

/// baseline 提交的提交信息
const BASELINE_COMMIT_MESSAGE: &str =
    "Initialize Codex git baseline\n\nCo-authored-by: Codex <noreply@openai.com>";

/// 文件在 baseline 与当前目录之间的变更状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitBaselineChangeStatus {
    /// 新增文件（当前目录存在，baseline 不存在）
    Added,
    /// 修改文件（内容或模式不同）
    Modified,
    /// 删除文件（baseline 存在，当前目录不存在）
    Deleted,
}

impl GitBaselineChangeStatus {
    /// 返回该状态对应的 git 风格短标签（`A`/`M`/`D`）。
    pub fn label(self) -> &'static str {
        match self {
            GitBaselineChangeStatus::Added => "A",
            GitBaselineChangeStatus::Modified => "M",
            GitBaselineChangeStatus::Deleted => "D",
        }
    }
}

/// baseline 与当前目录之间单个文件变更的描述。
///
/// 字段含义：
/// - `status`：变更类型
/// - `path`：相对仓库根的路径（使用正斜杠分隔）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitBaselineChange {
    pub status: GitBaselineChangeStatus,
    pub path: String,
}

/// 自最近一次 baseline reset 至当前目录内容的结构化 diff。
///
/// 字段含义：
/// - `changes`：文件级变更列表
/// - `unified_diff`：可供 `git apply` 使用的 unified diff 文本
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitBaselineDiff {
    pub changes: Vec<GitBaselineChange>,
    pub unified_diff: String,
}

impl GitBaselineDiff {
    /// 是否存在任何变更。
    pub fn has_changes(&self) -> bool {
        !self.changes.is_empty()
    }
}

/// baseline 中单个文件条目的元信息（对象 ID 与文件模式）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GitBaselineFileEntry {
    oid: ObjectId,
    mode: EntryMode,
}

/// 用全新的一次提交 baseline 替换 `root` 中已有的 `.git` 元数据。
///
/// 该操作对 `root/.git` 是有意破坏性的，仅用于内部目录——这些目录里 git 仅作为
/// baseline/diff 的实现细节，并非用户仓库。
pub async fn reset_git_repository(root: &Path) -> anyhow::Result<()> {
    let root = root.to_path_buf();
    task::spawn_blocking(move || reset_git_repository_sync(&root)).await?
}

/// 确保 `root` 拥有可用的 git baseline 仓库。
///
/// 若已有可用的 `.git/` 元数据则保留；若缺失或不可用，则用全新的一次提交 baseline 替换。
pub async fn ensure_git_baseline_repository(root: &Path) -> anyhow::Result<()> {
    let root = root.to_path_buf();
    task::spawn_blocking(move || {
        fs::create_dir_all(&root)
            .with_context(|| format!("create git baseline root {}", root.display()))?;
        // 若已存在 .git 目录且 HEAD tree 可读，则视为可用，直接返回
        if root.join(".git").is_dir()
            && let Ok(repo) = gix::open(&root)
            && head_file_entries(&repo).is_ok()
        {
            return Ok(());
        }
        reset_git_repository_sync(&root)
    })
    .await?
}

// 同步版本：创建目录、移除旧 .git 元数据、init 新仓库并提交当前树
fn reset_git_repository_sync(root: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(root)
        .with_context(|| format!("create git baseline root {}", root.display()))?;
    remove_git_metadata(root)?;
    let repo = gix::init(root).with_context(|| format!("init git repo {}", root.display()))?;
    commit_current_tree(&repo, BASELINE_COMMIT_MESSAGE)?;
    write_index_from_head(root)?;
    Ok(())
}

/// 返回最近一次 baseline reset 与当前目录内容之间的差异。
pub async fn diff_since_latest_init(root: &Path) -> anyhow::Result<GitBaselineDiff> {
    let root = root.to_path_buf();
    task::spawn_blocking(move || {
        let repo = gix::open(&root).with_context(|| format!("open git repo {}", root.display()))?;
        let head_entries = head_file_entries(&repo)?;
        let current_entries = current_file_entries(&repo, &root)?;
        let changes = diff_entries(&head_entries, &current_entries);
        let unified_diff =
            render_unified_diff(&repo, &root, &head_entries, &current_entries, &changes)?;
        Ok(GitBaselineDiff {
            changes,
            unified_diff,
        })
    })
    .await?
}

// 移除 `root/.git`（无论是目录、文件还是符号链接）
fn remove_git_metadata(root: &Path) -> anyhow::Result<()> {
    let git_path = root.join(".git");
    let metadata = match fs::symlink_metadata(&git_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err).with_context(|| format!("stat {}", git_path.display())),
    };

    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(&git_path).with_context(|| format!("remove {}", git_path.display()))
    } else {
        fs::remove_file(&git_path).with_context(|| format!("remove {}", git_path.display()))
    }
}

// 将当前工作树写入 git 对象库并创建一次提交，提交者使用 Codex 署名
fn commit_current_tree(repo: &gix::Repository, message: &str) -> anyhow::Result<()> {
    let root = repo
        .workdir()
        .context("git baseline repo must have a worktree")?;
    let tree_id = write_tree(repo, root)?;
    let signature = codex_signature();
    let mut time = gix::date::parse::TimeBuf::default();
    let signature_ref = signature.to_ref(&mut time);
    repo.commit_as(
        signature_ref,
        signature_ref,
        "HEAD",
        message,
        tree_id,
        Vec::<ObjectId>::new(),
    )
    .context("commit git baseline repo")?;
    Ok(())
}

// 通过 `git read-tree --reset HEAD` 将 index 重置为 HEAD 树内容
fn write_index_from_head(root: &Path) -> anyhow::Result<()> {
    run_git_for_status(root, ["read-tree", "--reset", "HEAD"], /*env*/ None)
        .context("write git baseline index from HEAD")
}

// 构造 Codex 专用的提交者署名（固定 name/email，时间为当前 UTC 时间）
fn codex_signature() -> gix::actor::Signature {
    gix::actor::Signature {
        name: "Codex".into(),
        email: "noreply@openai.com".into(),
        time: gix::date::Time {
            seconds: chrono::Utc::now().timestamp(),
            offset: 0,
        },
    }
}

// 递归遍历目录，将所有文件/符号链接写入 git 对象库，并构造对应的 tree 对象
fn write_tree(repo: &gix::Repository, dir: &Path) -> anyhow::Result<ObjectId> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        if file_name == OsStr::new(".git") {
            continue;
        }

        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let oid = write_tree(repo, &path)?;
            let tree = repo
                .find_tree(oid)
                .with_context(|| format!("load tree {}", path.display()))?;
            if tree.decode()?.entries.is_empty() {
                continue;
            }
            entries.push(Entry {
                mode: EntryKind::Tree.into(),
                filename: os_str_to_bstring(&file_name),
                oid,
            });
        } else if file_type.is_file() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            let oid = repo
                .write_blob(bytes)
                .with_context(|| format!("write blob {}", path.display()))?
                .detach();
            entries.push(Entry {
                mode: file_mode(&path, EntryKind::Blob)?,
                filename: os_str_to_bstring(&file_name),
                oid,
            });
        } else if file_type.is_symlink() {
            let target =
                fs::read_link(&path).with_context(|| format!("read symlink {}", path.display()))?;
            let oid = repo
                .write_blob(path_to_bytes(&target))
                .with_context(|| format!("write symlink blob {}", path.display()))?
                .detach();
            entries.push(Entry {
                mode: EntryKind::Link.into(),
                filename: os_str_to_bstring(&file_name),
                oid,
            });
        }
    }

    entries.sort();
    repo.write_object(&Tree { entries })
        .context("write tree object")
        .map(gix::Id::detach)
}

// 读取 HEAD 树中的所有文件条目，返回 路径 -> 条目 的有序映射
fn head_file_entries(
    repo: &gix::Repository,
) -> anyhow::Result<BTreeMap<String, GitBaselineFileEntry>> {
    let tree_id = repo.head_tree_id().context("load HEAD tree id")?;
    let tree = repo.find_tree(tree_id.detach()).context("load HEAD tree")?;
    let mut entries = BTreeMap::new();
    collect_tree_entries(repo, tree, PathBuf::new(), &mut entries)?;
    Ok(entries)
}

// 递归收集 tree 中的所有文件条目到 `entries`
fn collect_tree_entries(
    repo: &gix::Repository,
    tree: gix::Tree<'_>,
    prefix: PathBuf,
    entries: &mut BTreeMap<String, GitBaselineFileEntry>,
) -> anyhow::Result<()> {
    for entry in tree.iter() {
        let entry = entry?;
        let file_name = bstr_to_path(entry.inner.filename);
        let path = prefix.join(file_name);
        if entry.inner.mode.is_tree() {
            let tree = repo
                .find_tree(entry.inner.oid.to_owned())
                .context("load child tree")?;
            collect_tree_entries(repo, tree, path, entries)?;
        } else {
            entries.insert(
                path_to_slash_string(&path),
                GitBaselineFileEntry {
                    oid: entry.inner.oid.to_owned(),
                    mode: entry.inner.mode,
                },
            );
        }
    }
    Ok(())
}

// 扫描当前磁盘上的文件，计算每个文件的 blob oid 与模式（不写入对象库）
fn current_file_entries(
    repo: &gix::Repository,
    root: &Path,
) -> anyhow::Result<BTreeMap<String, GitBaselineFileEntry>> {
    let mut entries = BTreeMap::new();
    collect_current_entries(repo, root, root, &mut entries)?;
    Ok(entries)
}

// 递归收集磁盘上的文件条目（仅计算 oid，不写入 loose 对象）
fn collect_current_entries(
    repo: &gix::Repository,
    root: &Path,
    dir: &Path,
    entries: &mut BTreeMap<String, GitBaselineFileEntry>,
) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.file_name() == Some(OsStr::new(".git")) {
            continue;
        }

        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_current_entries(repo, root, &path, entries)?;
        } else if file_type.is_file() {
            let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            entries.insert(
                relative_slash_path(root, &path)?,
                GitBaselineFileEntry {
                    oid: blob_oid(repo, &bytes)?,
                    mode: file_mode(&path, EntryKind::Blob)?,
                },
            );
        } else if file_type.is_symlink() {
            let target =
                fs::read_link(&path).with_context(|| format!("read symlink {}", path.display()))?;
            entries.insert(
                relative_slash_path(root, &path)?,
                GitBaselineFileEntry {
                    oid: blob_oid(repo, &path_to_bytes(&target))?,
                    mode: EntryKind::Link.into(),
                },
            );
        }
    }
    Ok(())
}

// 计算给定字节的 git blob oid（仅哈希，不写入对象库）
fn blob_oid(repo: &gix::Repository, bytes: &[u8]) -> anyhow::Result<ObjectId> {
    gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, bytes)
        .context("compute git baseline blob oid")
}

// 比较两组条目，生成文件级变更列表（新增/修改/删除），按路径排序
fn diff_entries(
    head: &BTreeMap<String, GitBaselineFileEntry>,
    current: &BTreeMap<String, GitBaselineFileEntry>,
) -> Vec<GitBaselineChange> {
    let mut entries = Vec::new();
    for (path, entry) in current {
        match head.get(path) {
            None => entries.push(GitBaselineChange {
                status: GitBaselineChangeStatus::Added,
                path: path.clone(),
            }),
            Some(head_entry) if head_entry != entry => entries.push(GitBaselineChange {
                status: GitBaselineChangeStatus::Modified,
                path: path.clone(),
            }),
            Some(_) => {}
        }
    }
    for path in head.keys() {
        if !current.contains_key(path) {
            entries.push(GitBaselineChange {
                status: GitBaselineChangeStatus::Deleted,
                path: path.clone(),
            });
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries
}

// 为每个变更生成 unified diff 段落并拼接成完整 diff 文本
fn render_unified_diff(
    repo: &gix::Repository,
    root: &Path,
    head_entries: &BTreeMap<String, GitBaselineFileEntry>,
    current_entries: &BTreeMap<String, GitBaselineFileEntry>,
    changes: &[GitBaselineChange],
) -> anyhow::Result<String> {
    let mut rendered = String::new();
    for change in changes {
        rendered.push_str(&render_change_diff(
            repo,
            root,
            head_entries,
            current_entries,
            change,
        )?);
    }
    Ok(rendered)
}

// 为单个变更生成 diff 段落，包含 mode 变更信息与 unified diff 主体
fn render_change_diff(
    repo: &gix::Repository,
    root: &Path,
    head_entries: &BTreeMap<String, GitBaselineFileEntry>,
    current_entries: &BTreeMap<String, GitBaselineFileEntry>,
    change: &GitBaselineChange,
) -> anyhow::Result<String> {
    let old_entry = head_entries.get(&change.path);
    let new_entry = current_entries.get(&change.path);
    let old_bytes = old_entry
        .map(|entry| read_head_blob(repo, entry))
        .transpose()
        .with_context(|| format!("read HEAD content for {}", change.path))?;
    let new_bytes = new_entry
        .map(|_| read_current_file_bytes(root, &change.path))
        .transpose()
        .with_context(|| format!("read current content for {}", change.path))?;

    let old_text = String::from_utf8_lossy(old_bytes.as_deref().unwrap_or_default());
    let new_text = String::from_utf8_lossy(new_bytes.as_deref().unwrap_or_default());
    let old_header = if old_bytes.is_some() {
        format!("a/{}", change.path)
    } else {
        "/dev/null".to_string()
    };
    let new_header = if new_bytes.is_some() {
        format!("b/{}", change.path)
    } else {
        "/dev/null".to_string()
    };

    let mut section = format!("diff --git a/{0} b/{0}\n", change.path);
    match (old_entry, new_entry) {
        (None, Some(entry)) => {
            section.push_str(&format!("new file mode {}\n", mode_label(entry.mode)));
        }
        (Some(entry), None) => {
            section.push_str(&format!("deleted file mode {}\n", mode_label(entry.mode)));
        }
        (Some(old), Some(new)) if old.mode != new.mode => {
            section.push_str(&format!(
                "old mode {}\nnew mode {}\n",
                mode_label(old.mode),
                mode_label(new.mode)
            ));
        }
        (Some(_), Some(_)) => {}
        (None, None) => return Ok(String::new()),
    }

    let diff = TextDiff::from_lines(&old_text, &new_text)
        .unified_diff()
        .context_radius(3)
        .header(&old_header, &new_header)
        .to_string();
    section.push_str(&diff);
    if !section.ends_with('\n') {
        section.push('\n');
    }
    Ok(section)
}

// 从对象库读取 HEAD 中的 blob 内容
fn read_head_blob(repo: &gix::Repository, entry: &GitBaselineFileEntry) -> anyhow::Result<Vec<u8>> {
    let mut blob = repo.find_blob(entry.oid)?;
    Ok(blob.take_data())
}

// 读取当前磁盘上文件的内容（若为符号链接则读取目标路径的字节）
fn read_current_file_bytes(root: &Path, relative_path: &str) -> anyhow::Result<Vec<u8>> {
    let path = root.join(relative_path);
    let metadata =
        fs::symlink_metadata(&path).with_context(|| format!("stat {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        let target =
            fs::read_link(&path).with_context(|| format!("read symlink {}", path.display()))?;
        Ok(path_to_bytes(&target))
    } else {
        fs::read(&path).with_context(|| format!("read {}", path.display()))
    }
}

// 将 git EntryMode 转换为可读的八进制模式字符串
fn mode_label(mode: EntryMode) -> &'static str {
    match mode.kind() {
        EntryKind::Blob => "100644",
        EntryKind::BlobExecutable => "100755",
        EntryKind::Link => "120000",
        EntryKind::Tree => "040000",
        EntryKind::Commit => "160000",
    }
}

// Unix 下根据文件权限位判断是否为可执行文件
#[cfg(unix)]
fn file_mode(path: &Path, default: EntryKind) -> anyhow::Result<EntryMode> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)?.permissions().mode();
    Ok(if mode & 0o111 == 0 {
        default.into()
    } else {
        EntryKind::BlobExecutable.into()
    })
}

// 非 Unix 平台无法读取权限位，直接使用默认 EntryKind
#[cfg(not(unix))]
fn file_mode(_path: &Path, default: EntryKind) -> anyhow::Result<EntryMode> {
    Ok(default.into())
}

// OsStr <-> BString 转换（Unix 直接取字节）
#[cfg(unix)]
fn os_str_to_bstring(value: &OsStr) -> gix::bstr::BString {
    use std::os::unix::ffi::OsStrExt;

    value.as_bytes().into()
}

#[cfg(not(unix))]
fn os_str_to_bstring(value: &OsStr) -> gix::bstr::BString {
    value.to_string_lossy().as_bytes().into()
}

// Path -> Vec<u8> 转换（Unix 直接取字节）
#[cfg(unix)]
fn path_to_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().to_vec()
}

// Path -> Vec<u8> 转换（非 Unix 走 UTF-8 字符串）
#[cfg(not(unix))]
fn path_to_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().as_bytes().to_vec()
}

// BStr -> PathBuf 转换：Unix 直接从字节构造，非 Unix 走 UTF-8 字符串
fn bstr_to_path(value: &gix::bstr::BStr) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        PathBuf::from(OsStr::from_bytes(value))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(value.to_string())
    }
}

// 计算相对 `root` 的路径并以正斜杠分隔为字符串
fn relative_slash_path(root: &Path, path: &Path) -> anyhow::Result<String> {
    path.strip_prefix(root)
        .with_context(|| format!("strip {} from {}", root.display(), path.display()))
        .map(path_to_slash_string)
}

// 将路径各组件以正斜杠拼接为字符串
fn path_to_slash_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn git_stdout(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("run git command");
        assert!(
            output.status.success(),
            "git command failed: {args:?}\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    #[tokio::test]
    async fn reset_creates_fresh_baseline() {
        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("MEMORY.md"), "baseline").expect("write memory");

        reset_git_repository(&root).await.expect("reset repo");

        assert!(root.join(".git").is_dir());
        assert!(root.join(".git/index").is_file());
        let diff = diff_since_latest_init(&root).await.expect("diff");
        assert!(!diff.has_changes());
        assert_eq!(diff.unified_diff, "");
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]), "");
        assert_eq!(git_stdout(&root, &["ls-files"]), "MEMORY.md\n");
    }

    #[tokio::test]
    async fn ensure_recovers_from_unborn_repository() {
        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("MEMORY.md"), "memory").expect("write memory");
        gix::init(&root).expect("init git repo without baseline commit");

        ensure_git_baseline_repository(&root)
            .await
            .expect("ensure repo");

        let diff = diff_since_latest_init(&root).await.expect("diff");
        assert!(!diff.has_changes());
        assert_eq!(git_stdout(&root, &["status", "--porcelain"]), "");
        assert_eq!(git_stdout(&root, &["ls-files"]), "MEMORY.md\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_index_ignores_configured_hooks_path() {
        use std::os::unix::fs::PermissionsExt;

        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        let hooks_dir = root.join(".git/hooks-path-test");
        let marker_path = root.join("hook-ran");
        let hook_path = hooks_dir.join("post-index-change");

        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("MEMORY.md"), "baseline").expect("write memory");
        reset_git_repository(&root).await.expect("reset repo");
        fs::create_dir_all(&hooks_dir).expect("create hook dir");
        fs::write(
            &hook_path,
            format!(
                "#!/bin/sh\nprintf ran > \"{}\"\n",
                marker_path.to_string_lossy()
            ),
        )
        .expect("write post-index-change hook");
        let mut permissions = fs::metadata(&hook_path)
            .expect("read hook metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook_path, permissions).expect("mark hook executable");
        git_stdout(
            &root,
            &[
                "config",
                "core.hooksPath",
                hooks_dir.to_string_lossy().as_ref(),
            ],
        );

        write_index_from_head(&root).expect("rewrite baseline index");

        assert!(
            !marker_path.exists(),
            "baseline index writes should not invoke configured hook directories"
        );
    }

    #[tokio::test]
    async fn diff_reports_added_modified_and_deleted_files() {
        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        fs::create_dir_all(root.join("rollout_summaries")).expect("create rollout summaries");
        fs::write(root.join("MEMORY.md"), "old").expect("write memory");
        fs::write(
            root.join("rollout_summaries/deleted.md"),
            "thread_id: 00000000-0000-4000-8000-000000000001\nimportant stale evidence\n",
        )
        .expect("write rollout summary");
        reset_git_repository(&root).await.expect("reset repo");

        fs::write(root.join("MEMORY.md"), "new").expect("update memory");
        fs::write(root.join("memory_summary.md"), "summary").expect("write summary");
        fs::remove_file(root.join("rollout_summaries/deleted.md")).expect("delete summary");

        let diff = diff_since_latest_init(&root).await.expect("diff");
        assert_eq!(
            diff.changes,
            vec![
                GitBaselineChange {
                    status: GitBaselineChangeStatus::Modified,
                    path: "MEMORY.md".to_string(),
                },
                GitBaselineChange {
                    status: GitBaselineChangeStatus::Added,
                    path: "memory_summary.md".to_string(),
                },
                GitBaselineChange {
                    status: GitBaselineChangeStatus::Deleted,
                    path: "rollout_summaries/deleted.md".to_string(),
                },
            ]
        );
        assert!(
            diff.unified_diff
                .contains("diff --git a/MEMORY.md b/MEMORY.md")
        );
        assert!(diff.unified_diff.contains("-old"));
        assert!(diff.unified_diff.contains("+new"));
        assert!(
            diff.unified_diff
                .contains("diff --git a/memory_summary.md b/memory_summary.md")
        );
        assert!(diff.unified_diff.contains("+summary"));
        assert!(
            diff.unified_diff.contains(
                "diff --git a/rollout_summaries/deleted.md b/rollout_summaries/deleted.md"
            )
        );
        assert!(diff.unified_diff.contains("deleted file mode 100644"));
        assert!(
            diff.unified_diff
                .contains("-thread_id: 00000000-0000-4000-8000-000000000001")
        );
        assert!(diff.unified_diff.contains("-important stale evidence"));
    }

    #[tokio::test]
    async fn reset_drops_previous_history() {
        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("MEMORY.md"), "old").expect("write memory");
        reset_git_repository(&root).await.expect("reset repo");

        fs::write(root.join("MEMORY.md"), "new").expect("update memory");
        reset_git_repository(&root).await.expect("reset repo again");

        let repo = gix::open(&root).expect("open repo");
        let head = repo.head_id().expect("head").detach();
        let commit = repo.find_commit(head).expect("find head commit");
        assert_eq!(commit.parent_ids().count(), 0);
        let diff = diff_since_latest_init(&root).await.expect("diff");
        assert!(!diff.has_changes());
    }

    #[tokio::test]
    async fn status_scan_does_not_write_added_file_blobs() {
        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        fs::create_dir_all(&root).expect("create root");
        reset_git_repository(&root).await.expect("reset repo");
        let added_content = b"new uncommitted memory";
        fs::write(root.join("MEMORY.md"), added_content).expect("write memory");

        let diff = diff_since_latest_init(&root).await.expect("diff");
        assert!(diff.has_changes());

        let repo = gix::open(&root).expect("open repo");
        let added_oid = blob_oid(&repo, added_content).expect("compute added oid");
        assert!(
            repo.find_blob(added_oid).is_err(),
            "status scans should hash current files without writing loose git objects"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_executable_bit_changes_as_modified() {
        use std::os::unix::fs::PermissionsExt;

        let home = TempDir::new().expect("tempdir");
        let root = home.path().join("repo");
        fs::create_dir_all(&root).expect("create root");
        let path = root.join("MEMORY.md");
        fs::write(&path, "same content").expect("write memory");
        reset_git_repository(&root).await.expect("reset repo");
        let mut permissions = fs::metadata(&path).expect("stat memory").permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        fs::set_permissions(&path, permissions).expect("chmod memory");

        let diff = diff_since_latest_init(&root).await.expect("diff");
        assert_eq!(
            diff.changes,
            vec![GitBaselineChange {
                status: GitBaselineChangeStatus::Modified,
                path: "MEMORY.md".to_string(),
            }]
        );
        assert!(diff.unified_diff.contains("old mode 100644"));
        assert!(diff.unified_diff.contains("new mode 100755"));
    }
}

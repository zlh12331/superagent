mod invocation;
mod parser;
mod seek_sequence;
mod standalone_executable;
mod streaming_parser;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use codex_exec_server::CreateDirectoryOptions;
use codex_exec_server::ExecutorFileSystem;
use codex_exec_server::FileSystemSandboxContext;
use codex_exec_server::RemoveOptions;
use codex_utils_path_uri::PathUri;
use codex_utils_path_uri::PathUriParseError;
pub use parser::Hunk;
pub use parser::ParseError;
use parser::ParseError::*;
pub use parser::UpdateFileChunk;
pub use parser::parse_patch;
use similar::TextDiff;
pub use streaming_parser::StreamingPatchParser;
use thiserror::Error;

pub use invocation::maybe_parse_apply_patch_verified;
pub use invocation::verify_apply_patch_args;
pub use standalone_executable::main;

use crate::invocation::ExtractHeredocError;

/// 特殊的 argv[1] 标记：当 Codex 可执行文件自调用以运行内部 `apply_patch`
/// 流程时使用。
///
/// 虽然这个常量位于 `codex-apply-patch` crate 中（避免 `codex-arg0` 依赖
/// `codex-core`），但它仍属于 "codex core" 进程调用契约的一部分，用于
/// 独立的 `apply_patch` 命令接口。
pub const CODEX_CORE_APPLY_PATCH_ARG1: &str = "--codex-run-as-apply-patch";

/// 应用 patch 时可能出现的错误。
#[derive(Debug, Error, PartialEq)]
pub enum ApplyPatchError {
    /// patch 文本解析错误。
    #[error(transparent)]
    ParseError(#[from] ParseError),
    /// 文件 I/O 错误。
    #[error(transparent)]
    IoError(#[from] IoError),
    /// 应用 patch chunk 时计算替换内容失败。
    #[error("{0}")]
    ComputeReplacements(String),
    /// patch 中的路径无法作为 [`PathUri`] 解析。
    #[error(transparent)]
    PathUri(#[from] PathUriParseError),
    /// 提供了一个原始 patch 文本，但没有显式调用 `apply_patch`。
    #[error(
        "patch detected without explicit call to apply_patch. Rerun as [\"apply_patch\", \"<patch>\"]"
    )]
    ImplicitInvocation,
}

impl From<std::io::Error> for ApplyPatchError {
    fn from(err: std::io::Error) -> Self {
        ApplyPatchError::IoError(IoError {
            context: "I/O error".to_string(),
            source: err,
        })
    }
}

impl From<&std::io::Error> for ApplyPatchError {
    fn from(err: &std::io::Error) -> Self {
        ApplyPatchError::IoError(IoError {
            context: "I/O error".to_string(),
            source: std::io::Error::new(err.kind(), err.to_string()),
        })
    }
}

/// 带上下文的 I/O 错误，把底层 [`std::io::Error`] 与一段描述性 context 文本绑定在一起。
#[derive(Debug, Error)]
#[error("{context}: {source}")]
pub struct IoError {
    context: String,
    #[source]
    source: std::io::Error,
}

impl PartialEq for IoError {
    fn eq(&self, other: &Self) -> bool {
        self.context == other.context && self.source.to_string() == other.source.to_string()
    }
}

/// 传给 `apply_patch` 的 PATCH 参数：既包含原始 patch 文本，
/// 也包含解析后得到的 hunk 列表。
#[derive(Debug, PartialEq)]
pub struct ApplyPatchArgs {
    /// 原始 patch 文本。
    pub patch: String,
    /// 解析得到的 hunk 列表。
    pub hunks: Vec<Hunk>,
    /// 可选工作目录（用于解析相对路径）。
    pub workdir: Option<String>,
    /// 可选的 environment id（用于多环境隔离）。
    pub environment_id: Option<String>,
}

/// 一份 patch 中针对单个文件的预期变更。
#[derive(Debug, PartialEq)]
pub enum ApplyPatchFileChange {
    /// 新增文件，`content` 为完整内容。
    Add {
        content: String,
    },
    /// 删除文件，`content` 为删除前的原内容（用于回滚/审计）。
    Delete {
        content: String,
    },
    /// 更新文件，可附带 `move_path` 实现移动/重命名。
    Update {
        /// 该文件更新后的 unified diff 表示（仅用于展示）。
        unified_diff: String,
        /// 移动/重命名目标路径；若为 `None` 则原地更新。
        move_path: Option<PathUri>,
        /// 应用 unified_diff 后得到的最新文件内容。
        new_content: String,
    },
}

/// `apply_patch` 命令解析结果的一种"可能"状态。
#[derive(Debug, PartialEq)]
pub enum MaybeApplyPatchVerified {
    /// `argv` 对应一个 `apply_patch` 调用，`Body` 内是解析得到的预期文件变更。
    Body(ApplyPatchAction),
    /// `argv` 无法解析为 `apply_patch` 调用（shell 语法错误等原因）。
    ShellParseError(ExtractHeredocError),
    /// `argv` 对应一个 `apply_patch` 调用，但因指定错误无法完成（含错误详情）。
    CorrectnessError(ApplyPatchError),
    /// `argv` 明确不是 `apply_patch` 调用。
    NotApplyPatch,
}

/// 解析 `apply_patch` 命令得到的结果。
/// 按构造约定，所有路径均为绝对路径。
#[derive(Debug, PartialEq)]
pub struct ApplyPatchAction {
    changes: HashMap<PathUri, ApplyPatchFileChange>,

    /// 可用于应用 patch 的原始 patch 参数。
    /// 即如果原始参数以 "lenient" 模式且通过 heredoc 形式给出，
    /// 此字段为去掉 heredoc 包裹后的纯净 patch 文本。
    pub patch: String,

    /// 用于解析 patch 中相对路径的工作目录。
    pub cwd: PathUri,
}

impl ApplyPatchAction {
    /// 判断是否没有任何文件变更。
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// 返回 patch 应用后将产生的文件变更映射。
    pub fn changes(&self) -> &HashMap<PathUri, ApplyPatchFileChange> {
        &self.changes
    }

    /// 仅用于测试。不值得为它单独引入 feature flag。
    pub fn new_add_for_test(path: &PathUri, content: String) -> Self {
        #[expect(clippy::expect_used)]
        let filename = path.basename().expect("path should not be empty");
        let patch = format!(
            r#"*** Begin Patch
*** Update File: {filename}
@@
+ {content}
*** End Patch"#,
        );
        let changes = HashMap::from([(path.clone(), ApplyPatchFileChange::Add { content })]);
        #[expect(clippy::expect_used)]
        Self {
            changes,
            cwd: path.parent().expect("path should have parent"),
            patch,
        }
    }
}

/// 应用 patch 过程中实际已落盘的文件变更集合（按应用顺序保留）。
#[derive(Clone, Debug, PartialEq)]
pub struct AppliedPatchDelta {
    changes: Vec<AppliedPatchChange>,
    exact: bool,
}

impl AppliedPatchDelta {
    fn new(changes: Vec<AppliedPatchChange>, exact: bool) -> Self {
        Self { changes, exact }
    }

    fn empty() -> Self {
        Self::new(Vec::new(), /*exact*/ true)
    }

    /// 返回已落盘的变更列表（按应用顺序）。
    pub fn changes(&self) -> &[AppliedPatchChange] {
        &self.changes
    }

    /// 判断是否为空。
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// 是否为"精确"的 delta：即所有变更都确切地落盘，没有不确定性。
    pub fn is_exact(&self) -> bool {
        self.exact
    }

    /// 在当前 delta 后追加另一段已落盘变更，并保持聚合后的 `exact` 标志。
    pub fn append(&mut self, other: Self) {
        self.changes.extend(other.changes);
        self.exact &= other.exact;
    }
}

impl Default for AppliedPatchDelta {
    fn default() -> Self {
        Self::empty()
    }
}

/// 一条已落盘的文件变更，按应用顺序保留。
#[derive(Clone, Debug, PartialEq)]
pub struct AppliedPatchChange {
    /// 被变更的文件路径。
    pub path: PathBuf,
    /// 具体的变更内容。
    pub change: AppliedPatchFileChange,
}

/// 已落盘的文件变更（区别于 [`ApplyPatchFileChange`] 中的"预期"变更）。
#[derive(Clone, Debug, PartialEq)]
pub enum AppliedPatchFileChange {
    /// 新增文件。`overwritten_content` 表示若目标已存在则被覆盖的旧内容。
    Add {
        content: String,
        overwritten_content: Option<String>,
    },
    /// 删除文件。`content` 为删除前的内容。
    Delete {
        content: String,
    },
    /// 更新文件（可选移动/重命名）。
    Update {
        /// 移动/重命名目标路径；为 `None` 表示原地更新。
        move_path: Option<PathBuf>,
        /// 更新前的原内容。
        old_content: String,
        /// 若 `move_path` 目标位置已有文件，则记录其被覆盖前的内容。
        overwritten_move_content: Option<String>,
        /// 更新后的新内容。
        new_content: String,
    },
}

/// 应用 patch 失败的信息：包含失败原因以及在失败前已经确实落盘的变更。
#[derive(Debug, Error)]
#[error("{error}")]
pub struct ApplyPatchFailure {
    #[source]
    error: ApplyPatchError,
    delta: AppliedPatchDelta,
}

impl ApplyPatchFailure {
    fn new(error: ApplyPatchError, delta: AppliedPatchDelta) -> Self {
        Self { error, delta }
    }

    fn without_delta(error: ApplyPatchError) -> Self {
        Self::new(error, AppliedPatchDelta::empty())
    }

    /// 返回失败前已经落盘的变更。
    pub fn delta(&self) -> &AppliedPatchDelta {
        &self.delta
    }

    /// 将错误与已落盘变更拆分返回。
    pub fn into_parts(self) -> (ApplyPatchError, AppliedPatchDelta) {
        (self.error, self.delta)
    }
}

/// 应用 patch 并将结果输出到 stdout / stderr。
///
/// - `patch`：patch 文本
/// - `cwd`：用于解析相对路径的工作目录
/// - `stdout` / `stderr`：用于输出结果与错误信息
/// - `fs`：抽象文件系统接口
/// - `sandbox`：可选沙箱上下文
///
/// 成功返回 [`AppliedPatchDelta`]，失败返回 [`ApplyPatchFailure`]。
pub async fn apply_patch(
    patch: &str,
    cwd: &PathUri,
    stdout: &mut impl std::io::Write,
    stderr: &mut impl std::io::Write,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> Result<AppliedPatchDelta, ApplyPatchFailure> {
    let hunks = match parse_patch(patch) {
        Ok(source) => source.hunks,
        Err(e) => {
            match &e {
                InvalidPatchError(message) => {
                    writeln!(stderr, "Invalid patch: {message}")
                        .map_err(ApplyPatchError::from)
                        .map_err(ApplyPatchFailure::without_delta)?;
                }
                InvalidHunkError {
                    message,
                    line_number,
                } => {
                    writeln!(
                        stderr,
                        "Invalid patch hunk on line {line_number}: {message}"
                    )
                    .map_err(ApplyPatchError::from)
                    .map_err(ApplyPatchFailure::without_delta)?;
                }
            }
            return Err(ApplyPatchFailure::without_delta(
                ApplyPatchError::ParseError(e),
            ));
        }
    };

    apply_hunks(&hunks, cwd, stdout, stderr, fs, sandbox).await
}

/// 应用已解析的 hunks 并持续更新 stdout/stderr。
pub async fn apply_hunks(
    hunks: &[Hunk],
    cwd: &PathUri,
    stdout: &mut impl std::io::Write,
    stderr: &mut impl std::io::Write,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> Result<AppliedPatchDelta, ApplyPatchFailure> {
    let mut delta = AppliedPatchDelta::empty();
    match apply_hunks_to_files(hunks, cwd, fs, sandbox, &mut delta).await {
        Ok(affected_paths) => {
            print_summary(&affected_paths, stdout).map_err(|error| {
                ApplyPatchFailure::new(ApplyPatchError::from(error), delta.clone())
            })?;
            Ok(delta)
        }
        Err(error) => {
            let msg = error.to_string();
            writeln!(stderr, "{msg}").map_err(|error| {
                ApplyPatchFailure::new(ApplyPatchError::from(error), delta.clone())
            })?;
            let error = if let Some(io) = error.downcast_ref::<std::io::Error>() {
                ApplyPatchError::from(io)
            } else {
                ApplyPatchError::IoError(IoError {
                    context: msg,
                    source: std::io::Error::other(error),
                })
            };
            Err(ApplyPatchFailure::new(error, delta))
        }
    }
}

/// 应用 patch 时被影响的文件路径集合。
///
/// 记录哪些文件被新增/修改/删除，并在面向用户的摘要中保留 patch 中的原始路径拼写。
pub struct AffectedPaths {
    /// 新增的文件路径。
    pub added: Vec<PathBuf>,
    /// 修改的文件路径。
    pub modified: Vec<PathBuf>,
    /// 删除的文件路径。
    pub deleted: Vec<PathBuf>,
}

/// 将 hunks 应用到文件系统，返回哪些文件被新增、修改或删除。
/// 若 patch 无法应用则返回错误。
async fn apply_hunks_to_files(
    hunks: &[Hunk],
    cwd: &PathUri,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
    delta: &mut AppliedPatchDelta,
) -> anyhow::Result<AffectedPaths> {
    if hunks.is_empty() {
        anyhow::bail!("No files were modified.");
    }

    let mut added: Vec<PathBuf> = Vec::new();
    let mut modified: Vec<PathBuf> = Vec::new();
    let mut deleted: Vec<PathBuf> = Vec::new();
    // A failed write can still have modified the target before surfacing an
    // error (for example by truncating before ENOSPC), so the accumulated
    // delta is no longer exact when a write fails.
    macro_rules! try_write {
        ($result:expr) => {
            match $result {
                Ok(value) => value,
                Err(error) => {
                    delta.exact = false;
                    return Err(anyhow::Error::from(error));
                }
            }
        };
    }

    // TODO(anp): Carry PathUri through committed patch deltas and the turn diff tracker.
    for hunk in hunks {
        let affected_path = hunk.path().to_path_buf();
        let path_uri = hunk.resolve_path(cwd)?;
        match hunk {
            Hunk::AddFile { contents, .. } => {
                let overwritten_content =
                    read_optional_file_text_for_delta(&path_uri, fs, sandbox, &mut delta.exact)
                        .await;
                try_write!(
                    write_file_with_missing_parent_retry(
                        fs,
                        &path_uri,
                        contents.clone().into_bytes(),
                        sandbox,
                    )
                    .await
                );
                delta.changes.push(AppliedPatchChange {
                    path: path_uri.to_path_buf(),
                    change: AppliedPatchFileChange::Add {
                        content: contents.clone(),
                        overwritten_content,
                    },
                });
                added.push(affected_path);
            }
            Hunk::DeleteFile { .. } => {
                note_existing_path_delta_support(&path_uri, fs, sandbox, &mut delta.exact).await;
                let deleted_content = fs.read_file_text(&path_uri, sandbox).await.ok();
                if deleted_content.is_none() {
                    delta.exact = false;
                }
                ensure_not_directory(&path_uri, fs, sandbox)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to delete file {}",
                            path_uri.inferred_native_path_string()
                        )
                    })?;
                if let Err(error) = fs
                    .remove(
                        &path_uri,
                        RemoveOptions {
                            recursive: false,
                            force: false,
                        },
                        sandbox,
                    )
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to delete file {}",
                            path_uri.inferred_native_path_string()
                        )
                    })
                {
                    delta.exact &= remove_failure_was_side_effect_free(
                        &path_uri,
                        deleted_content.as_deref(),
                        fs,
                        sandbox,
                    )
                    .await;
                    return Err(error);
                }
                if let Some(content) = deleted_content {
                    delta.changes.push(AppliedPatchChange {
                        path: path_uri.to_path_buf(),
                        change: AppliedPatchFileChange::Delete { content },
                    });
                }
                deleted.push(affected_path);
            }
            Hunk::UpdateFile {
                move_path, chunks, ..
            } => {
                note_existing_path_delta_support(&path_uri, fs, sandbox, &mut delta.exact).await;
                let AppliedPatch {
                    original_contents,
                    new_contents,
                } = derive_new_contents_from_chunks(&path_uri, chunks, fs, sandbox).await?;
                if let Some(dest) = move_path {
                    let dest_uri = cwd.join(&dest.to_string_lossy())?;
                    let overwritten_move_content =
                        read_optional_file_text_for_delta(&dest_uri, fs, sandbox, &mut delta.exact)
                            .await;
                    try_write!(
                        write_file_with_missing_parent_retry(
                            fs,
                            &dest_uri,
                            new_contents.clone().into_bytes(),
                            sandbox,
                        )
                        .await
                    );
                    let dest_write_change_index = delta.changes.len();
                    delta.changes.push(AppliedPatchChange {
                        path: dest_uri.to_path_buf(),
                        change: AppliedPatchFileChange::Add {
                            content: new_contents.clone(),
                            overwritten_content: overwritten_move_content.clone(),
                        },
                    });
                    ensure_not_directory(&path_uri, fs, sandbox)
                        .await
                        .with_context(|| {
                            format!(
                                "Failed to remove original {}",
                                path_uri.inferred_native_path_string()
                            )
                        })?;
                    if let Err(error) = fs
                        .remove(
                            &path_uri,
                            RemoveOptions {
                                recursive: false,
                                force: false,
                            },
                            sandbox,
                        )
                        .await
                        .with_context(|| {
                            format!(
                                "Failed to remove original {}",
                                path_uri.inferred_native_path_string()
                            )
                        })
                    {
                        delta.exact &= remove_failure_was_side_effect_free(
                            &path_uri,
                            Some(&original_contents),
                            fs,
                            sandbox,
                        )
                        .await;
                        return Err(error);
                    }
                    delta.changes[dest_write_change_index] = AppliedPatchChange {
                        path: path_uri.to_path_buf(),
                        change: AppliedPatchFileChange::Update {
                            move_path: Some(dest_uri.to_path_buf()),
                            old_content: original_contents,
                            overwritten_move_content,
                            new_content: new_contents,
                        },
                    };
                    modified.push(affected_path);
                } else {
                    try_write!(
                        fs.write_file(&path_uri, new_contents.clone().into_bytes(), sandbox)
                            .await
                            .with_context(|| format!(
                                "Failed to write file {}",
                                path_uri.inferred_native_path_string()
                            ))
                    );
                    delta.changes.push(AppliedPatchChange {
                        path: path_uri.to_path_buf(),
                        change: AppliedPatchFileChange::Update {
                            move_path: None,
                            old_content: original_contents,
                            overwritten_move_content: None,
                            new_content: new_contents,
                        },
                    });
                    modified.push(affected_path);
                }
            }
        }
    }
    Ok(AffectedPaths {
        added,
        modified,
        deleted,
    })
}

async fn ensure_not_directory(
    path: &PathUri,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> io::Result<()> {
    let metadata = fs.get_metadata(path, sandbox).await?;
    if metadata.is_directory {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is a directory",
        ));
    }
    Ok(())
}

async fn remove_failure_was_side_effect_free(
    path: &PathUri,
    expected_content: Option<&str>,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> bool {
    match expected_content {
        Some(expected_content) => fs
            .read_file_text(path, sandbox)
            .await
            .is_ok_and(|content| content == expected_content),
        None => false,
    }
}

async fn read_optional_file_text_for_delta(
    path: &PathUri,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
    exact: &mut bool,
) -> Option<String> {
    note_existing_path_delta_support(path, fs, sandbox, exact).await;
    match fs.read_file_text(path, sandbox).await {
        Ok(content) => Some(content),
        Err(source) if source.kind() == io::ErrorKind::NotFound => None,
        Err(_) => {
            *exact = false;
            None
        }
    }
}

async fn note_existing_path_delta_support(
    path: &PathUri,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
    exact: &mut bool,
) {
    match fs.get_metadata(path, sandbox).await {
        Ok(metadata) if metadata.is_file && !metadata.is_symlink => {}
        Ok(_) => *exact = false,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
        Err(_) => *exact = false,
    }
}

async fn write_file_with_missing_parent_retry(
    fs: &dyn ExecutorFileSystem,
    path: &PathUri,
    contents: Vec<u8>,
    sandbox: Option<&FileSystemSandboxContext>,
) -> anyhow::Result<()> {
    match fs.write_file(path, contents.clone(), sandbox).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                fs.create_directory(&parent, CreateDirectoryOptions { recursive: true }, sandbox)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to create parent directories for {}",
                            path.inferred_native_path_string()
                        )
                    })?;
            }
            fs.write_file(path, contents, sandbox)
                .await
                .with_context(|| {
                    format!(
                        "Failed to write file {}",
                        path.inferred_native_path_string()
                    )
                })?;
            Ok(())
        }
        Err(err) => Err(err).with_context(|| {
            format!(
                "Failed to write file {}",
                path.inferred_native_path_string()
            )
        }),
    }
}

struct AppliedPatch {
    original_contents: String,
    new_contents: String,
}

/// 仅返回应用 chunks 后 `path` 处文件的新内容（拼成单个 `String`）。
async fn derive_new_contents_from_chunks(
    path: &PathUri,
    chunks: &[UpdateFileChunk],
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> std::result::Result<AppliedPatch, ApplyPatchError> {
    let original_contents = fs.read_file_text(path, sandbox).await.map_err(|err| {
        ApplyPatchError::IoError(IoError {
            context: format!(
                "Failed to read file to update {}",
                path.inferred_native_path_string()
            ),
            source: err,
        })
    })?;

    let mut original_lines: Vec<String> = original_contents.split('\n').map(String::from).collect();

    // Drop the trailing empty element that results from the final newline so
    // that line counts match the behaviour of standard `diff`.
    if original_lines.last().is_some_and(String::is_empty) {
        original_lines.pop();
    }

    let path_text = path.inferred_native_path_string();
    let replacements = compute_replacements(&original_lines, &path_text, chunks)?;
    let new_lines = apply_replacements(original_lines, &replacements);
    let mut new_lines = new_lines;
    if !new_lines.last().is_some_and(String::is_empty) {
        new_lines.push(String::new());
    }
    let new_contents = new_lines.join("\n");
    Ok(AppliedPatch {
        original_contents,
        new_contents,
    })
}

/// 根据 patch `chunks` 计算将 `original_lines` 转换为新内容所需的替换列表。
/// 每个替换以 `(start_index, old_len, new_lines)` 表示。
fn compute_replacements(
    original_lines: &[String],
    path: &str,
    chunks: &[UpdateFileChunk],
) -> std::result::Result<Vec<(usize, usize, Vec<String>)>, ApplyPatchError> {
    let mut replacements: Vec<(usize, usize, Vec<String>)> = Vec::new();
    let mut line_index: usize = 0;

    for chunk in chunks {
        // If a chunk has a `change_context`, we use seek_sequence to find it, then
        // adjust our `line_index` to continue from there.
        if let Some(ctx_line) = &chunk.change_context {
            if let Some(idx) = seek_sequence::seek_sequence(
                original_lines,
                std::slice::from_ref(ctx_line),
                line_index,
                /*eof*/ false,
            ) {
                line_index = idx + 1;
            } else {
                return Err(ApplyPatchError::ComputeReplacements(format!(
                    "Failed to find context '{ctx_line}' in {path}"
                )));
            }
        }

        if chunk.old_lines.is_empty() {
            // Pure addition (no old lines). We'll add them at the end or just
            // before the final empty line if one exists.
            let insertion_idx = if original_lines.last().is_some_and(String::is_empty) {
                original_lines.len() - 1
            } else {
                original_lines.len()
            };
            replacements.push((insertion_idx, 0, chunk.new_lines.clone()));
            continue;
        }

        // 否则，尝试将文件中的现有行与 chunk 中的旧行进行匹配。
        // 如果找到匹配区域，则调度该区域进行替换。
        // 尝试在文件中逐字定位 `old_lines`。在许多真实世界的 diff 中，
        // `old_lines` 的最后一个元素是*空字符串*，表示被替换区域的
        // 终止换行符。该 sentinel 不存在于 `original_lines` 中，因为我们
        // 去掉了 `split('\n')` 末尾产生的空切片。如果直接搜索失败且
        // 模式以空字符串结尾，则去掉该末尾元素后重试，以确保触及
        // 文件末尾的修改能被可靠地定位。

        let mut pattern: &[String] = &chunk.old_lines;
        let mut found =
            seek_sequence::seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);

        let mut new_slice: &[String] = &chunk.new_lines;

        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            // Retry without the trailing empty line which represents the final
            // newline in the file.
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }

            found = seek_sequence::seek_sequence(
                original_lines,
                pattern,
                line_index,
                chunk.is_end_of_file,
            );
        }

        if let Some(start_idx) = found {
            replacements.push((start_idx, pattern.len(), new_slice.to_vec()));
            line_index = start_idx + pattern.len();
        } else {
            return Err(ApplyPatchError::ComputeReplacements(format!(
                "Failed to find expected lines in {}:\n{}",
                path,
                chunk.old_lines.join("\n"),
            )));
        }
    }

    replacements.sort_by_key(|(index, _, _)| *index);

    Ok(replacements)
}

/// 将 `(start_index, old_len, new_lines)` 形式的替换列表应用到 `original_lines`，
/// 返回修改后的文件内容（按行分割的向量）。
fn apply_replacements(
    mut lines: Vec<String>,
    replacements: &[(usize, usize, Vec<String>)],
) -> Vec<String> {
    // We must apply replacements in descending order so that earlier replacements
    // don't shift the positions of later ones.
    for (start_idx, old_len, new_segment) in replacements.iter().rev() {
        let start_idx = *start_idx;
        let old_len = *old_len;

        // Remove old lines.
        for _ in 0..old_len {
            if start_idx < lines.len() {
                lines.remove(start_idx);
            }
        }

        // Insert new lines.
        for (offset, new_line) in new_segment.iter().enumerate() {
            lines.insert(start_idx + offset, new_line.clone());
        }
    }

    lines
}

/// `apply_patch` 中一次文件更新的预期结果。
#[derive(Debug, Eq, PartialEq)]
pub struct ApplyPatchFileUpdate {
    /// 该文件更新对应的 unified diff 文本。
    unified_diff: String,
    /// 更新前的原始内容。
    original_content: String,
    /// 更新后的新内容。
    content: String,
}

/// 基于 chunks 生成 [`ApplyPatchFileUpdate`]（默认 context 行数为 1）。
pub async fn unified_diff_from_chunks(
    path: &PathUri,
    chunks: &[UpdateFileChunk],
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> std::result::Result<ApplyPatchFileUpdate, ApplyPatchError> {
    unified_diff_from_chunks_with_context(path, chunks, /*context*/ 1, fs, sandbox).await
}

/// 与 [`unified_diff_from_chunks`] 相同，但可自定义 unified diff 的上下文行数。
pub async fn unified_diff_from_chunks_with_context(
    path: &PathUri,
    chunks: &[UpdateFileChunk],
    context: usize,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> std::result::Result<ApplyPatchFileUpdate, ApplyPatchError> {
    let AppliedPatch {
        original_contents,
        new_contents,
    } = derive_new_contents_from_chunks(path, chunks, fs, sandbox).await?;
    let text_diff = TextDiff::from_lines(&original_contents, &new_contents);
    let unified_diff = text_diff.unified_diff().context_radius(context).to_string();
    Ok(ApplyPatchFileUpdate {
        unified_diff,
        original_content: original_contents,
        content: new_contents,
    })
}

/// 以 git 风格打印变更摘要：将变更摘要写入给定的 writer。
pub fn print_summary(
    affected: &AffectedPaths,
    out: &mut impl std::io::Write,
) -> std::io::Result<()> {
    writeln!(out, "Success. Updated the following files:")?;
    for path in &affected.added {
        writeln!(out, "A {}", path.display())?;
    }
    for path in &affected.modified {
        writeln!(out, "M {}", path.display())?;
    }
    for path in &affected.deleted {
        writeln!(out, "D {}", path.display())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_exec_server::LOCAL_FS;
    use pretty_assertions::assert_eq;
    use std::fs;
    use std::string::ToString;
    use tempfile::tempdir;

    /// Helper to construct a patch with the given body.
    fn wrap_patch(body: &str) -> String {
        format!("*** Begin Patch\n{body}\n*** End Patch")
    }

    #[tokio::test]
    async fn test_add_file_hunk_creates_file_with_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("add.txt");
        let patch = wrap_patch(&format!(
            r#"*** Add File: {}
+ab
+cd"#,
            path.display()
        ));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        // Verify expected stdout and stderr outputs.
        let stdout_str = String::from_utf8(stdout).unwrap();
        let stderr_str = String::from_utf8(stderr).unwrap();
        let expected_out = format!(
            "Success. Updated the following files:\nA {}\n",
            path.display()
        );
        assert_eq!(stdout_str, expected_out);
        assert_eq!(stderr_str, "");
        let contents = fs::read_to_string(path).unwrap();
        assert_eq!(contents, "ab\ncd\n");
    }

    #[tokio::test]
    async fn test_apply_patch_hunks_accept_relative_and_absolute_paths() {
        let dir = tempdir().unwrap();
        let cwd = PathUri::from_host_native_path(dir.path()).expect("absolute test path");
        let relative_add = dir.path().join("relative-add.txt");
        let absolute_add = dir.path().join("absolute-add.txt");
        let relative_delete = dir.path().join("relative-delete.txt");
        let absolute_delete = dir.path().join("absolute-delete.txt");
        let relative_update = dir.path().join("relative-update.txt");
        let absolute_update = dir.path().join("absolute-update.txt");
        fs::write(&relative_delete, "delete relative\n").unwrap();
        fs::write(&absolute_delete, "delete absolute\n").unwrap();
        fs::write(&relative_update, "relative old\n").unwrap();
        fs::write(&absolute_update, "absolute old\n").unwrap();

        let patch = wrap_patch(&format!(
            r#"*** Add File: relative-add.txt
+relative add
*** Add File: {}
+absolute add
*** Delete File: relative-delete.txt
*** Delete File: {}
*** Update File: relative-update.txt
@@
-relative old
+relative new
*** Update File: {}
@@
-absolute old
+absolute new"#,
            absolute_add.display(),
            absolute_delete.display(),
            absolute_update.display(),
        ));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        apply_patch(
            &patch,
            &cwd,
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();

        assert_eq!(fs::read_to_string(&relative_add).unwrap(), "relative add\n");
        assert_eq!(fs::read_to_string(&absolute_add).unwrap(), "absolute add\n");
        assert!(!relative_delete.exists());
        assert!(!absolute_delete.exists());
        assert_eq!(
            fs::read_to_string(&relative_update).unwrap(),
            "relative new\n"
        );
        assert_eq!(
            fs::read_to_string(&absolute_update).unwrap(),
            "absolute new\n"
        );
        assert_eq!(String::from_utf8(stderr).unwrap(), "");
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            format!(
                "Success. Updated the following files:\nA relative-add.txt\nA {}\nM relative-update.txt\nM {}\nD relative-delete.txt\nD {}\n",
                absolute_add.display(),
                absolute_update.display(),
                absolute_delete.display(),
            )
        );
    }

    #[tokio::test]
    async fn test_delete_file_hunk_removes_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("del.txt");
        fs::write(&path, "x").unwrap();
        let patch = wrap_patch(&format!("*** Delete File: {}", path.display()));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let stdout_str = String::from_utf8(stdout).unwrap();
        let stderr_str = String::from_utf8(stderr).unwrap();
        let expected_out = format!(
            "Success. Updated the following files:\nD {}\n",
            path.display()
        );
        assert_eq!(stdout_str, expected_out);
        assert_eq!(stderr_str, "");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn test_update_file_hunk_modifies_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("update.txt");
        fs::write(&path, "foo\nbar\n").unwrap();
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
 foo
-bar
+baz"#,
            path.display()
        ));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        // Validate modified file contents and expected stdout/stderr.
        let stdout_str = String::from_utf8(stdout).unwrap();
        let stderr_str = String::from_utf8(stderr).unwrap();
        let expected_out = format!(
            "Success. Updated the following files:\nM {}\n",
            path.display()
        );
        assert_eq!(stdout_str, expected_out);
        assert_eq!(stderr_str, "");
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "foo\nbaz\n");
    }

    #[tokio::test]
    async fn test_update_file_hunk_can_move_file() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.txt");
        let dest = dir.path().join("dst.txt");
        fs::write(&src, "line\n").unwrap();
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
*** Move to: {}
@@
-line
+line2"#,
            src.display(),
            dest.display()
        ));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        // Validate move semantics and expected stdout/stderr.
        let stdout_str = String::from_utf8(stdout).unwrap();
        let stderr_str = String::from_utf8(stderr).unwrap();
        let expected_out = format!(
            "Success. Updated the following files:\nM {}\n",
            dest.display()
        );
        assert_eq!(stdout_str, expected_out);
        assert_eq!(stderr_str, "");
        assert!(!src.exists());
        let contents = fs::read_to_string(&dest).unwrap();
        assert_eq!(contents, "line2\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_failed_move_returns_committed_destination_delta() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let source_dir = dir.path().join("locked");
        let dest_dir = dir.path().join("out");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&dest_dir).unwrap();
        let src = source_dir.join("src.txt");
        let dest = dest_dir.join("dst.txt");
        fs::write(&src, "line\n").unwrap();
        fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let patch = wrap_patch(
            "*** Update File: locked/src.txt\n*** Move to: out/dst.txt\n@@\n-line\n+line2",
        );
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let failure = apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .expect_err("source removal should fail after destination write");

        fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            String::from_utf8(stderr)
                .unwrap()
                .contains(&format!("Failed to remove original {}", src.display()))
        );
        assert_eq!(
            failure.delta(),
            &AppliedPatchDelta::new(
                vec![AppliedPatchChange {
                    path: dest.clone(),
                    change: AppliedPatchFileChange::Add {
                        content: "line2\n".to_string(),
                        overwritten_content: None,
                    },
                }],
                /*exact*/ true,
            )
        );
        assert_eq!(fs::read_to_string(src).unwrap(), "line\n");
        assert_eq!(fs::read_to_string(dest).unwrap(), "line2\n");
    }

    /// Verify that a single `Update File` hunk with multiple change chunks can update different
    /// parts of a file and that the file is listed only once in the summary.
    #[tokio::test]
    async fn test_multiple_update_chunks_apply_to_single_file() {
        // 初始文件包含四行内容。
        let dir = tempdir().unwrap();
        let path = dir.path().join("multi.txt");
        fs::write(&path, "foo\nbar\nbaz\nqux\n").unwrap();
        // Construct an update patch with two separate change chunks.
        // 第一个 chunk 以 `foo` 行作为 context，将 `bar` 替换为 `BAR`。
        // 第二个 chunk 以 `baz` 行作为 context，将 `qux` 替换为 `QUX`。
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
 foo
-bar
+BAR
@@
 baz
-qux
+QUX"#,
            path.display()
        ));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let stdout_str = String::from_utf8(stdout).unwrap();
        let stderr_str = String::from_utf8(stderr).unwrap();
        let expected_out = format!(
            "Success. Updated the following files:\nM {}\n",
            path.display()
        );
        assert_eq!(stdout_str, expected_out);
        assert_eq!(stderr_str, "");
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "foo\nBAR\nbaz\nQUX\n");
    }

    /// A more involved `Update File` hunk that exercises additions, deletions and
    /// replacements in separate chunks that appear in non‑adjacent parts of the
    /// file.  Verifies that all edits are applied and that the summary lists the
    /// file only once.
    #[tokio::test]
    async fn test_update_file_hunk_interleaved_changes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("interleaved.txt");

        // Original file: six numbered lines.
        fs::write(&path, "a\nb\nc\nd\ne\nf\n").unwrap();

        // Patch performs:
        //  • Replace `b` → `B`
        //  • Replace `e` → `E` (using surrounding context)
        //  • Append new line `g` at the end‑of‑file
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
 a
-b
+B
@@
 c
 d
-e
+E
@@
 f
+g
*** End of File"#,
            path.display()
        ));

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();

        let stdout_str = String::from_utf8(stdout).unwrap();
        let stderr_str = String::from_utf8(stderr).unwrap();

        let expected_out = format!(
            "Success. Updated the following files:\nM {}\n",
            path.display()
        );
        assert_eq!(stdout_str, expected_out);
        assert_eq!(stderr_str, "");

        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "a\nB\nc\nd\nE\nf\ng\n");
    }

    #[tokio::test]
    async fn test_pure_addition_chunk_followed_by_removal() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("panic.txt");
        fs::write(&path, "line1\nline2\nline3\n").unwrap();
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
+after-context
+second-line
@@
 line1
-line2
-line3
+line2-replacement"#,
            path.display()
        ));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let contents = fs::read_to_string(path).unwrap();
        assert_eq!(
            contents,
            "line1\nline2-replacement\nafter-context\nsecond-line\n"
        );
    }

    /// Ensure that patches authored with ASCII characters can update lines that
    /// contain typographic Unicode punctuation (e.g. EN DASH, NON-BREAKING
    /// HYPHEN). Historically `git apply` succeeds in such scenarios but our
    /// internal matcher failed requiring an exact byte-for-byte match.  The
    /// fuzzy-matching pass that normalises common punctuation should now bridge
    /// the gap.
    #[tokio::test]
    async fn test_update_line_with_unicode_dash() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unicode.py");

        // Original line contains EN DASH (\u{2013}) and NON-BREAKING HYPHEN (\u{2011}).
        let original = "import asyncio  # local import \u{2013} avoids top\u{2011}level dep\n";
        std::fs::write(&path, original).unwrap();

        // Patch uses plain ASCII dash / hyphen.
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
-import asyncio  # local import - avoids top-level dep
+import asyncio  # HELLO"#,
            path.display()
        ));

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();

        // File should now contain the replaced comment.
        let expected = "import asyncio  # HELLO\n";
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents, expected);

        // Ensure success summary lists the file as modified.
        let stdout_str = String::from_utf8(stdout).unwrap();
        let expected_out = format!(
            "Success. Updated the following files:\nM {}\n",
            path.display()
        );
        assert_eq!(stdout_str, expected_out);

        // No stderr expected.
        assert_eq!(String::from_utf8(stderr).unwrap(), "");
    }

    #[tokio::test]
    async fn test_unified_diff() {
        // 初始文件包含四行内容。
        let dir = tempdir().unwrap();
        let path = dir.path().join("multi.txt");
        fs::write(&path, "foo\nbar\nbaz\nqux\n").unwrap();
        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
 foo
-bar
+BAR
@@
 baz
-qux
+QUX"#,
            path.display()
        ));
        let patch = parse_patch(&patch).unwrap();

        let update_file_chunks = match patch.hunks.as_slice() {
            [Hunk::UpdateFile { chunks, .. }] => chunks,
            _ => panic!("Expected a single UpdateFile hunk"),
        };
        let path_uri = PathUri::from_host_native_path(&path).expect("absolute test path");
        let diff = unified_diff_from_chunks(
            &path_uri,
            update_file_chunks,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let expected_diff = r#"@@ -1,4 +1,4 @@
 foo
-bar
+BAR
 baz
-qux
+QUX
"#;
        let expected = ApplyPatchFileUpdate {
            unified_diff: expected_diff.to_string(),
            original_content: "foo\nbar\nbaz\nqux\n".to_string(),
            content: "foo\nBAR\nbaz\nQUX\n".to_string(),
        };
        assert_eq!(expected, diff);
    }

    #[tokio::test]
    async fn test_unified_diff_first_line_replacement() {
        // Replace the very first line of the file.
        let dir = tempdir().unwrap();
        let path = dir.path().join("first.txt");
        fs::write(&path, "foo\nbar\nbaz\n").unwrap();

        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
-foo
+FOO
 bar
"#,
            path.display()
        ));

        let patch = parse_patch(&patch).unwrap();
        let chunks = match patch.hunks.as_slice() {
            [Hunk::UpdateFile { chunks, .. }] => chunks,
            _ => panic!("Expected a single UpdateFile hunk"),
        };

        let resolved_path = PathUri::from_host_native_path(&path).expect("absolute test path");
        let diff = unified_diff_from_chunks(
            &resolved_path,
            chunks,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let expected_diff = r#"@@ -1,2 +1,2 @@
-foo
+FOO
 bar
"#;
        let expected = ApplyPatchFileUpdate {
            unified_diff: expected_diff.to_string(),
            original_content: "foo\nbar\nbaz\n".to_string(),
            content: "FOO\nbar\nbaz\n".to_string(),
        };
        assert_eq!(expected, diff);
    }

    #[tokio::test]
    async fn test_unified_diff_last_line_replacement() {
        // Replace the very last line of the file.
        let dir = tempdir().unwrap();
        let path = dir.path().join("last.txt");
        fs::write(&path, "foo\nbar\nbaz\n").unwrap();

        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
 foo
 bar
-baz
+BAZ
"#,
            path.display()
        ));

        let patch = parse_patch(&patch).unwrap();
        let chunks = match patch.hunks.as_slice() {
            [Hunk::UpdateFile { chunks, .. }] => chunks,
            _ => panic!("Expected a single UpdateFile hunk"),
        };

        let resolved_path = PathUri::from_host_native_path(&path).expect("absolute test path");
        let diff = unified_diff_from_chunks(
            &resolved_path,
            chunks,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let expected_diff = r#"@@ -2,2 +2,2 @@
 bar
-baz
+BAZ
"#;
        let expected = ApplyPatchFileUpdate {
            unified_diff: expected_diff.to_string(),
            original_content: "foo\nbar\nbaz\n".to_string(),
            content: "foo\nbar\nBAZ\n".to_string(),
        };
        assert_eq!(expected, diff);
    }

    #[tokio::test]
    async fn test_unified_diff_insert_at_eof() {
        // Insert a new line at end‑of‑file.
        let dir = tempdir().unwrap();
        let path = dir.path().join("insert.txt");
        fs::write(&path, "foo\nbar\nbaz\n").unwrap();

        let patch = wrap_patch(&format!(
            r#"*** Update File: {}
@@
+quux
*** End of File
"#,
            path.display()
        ));

        let patch = parse_patch(&patch).unwrap();
        let chunks = match patch.hunks.as_slice() {
            [Hunk::UpdateFile { chunks, .. }] => chunks,
            _ => panic!("Expected a single UpdateFile hunk"),
        };

        let path_uri = PathUri::from_host_native_path(&path).expect("absolute test path");
        let diff =
            unified_diff_from_chunks(&path_uri, chunks, LOCAL_FS.as_ref(), /*sandbox*/ None)
                .await
                .unwrap();
        let expected_diff = r#"@@ -3 +3,2 @@
 baz
+quux
"#;
        let expected = ApplyPatchFileUpdate {
            unified_diff: expected_diff.to_string(),
            original_content: "foo\nbar\nbaz\n".to_string(),
            content: "foo\nbar\nbaz\nquux\n".to_string(),
        };
        assert_eq!(expected, diff);
    }

    #[tokio::test]
    async fn test_unified_diff_interleaved_changes() {
        // Original file with six lines.
        let dir = tempdir().unwrap();
        let path = dir.path().join("interleaved.txt");
        fs::write(&path, "a\nb\nc\nd\ne\nf\n").unwrap();

        // Patch replaces two separate lines and appends a new one at EOF using
        // three distinct chunks.
        let patch_body = format!(
            r#"*** Update File: {}
@@
 a
-b
+B
@@
 d
-e
+E
@@
 f
+g
*** End of File"#,
            path.display()
        );
        let patch = wrap_patch(&patch_body);

        // Extract chunks then build the unified diff.
        let parsed = parse_patch(&patch).unwrap();
        let chunks = match parsed.hunks.as_slice() {
            [Hunk::UpdateFile { chunks, .. }] => chunks,
            _ => panic!("Expected a single UpdateFile hunk"),
        };

        let path_uri = PathUri::from_host_native_path(&path).expect("absolute test path");
        let diff =
            unified_diff_from_chunks(&path_uri, chunks, LOCAL_FS.as_ref(), /*sandbox*/ None)
                .await
                .unwrap();

        let expected_diff = r#"@@ -1,6 +1,7 @@
 a
-b
+B
 c
 d
-e
+E
 f
+g
"#;

        let expected = ApplyPatchFileUpdate {
            unified_diff: expected_diff.to_string(),
            original_content: "a\nb\nc\nd\ne\nf\n".to_string(),
            content: "a\nB\nc\nd\nE\nf\ng\n".to_string(),
        };

        assert_eq!(expected, diff);

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();
        let contents = fs::read_to_string(path).unwrap();
        assert_eq!(
            contents,
            r#"a
B
c
d
E
f
g
"#
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_apply_patch_fails_on_write_error() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let locked_dir = dir.path().join("locked");
        fs::create_dir(&locked_dir).unwrap();
        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let patch = wrap_patch("*** Add File: locked/new.txt\n+after");

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let result = apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await;
        let failure = result.expect_err("write should fail");

        fs::set_permissions(&locked_dir, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(!failure.delta().is_exact());
    }

    #[tokio::test]
    async fn test_unreadable_destinations_return_inexact_delta() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("binary.dat");
        fs::write(dir.path().join("source.txt"), "before\n").unwrap();
        let cwd = PathUri::from_host_native_path(dir.path()).expect("absolute test path");

        for patch in [
            wrap_patch("*** Add File: binary.dat\n+text"),
            wrap_patch("*** Update File: source.txt\n*** Move to: binary.dat\n@@\n-before\n+after"),
        ] {
            fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let delta = apply_patch(
                &patch,
                &cwd,
                &mut stdout,
                &mut stderr,
                LOCAL_FS.as_ref(),
                /*sandbox*/ None,
            )
            .await
            .unwrap();

            assert!(!delta.is_exact());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_delete_symlink_returns_inexact_delta() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        fs::write(dir.path().join("target.txt"), "target\n").unwrap();
        symlink(dir.path().join("target.txt"), dir.path().join("link.txt")).unwrap();
        let patch = wrap_patch("*** Delete File: link.txt");

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let delta = apply_patch(
            &patch,
            &PathUri::from_host_native_path(dir.path()).expect("absolute test path"),
            &mut stdout,
            &mut stderr,
            LOCAL_FS.as_ref(),
            /*sandbox*/ None,
        )
        .await
        .unwrap();

        assert!(!delta.is_exact());
    }
}

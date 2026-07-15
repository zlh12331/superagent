//! Git 工具相关错误类型定义。
//!
//! 通过 [`thiserror::Error`] 派生 [`GitToolingError`]，统一封装在执行 git 命令、
//! 解析路径、遍历目录树等过程中可能出现的错误，便于上层进行模式匹配与错误传播。

use std::path::PathBuf;
use std::process::ExitStatus;
use std::string::FromUtf8Error;

use thiserror::Error;
use walkdir::Error as WalkdirError;

/// 管理 git 工作树快照时返回的错误类型。
#[derive(Debug, Error)]
pub enum GitToolingError {
    /// git 命令执行失败（非零退出码）。
    /// - `command`：可读命令字符串
    /// - `status`：进程退出状态
    /// - `stderr`：标准错误输出
    #[error("git command `{command}` failed with status {status}: {stderr}")]
    GitCommand {
        command: String,
        status: ExitStatus,
        stderr: String,
    },
    /// git 命令输出非 UTF-8 文本。
    #[error("git command `{command}` produced non-UTF-8 output")]
    GitOutputUtf8 {
        command: String,
        #[source]
        source: FromUtf8Error,
    },
    /// 给定路径不在 git 仓库内。
    #[error("{path:?} is not a git repository")]
    NotAGitRepository { path: PathBuf },
    /// 路径必须相对仓库根，不能为绝对路径。
    #[error("path {path:?} must be relative to the repository root")]
    NonRelativePath { path: PathBuf },
    /// 路径试图逃逸出仓库根（包含 `..` 等）。
    #[error("path {path:?} escapes the repository root")]
    PathEscapesRepository { path: PathBuf },
    /// 在工作树内处理路径失败（如 strip prefix 失败）。
    #[error("failed to process path inside worktree")]
    PathPrefix(#[from] std::path::StripPrefixError),
    /// 目录遍历错误。
    #[error(transparent)]
    Walkdir(#[from] WalkdirError),
    /// 通用 IO 错误。
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

//! 会话初始化错误映射。
//!
//! 本模块将 session 初始化过程中的 `anyhow::Error` 映射为更具可读性的 `CodexErr`，
//! 针对 IO 错误（权限不足、路径不存在、数据损坏等）提供针对性的修复提示。

use std::io::ErrorKind;
use std::path::Path;

use crate::rollout::SESSIONS_SUBDIR;
use codex_protocol::error::CodexErr;
use codex_thread_store::ThreadStoreError;

/// 将 session 初始化错误映射为 `CodexErr`。
///
/// 优先识别 `ThreadStoreError::Unsupported`，其次映射常见 IO 错误，
/// 最后回退为 `CodexErr::Fatal`。
pub(crate) fn map_session_init_error(err: &anyhow::Error, codex_home: &Path) -> CodexErr {
    if let Some(ThreadStoreError::Unsupported { operation }) = err
        .chain()
        .find_map(|cause| cause.downcast_ref::<ThreadStoreError>())
    {
        return CodexErr::UnsupportedOperation(format!("{operation} is not supported yet"));
    }

    if let Some(mapped) = err
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .find_map(|io_err| map_rollout_io_error(io_err, codex_home))
    {
        return mapped;
    }

    CodexErr::Fatal(format!("Failed to initialize session: {err:#}"))
}

/// 将 IO 错误映射为带有修复提示的 `CodexErr`。
///
/// 针对权限拒绝、路径缺失、数据损坏等场景生成用户可操作的提示文本。
fn map_rollout_io_error(io_err: &std::io::Error, codex_home: &Path) -> Option<CodexErr> {
    let sessions_dir = codex_home.join(SESSIONS_SUBDIR);
    let hint = match io_err.kind() {
        ErrorKind::PermissionDenied => format!(
            "Codex cannot access session files at {} (permission denied). If sessions were created using sudo, fix ownership: sudo chown -R $(whoami) {}",
            sessions_dir.display(),
            codex_home.display()
        ),
        ErrorKind::NotFound => format!(
            "Session storage missing at {}. Create the directory or choose a different Codex home.",
            sessions_dir.display()
        ),
        ErrorKind::AlreadyExists => format!(
            "Session storage path {} is blocked by an existing file. Remove or rename it so Codex can create sessions.",
            sessions_dir.display()
        ),
        ErrorKind::InvalidData | ErrorKind::InvalidInput => format!(
            "Session data under {} looks corrupt or unreadable. Clearing the sessions directory may help (this will remove saved threads).",
            sessions_dir.display()
        ),
        ErrorKind::IsADirectory | ErrorKind::NotADirectory => format!(
            "Session storage path {} has an unexpected type. Ensure it is a directory Codex can use for session files.",
            sessions_dir.display()
        ),
        _ => return None,
    };

    Some(CodexErr::Fatal(format!(
        "{hint} (underlying error: {io_err})"
    )))
}

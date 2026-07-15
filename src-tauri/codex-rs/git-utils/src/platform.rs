//! 跨平台符号链接创建模块。
//!
//! 在 Unix 与 Windows 上提供统一的 [`create_symlink`] 入口，根据源路径类型
//! 选择正确的平台 API（文件链接或目录链接）。

use std::path::Path;

use crate::GitToolingError;

/// 创建符号链接 `destination` 指向 `link_target`。
///
/// # 参数
/// - `source`：仅在 Windows 上用于判定链接类型（文件/目录）
/// - `link_target`：符号链接指向的目标路径
/// - `destination`：新创建的符号链接路径
///
/// # 平台差异
/// - Unix：直接调用 `symlink`，不区分文件/目录
/// - Windows：根据 `source` 的元信息选择 `symlink_dir` 或 `symlink_file`
#[cfg(unix)]
pub fn create_symlink(
    _source: &Path,
    link_target: &Path,
    destination: &Path,
) -> Result<(), GitToolingError> {
    use std::os::unix::fs::symlink;

    symlink(link_target, destination)?;
    Ok(())
}

/// 创建符号链接（Windows 实现）：根据 `source` 类型选择目录链接或文件链接。
#[cfg(windows)]
pub fn create_symlink(
    source: &Path,
    link_target: &Path,
    destination: &Path,
) -> Result<(), GitToolingError> {
    use std::os::windows::fs::FileTypeExt;
    use std::os::windows::fs::symlink_dir;
    use std::os::windows::fs::symlink_file;

    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink_dir() {
        symlink_dir(link_target, destination)?;
    } else {
        symlink_file(link_target, destination)?;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
compile_error!("codex-git symlink support is only implemented for Unix and Windows");

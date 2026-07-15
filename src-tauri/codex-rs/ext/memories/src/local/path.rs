//! 路径安全工具模块。
//!
//! 该模块提供 memories 本地后端使用的路径操作辅助函数，
//! 包括目录读取、符号链接拒绝、隐藏文件检测和相对路径显示。

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::backend::MemoriesBackendError;

/// 读取目录下所有条目的路径，按名称排序后返回。
///
/// 目录不存在时返回空列表。
pub(super) async fn read_sorted_dir_paths(
    dir_path: &Path,
) -> Result<Vec<PathBuf>, MemoriesBackendError> {
    let mut dir = match tokio::fs::read_dir(dir_path).await {
        Ok(dir) => dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut paths = Vec::new();
    while let Some(entry) = dir.next_entry().await? {
        paths.push(entry.path());
    }
    paths.sort();
    Ok(paths)
}

/// 拒绝符号链接，若 `metadata` 指向符号链接则返回错误。
pub(super) fn reject_symlink(
    path: &str,
    metadata: &std::fs::Metadata,
) -> Result<(), MemoriesBackendError> {
    if metadata.file_type().is_symlink() {
        return Err(MemoriesBackendError::invalid_path(
            path,
            "must not be a symlink",
        ));
    }
    Ok(())
}

/// 判断路径组件是否为隐藏文件（以 `.` 开头）。
pub(super) fn is_hidden_component(component: Component<'_>) -> bool {
    matches!(
        component,
        Component::Normal(name) if name.to_string_lossy().starts_with('.')
    )
}

/// 判断路径的文件名是否以 `.` 开头（隐藏文件）。
pub(super) fn is_hidden_path(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
}

/// 返回相对于 `root` 的显示路径，用 `/` 分隔。
///
/// 若 `path` 不以 `root` 为前缀，则直接返回 `path` 的显示形式。
pub(super) fn display_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

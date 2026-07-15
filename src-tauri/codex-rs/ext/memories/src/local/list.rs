//! 目录列表模块。
//!
//! 该模块实现 memories 的 list 操作，列出指定路径下的文件和目录。

use crate::MAX_LIST_RESULTS;
use crate::backend::ListMemoriesRequest;
use crate::backend::ListMemoriesResponse;
use crate::backend::MemoriesBackendError;
use crate::backend::MemoryEntry;
use crate::backend::MemoryEntryType;

use super::LocalMemoriesBackend;
use super::path::display_relative_path;
use super::path::is_hidden_path;
use super::path::read_sorted_dir_paths;
use super::path::reject_symlink;

/// 列出指定路径下的文件和目录。
///
/// # 流程
/// 1. 解析并校验路径
/// 2. 解析分页游标
/// 3. 收集条目（文件或目录下的子项）
/// 4. 按游标和 max_results 分页返回
///
/// # 参数
/// - `backend`：本地 memories 后端
/// - `request`：list 请求
pub(super) async fn list(
    backend: &LocalMemoriesBackend,
    request: ListMemoriesRequest,
) -> Result<ListMemoriesResponse, MemoriesBackendError> {
    let max_results = request.max_results.min(MAX_LIST_RESULTS);
    let start = backend.resolve_scoped_path(request.path.as_deref()).await?;
    // 解析分页游标（非负整数）
    let start_index = match request.cursor.as_deref() {
        Some(cursor) => cursor.parse::<usize>().map_err(|_| {
            MemoriesBackendError::invalid_cursor(cursor, "must be a non-negative integer")
        })?,
        None => 0,
    };
    let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&start).await? else {
        return Err(MemoriesBackendError::NotFound {
            path: request.path.unwrap_or_default(),
        });
    };
    reject_symlink(&display_relative_path(&backend.root, &start), &metadata)?;

    let mut entries = if metadata.is_file() {
        // 单文件路径：直接返回该文件条目
        vec![MemoryEntry {
            path: display_relative_path(&backend.root, &start),
            entry_type: MemoryEntryType::File,
        }]
    } else if metadata.is_dir() {
        // 目录路径：列出直接子项
        let mut entries = Vec::new();
        for path in read_sorted_dir_paths(&start).await? {
            // 跳过隐藏文件
            if is_hidden_path(&path) {
                continue;
            }
            let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&path).await? else {
                continue;
            };
            // 跳过符号链接
            if metadata.file_type().is_symlink() {
                continue;
            }

            let entry_type = if metadata.is_dir() {
                MemoryEntryType::Directory
            } else if metadata.is_file() {
                MemoryEntryType::File
            } else {
                continue;
            };
            entries.push(MemoryEntry {
                path: display_relative_path(&backend.root, &path),
                entry_type,
            });
        }
        entries
    } else {
        Vec::new()
    };
    if start_index > entries.len() {
        return Err(MemoriesBackendError::invalid_cursor(
            start_index.to_string(),
            "exceeds result count",
        ));
    }

    // 分页截取
    let end_index = start_index.saturating_add(max_results).min(entries.len());
    let next_cursor = (end_index < entries.len()).then(|| end_index.to_string());
    let truncated = next_cursor.is_some();
    Ok(ListMemoriesResponse {
        path: request.path,
        entries: entries.drain(start_index..end_index).collect(),
        next_cursor,
        truncated,
    })
}

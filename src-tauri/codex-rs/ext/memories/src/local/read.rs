//! 文件读取模块。
//!
//! 该模块实现 memories 的 read 操作，按路径读取 memory 文件内容，
//! 支持行偏移、行数限制和 token 截断。

use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::truncate_text;

use crate::DEFAULT_READ_MAX_TOKENS;
use crate::backend::MemoriesBackendError;
use crate::backend::ReadMemoryRequest;
use crate::backend::ReadMemoryResponse;

use super::LocalMemoriesBackend;
use super::path::reject_symlink;

/// 读取 memory 文件内容。
///
/// # 流程
/// 1. 校验 line_offset 和 max_lines
/// 2. 解析路径并校验为文件
/// 3. 读取文件内容
/// 4. 按行偏移和行数截取
/// 5. 按 token 上限截断
///
/// # 参数
/// - `backend`：本地 memories 后端
/// - `request`：read 请求
pub(super) async fn read(
    backend: &LocalMemoriesBackend,
    request: ReadMemoryRequest,
) -> Result<ReadMemoryResponse, MemoriesBackendError> {
    // 校验行偏移（必须为 1-indexed）
    if request.line_offset == 0 {
        return Err(MemoriesBackendError::InvalidLineOffset);
    }
    // 校验最大行数
    if request.max_lines == Some(0) {
        return Err(MemoriesBackendError::InvalidMaxLines);
    }

    let path = backend
        .resolve_scoped_path(Some(request.path.as_str()))
        .await?;
    let Some(metadata) = LocalMemoriesBackend::metadata_or_none(&path).await? else {
        return Err(MemoriesBackendError::NotFound { path: request.path });
    };
    reject_symlink(&request.path, &metadata)?;
    if !metadata.is_file() {
        return Err(MemoriesBackendError::NotFile { path: request.path });
    }

    let original_content = tokio::fs::read_to_string(&path).await?;
    let start_byte = line_start_byte_offset(&original_content, request.line_offset)?;
    let end_byte = line_end_byte_offset(&original_content, start_byte, request.max_lines);
    let content_from_offset = &original_content[start_byte..end_byte];
    let max_tokens = if request.max_tokens == 0 {
        DEFAULT_READ_MAX_TOKENS
    } else {
        request.max_tokens
    };
    let content = truncate_text(content_from_offset, TruncationPolicy::Tokens(max_tokens));
    let truncated = end_byte < original_content.len() || content != content_from_offset;
    Ok(ReadMemoryResponse {
        path: request.path,
        start_line_number: request.line_offset,
        content,
        truncated,
    })
}

/// 计算指定行号在内容中的起始字节偏移。
///
/// # 参数
/// - `content`：文件内容
/// - `line_offset`：目标行号（1-indexed）
///
/// # 返回
/// 成功时返回字节偏移；若行号超出文件长度则返回错误。
fn line_start_byte_offset(
    content: &str,
    line_offset: usize,
) -> Result<usize, MemoriesBackendError> {
    if line_offset == 1 {
        return Ok(0);
    }

    let mut current_line = 1;
    for (idx, ch) in content.char_indices() {
        if ch == '\n' {
            current_line += 1;
            if current_line == line_offset {
                return Ok(idx + 1);
            }
        }
    }

    Err(MemoriesBackendError::LineOffsetExceedsFileLength)
}

/// 计算从 `start_byte` 开始、最多 `max_lines` 行的结束字节偏移。
///
/// # 参数
/// - `content`：文件内容
/// - `start_byte`：起始字节偏移
/// - `max_lines`：最大行数（`None` 表示到文件末尾）
fn line_end_byte_offset(content: &str, start_byte: usize, max_lines: Option<usize>) -> usize {
    let Some(max_lines) = max_lines else {
        return content.len();
    };

    let mut lines_seen = 1;
    for (relative_idx, ch) in content[start_byte..].char_indices() {
        if ch == '\n' {
            if lines_seen == max_lines {
                return start_byte + relative_idx + 1;
            }
            lines_seen += 1;
        }
    }

    content.len()
}

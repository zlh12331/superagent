//! 临时记忆笔记创建模块。
//!
//! 该模块实现 ad-hoc note 的文件创建逻辑，包括文件名校验、
//! 目录确保和内容写入。笔记文件存储在
//! `<memories_root>/extensions/ad_hoc/notes/` 目录下。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use crate::backend::AddAdHocMemoryNoteRequest;
use crate::backend::AddAdHocMemoryNoteResponse;
use crate::backend::MemoriesBackendError;

use super::LocalMemoriesBackend;
use super::path::reject_symlink;

/// 临时笔记目录相对路径组件。
const AD_HOC_NOTES_DIR: &[&str] = &["extensions", "ad_hoc", "notes"];
/// 笔记文件名最大字节数。
const AD_HOC_NOTE_FILENAME_MAX_BYTES: usize = 128;
/// 笔记 slug 部分最大字节数。
const AD_HOC_NOTE_SLUG_MAX_BYTES: usize = 80;
/// 时间戳前缀长度（`YYYY-MM-DDTHH-MM-SS-`）。
const TIMESTAMP_PREFIX_LEN: usize = "YYYY-MM-DDTHH-MM-SS-".len();

/// 创建一条临时记忆笔记。
///
/// # 流程
/// 1. 校验文件名格式（`YYYY-MM-DDTHH-MM-SS-<slug>.md`）
/// 2. 校验笔记内容非空
/// 3. 确保 notes 目录存在
/// 4. 以 `create_new` 模式写入文件（拒绝覆盖）
///
/// # 参数
/// - `backend`：本地 memories 后端
/// - `request`：创建请求（含文件名和内容）
pub(super) async fn add_ad_hoc_note(
    backend: &LocalMemoriesBackend,
    request: AddAdHocMemoryNoteRequest,
) -> Result<AddAdHocMemoryNoteResponse, MemoriesBackendError> {
    validate_filename(&request.filename)?;
    if request.note.trim().is_empty() {
        return Err(MemoriesBackendError::EmptyAdHocNote);
    }

    let notes_dir = ensure_notes_dir(backend).await?;
    let path = notes_dir.join(&request.filename);
    // 以 create_new 模式打开，拒绝覆盖已有文件
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(MemoriesBackendError::AdHocNoteAlreadyExists {
                filename: request.filename,
            });
        }
        Err(err) => return Err(err.into()),
    };
    file.write_all(request.note.as_bytes())?;

    Ok(AddAdHocMemoryNoteResponse {})
}

/// 确保 notes 目录存在，返回目录路径。
///
/// 逐级创建 `extensions/` → `ad_hoc/` → `notes/` 目录，
/// 每一级都检查符号链接和目录类型。
async fn ensure_notes_dir(
    backend: &LocalMemoriesBackend,
) -> Result<std::path::PathBuf, MemoriesBackendError> {
    ensure_directory(&backend.root).await?;
    let mut path = backend.root.clone();
    for component in AD_HOC_NOTES_DIR {
        path.push(component);
        ensure_directory(&path).await?;
    }
    Ok(path)
}

/// 确保指定路径是目录，若不存在则创建。
///
/// 若路径已存在但不是目录或为符号链接，则返回错误。
async fn ensure_directory(path: &Path) -> Result<(), MemoriesBackendError> {
    match LocalMemoriesBackend::metadata_or_none(path).await? {
        Some(metadata) => {
            reject_symlink(&path.display().to_string(), &metadata)?;
            if metadata.is_dir() {
                return Ok(());
            }
            return Err(MemoriesBackendError::invalid_path(
                path.display().to_string(),
                "must be a directory",
            ));
        }
        None => tokio::fs::create_dir(path).await?,
    };

    // 创建后再次验证（防止 TOCTOU）
    let Some(metadata) = LocalMemoriesBackend::metadata_or_none(path).await? else {
        return Err(MemoriesBackendError::NotFound {
            path: path.display().to_string(),
        });
    };
    reject_symlink(&path.display().to_string(), &metadata)?;
    if !metadata.is_dir() {
        return Err(MemoriesBackendError::invalid_path(
            path.display().to_string(),
            "must be a directory",
        ));
    }
    Ok(())
}

/// 校验笔记文件名格式。
///
/// 文件名必须满足：
/// - 总长度 ≤ 128 字节
/// - 以 `.md` 结尾
/// - 时间戳前缀格式为 `YYYY-MM-DDTHH-MM-SS-`
/// - slug 部分长度 1~80 字节
/// - slug 仅包含小写字母、数字和连字符
fn validate_filename(filename: &str) -> Result<(), MemoriesBackendError> {
    if filename.len() > AD_HOC_NOTE_FILENAME_MAX_BYTES {
        return Err(MemoriesBackendError::invalid_filename(
            filename,
            "must be at most 128 bytes",
        ));
    }
    let Some(stem) = filename.strip_suffix(".md") else {
        return Err(MemoriesBackendError::invalid_filename(
            filename,
            "must end with .md",
        ));
    };
    let Some(slug) = stem.get(TIMESTAMP_PREFIX_LEN..) else {
        return Err(MemoriesBackendError::invalid_filename(
            filename,
            "must use YYYY-MM-DDTHH-MM-SS-<slug>.md",
        ));
    };
    if !has_valid_timestamp_prefix(stem) {
        return Err(MemoriesBackendError::invalid_filename(
            filename,
            "must use YYYY-MM-DDTHH-MM-SS-<slug>.md",
        ));
    }
    if slug.is_empty() || slug.len() > AD_HOC_NOTE_SLUG_MAX_BYTES {
        return Err(MemoriesBackendError::invalid_filename(
            filename,
            "slug must be 1 to 80 bytes",
        ));
    }
    if !slug
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(MemoriesBackendError::invalid_filename(
            filename,
            "slug must contain only lowercase ASCII letters, digits, or hyphens",
        ));
    }

    Ok(())
}

/// 校验时间戳前缀格式是否为 `YYYY-MM-DDTHH-MM-SS-`。
///
/// 检查分隔符位置和各字段是否为数字。
fn has_valid_timestamp_prefix(stem: &str) -> bool {
    let bytes = stem.as_bytes();
    bytes.len() > TIMESTAMP_PREFIX_LEN
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b'-'
        && bytes[16] == b'-'
        && bytes[19] == b'-'
        && are_digits(&bytes[0..4])
        && are_digits(&bytes[5..7])
        && are_digits(&bytes[8..10])
        && are_digits(&bytes[11..13])
        && are_digits(&bytes[14..16])
        && are_digits(&bytes[17..19])
}

/// 判断字节切片是否全部为 ASCII 数字。
fn are_digits(bytes: &[u8]) -> bool {
    bytes.iter().all(u8::is_ascii_digit)
}

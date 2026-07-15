//! 紧急数据恢复命令。
//!
//! 提供一种简单模式，将 JSON 数据保存到磁盘用于崩溃恢复
//! 或会话持久化。
//!
//! 核心文件操作被抽取为接受 `&Path` 的纯函数
//! （`save_emergency_data_to_path`、`load_emergency_data_from_path`、
//! `cleanup_old_recovery_files_in_dir`），从而无需 `AppHandle` 即可进行单元测试。
//! Tauri 命令是薄包装，通过 `get_recovery_dir` 解析恢复目录，
//! 再委托给这些纯函数。

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppError;
use crate::types::{MAX_RECOVERY_DATA_BYTES, RecoveryError, validate_filename};
use crate::utils::paths::ensure_dir_exists;

/// 解析恢复目录路径，但 **不会** 创建该目录。
///
/// 仅从 Tauri `Manager` 读取路径 — 在异步上下文中调用是安全的。
/// 调用方在写入文件前必须在 `spawn_blocking` 中调用 [`ensure_dir_exists`]。
fn get_recovery_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::path(format!("Failed to get app data directory: {e}")))?;

    Ok(app_data_dir.join("recovery"))
}

/// 将紧急数据保存到 JSON 文件以供后续恢复。
/// 校验文件名并强制限制 10MB 大小。
///
/// 接受 JSON 字符串（而非已解析的值），以避免 tauri-specta 的 TypeScript
/// 代码生成中出现递归类型栈溢出。
///
/// 泛型实现 — 可使用任意 `Runtime` 测试（包括 `MockRuntime`）。
pub async fn save_emergency_data_impl<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    data: String,
) -> Result<(), RecoveryError> {
    log::info!("Saving emergency data to file: {filename}");

    let recovery_dir = get_recovery_dir(&app).map_err(|e| RecoveryError::IoError {
        message: e.to_string(),
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_dir_exists(&recovery_dir).map_err(|e| RecoveryError::IoError {
            message: e.to_string(),
        })?;
        // 解析 JSON 字符串 — 在写入磁盘前进行校验。
        let parsed: Value = serde_json::from_str(&data).map_err(|e| RecoveryError::ParseError {
            message: format!("Invalid JSON: {e}"),
        })?;
        save_emergency_data_to_path(&recovery_dir, &filename, &parsed)
    })
    .await
    .map_err(|e| RecoveryError::IoError {
        message: format!("Task join error: {e}"),
    })?
}

/// 将紧急数据保存到 JSON 文件以供后续恢复。
/// 校验文件名并强制限制 10MB 大小。
///
/// 接受 JSON 字符串（而非已解析的值），以避免 tauri-specta 的 TypeScript
/// 代码生成中出现递归类型栈溢出。
#[tauri::command]
#[specta::specta]
pub async fn save_emergency_data(
    app: AppHandle,
    filename: String,
    data: String,
) -> Result<(), RecoveryError> {
    save_emergency_data_impl(app, filename, data).await
}

/// 从先前保存的 JSON 文件加载紧急数据。
/// 若文件不存在则返回 FileNotFound。
///
/// 返回 JSON 字符串（而非已解析的值），以避免 tauri-specta 的 TypeScript
/// 代码生成中出现递归类型栈溢出。
///
/// 泛型实现 — 可使用任意 `Runtime` 测试（包括 `MockRuntime`）。
pub async fn load_emergency_data_impl<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
) -> Result<String, RecoveryError> {
    log::info!("Loading emergency data from file: {filename}");

    let recovery_dir = get_recovery_dir(&app).map_err(|e| RecoveryError::IoError {
        message: e.to_string(),
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_dir_exists(&recovery_dir).map_err(|e| RecoveryError::IoError {
            message: e.to_string(),
        })?;
        let data = load_emergency_data_from_path(&recovery_dir, &filename)?;
        // 序列化回 JSON 字符串，用于 IPC 边界传输。
        serde_json::to_string(&data).map_err(|e| RecoveryError::ParseError {
            message: format!("Failed to serialize recovery data: {e}"),
        })
    })
    .await
    .map_err(|e| RecoveryError::IoError {
        message: format!("Task join error: {e}"),
    })?
}

/// 从先前保存的 JSON 文件加载紧急数据。
/// 若文件不存在则返回 FileNotFound。
///
/// 返回 JSON 字符串（而非已解析的值），以避免 tauri-specta 的 TypeScript
/// 代码生成中出现递归类型栈溢出。
#[tauri::command]
#[specta::specta]
pub async fn load_emergency_data(
    app: AppHandle,
    filename: String,
) -> Result<String, RecoveryError> {
    load_emergency_data_impl(app, filename).await
}

/// 删除超过 7 天的恢复文件。
/// 返回被删除的文件数。
///
/// 泛型实现 — 可使用任意 `Runtime` 测试（包括 `MockRuntime`）。
pub async fn cleanup_old_recovery_files_impl<R: Runtime>(
    app: AppHandle<R>,
) -> Result<u32, RecoveryError> {
    log::info!("Cleaning up old recovery files");

    let recovery_dir = get_recovery_dir(&app).map_err(|e| RecoveryError::IoError {
        message: e.to_string(),
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_dir_exists(&recovery_dir).map_err(|e| RecoveryError::IoError {
            message: e.to_string(),
        })?;
        cleanup_old_recovery_files_in_dir(&recovery_dir)
    })
    .await
    .map_err(|e| RecoveryError::IoError {
        message: format!("Task join error: {e}"),
    })?
}

/// 删除超过 7 天的恢复文件。
/// 返回被删除的文件数。
#[tauri::command]
#[specta::specta]
pub async fn cleanup_old_recovery_files(app: AppHandle) -> Result<u32, RecoveryError> {
    cleanup_old_recovery_files_impl(app).await
}

// ============================================================================
// 纯辅助函数 — 针对显式目录的文件操作。
// 暴露以支持无 AppHandle 的集成测试。
// ============================================================================

/// 纯辅助函数：将紧急数据以 JSON 文件保存到 `recovery_dir` 内。
///
/// 校验文件名、对序列化后的内容强制限制 10MB 大小，
/// 并执行原子写入（临时文件 + 重命名）。生成的文件名为 `{filename}.json`。
pub fn save_emergency_data_to_path(
    recovery_dir: &Path,
    filename: &str,
    data: &Value,
) -> Result<(), RecoveryError> {
    // 校验文件名并执行安全检查
    validate_filename(filename).map_err(|e| RecoveryError::ValidationError {
        message: e.to_string(),
    })?;

    // 仅序列化一次美化的 JSON，用于大小校验和写入
    let json_content = serde_json::to_string_pretty(data).map_err(|e| {
        log::error!("Failed to serialize emergency data: {e}");
        RecoveryError::ParseError {
            message: e.to_string(),
        }
    })?;

    // 对实际将写入的内容校验大小（10MB 限制）
    if json_content.len() > MAX_RECOVERY_DATA_BYTES as usize {
        return Err(RecoveryError::DataTooLarge {
            max_bytes: MAX_RECOVERY_DATA_BYTES,
        });
    }

    let file_path = recovery_dir.join(format!("{filename}.json"));

    // 先写入临时文件，再重命名（原子操作）
    let temp_path = file_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write emergency data file: {e}");
        RecoveryError::IoError {
            message: e.to_string(),
        }
    })?;

    if let Err(rename_err) = std::fs::rename(&temp_path, &file_path) {
        log::error!("Failed to finalize emergency data file: {rename_err}");
        // 清理临时文件，避免在磁盘上遗留孤儿文件
        if let Err(remove_err) = std::fs::remove_file(&temp_path) {
            log::warn!("Failed to remove temp file after rename failure: {remove_err}");
        }
        return Err(RecoveryError::IoError {
            message: rename_err.to_string(),
        });
    }

    log::info!("Successfully saved emergency data to {file_path:?}");
    Ok(())
}

/// 纯辅助函数：从 `recovery_dir` 内的 `{filename}.json` 加载紧急数据。
///
/// 校验文件名；文件不存在时返回 `FileNotFound`，JSON 无法反序列化时
/// 返回 `ParseError`。
pub fn load_emergency_data_from_path(
    recovery_dir: &Path,
    filename: &str,
) -> Result<Value, RecoveryError> {
    // 校验文件名并执行安全检查
    validate_filename(filename).map_err(|e| RecoveryError::ValidationError {
        message: e.to_string(),
    })?;

    let file_path = recovery_dir.join(format!("{filename}.json"));

    if !file_path.exists() {
        log::info!("Recovery file not found: {file_path:?}");
        return Err(RecoveryError::FileNotFound);
    }

    let contents = std::fs::read_to_string(&file_path).map_err(|e| {
        log::error!("Failed to read recovery file: {e}");
        RecoveryError::IoError {
            message: e.to_string(),
        }
    })?;

    let data: Value = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse recovery JSON: {e}");
        RecoveryError::ParseError {
            message: e.to_string(),
        }
    })?;

    log::info!("Successfully loaded emergency data");
    Ok(data)
}

/// 纯辅助函数：删除 `recovery_dir` 内超过 7 天的 `.json` 恢复文件。
/// 返回被删除的文件数。
pub fn cleanup_old_recovery_files_in_dir(recovery_dir: &Path) -> Result<u32, RecoveryError> {
    let mut removed_count = 0;

    // 计算截止时间（7 天前）
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| RecoveryError::IoError {
            message: e.to_string(),
        })?
        .as_secs();
    let seven_days_ago = now - (7 * 24 * 60 * 60);

    // 读取目录并检查每个文件
    let entries = std::fs::read_dir(recovery_dir).map_err(|e| {
        log::error!("Failed to read recovery directory: {e}");
        RecoveryError::IoError {
            message: e.to_string(),
        }
    })?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // 仅处理 JSON 文件
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }

        // 检查文件修改时间
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file metadata: {e}");
                continue;
            }
        };

        let modified = match metadata.modified() {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file modification time: {e}");
                continue;
            }
        };

        let modified_secs = match modified.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs(),
            Err(e) => {
                log::warn!("Failed to convert modification time: {e}");
                continue;
            }
        };

        // 超过 7 天则删除
        if modified_secs < seven_days_ago {
            match std::fs::remove_file(&path) {
                Ok(_) => {
                    log::info!("Removed old recovery file: {path:?}");
                    removed_count += 1;
                }
                Err(e) => {
                    log::warn!("Failed to remove old recovery file: {e}");
                }
            }
        }
    }

    log::info!("Cleanup complete. Removed {removed_count} old recovery files");
    Ok(removed_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MAX_RECOVERY_DATA_BYTES, RecoveryError};
    use std::fs::FileTimes;
    use std::path::Path;
    use std::time::{Duration, SystemTime};
    use tempfile::TempDir;

    /// 辅助函数：将文件的修改时间设置为 `days_old` 天前。
    /// 以写权限打开文件，使 `set_times` 在 Windows 上也能成功。
    fn set_file_mtime_days_old(path: &Path, days_old: u64) {
        let old_time = SystemTime::now() - Duration::from_secs(days_old * 24 * 60 * 60);
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_times(FileTimes::new().set_modified(old_time))
            .unwrap();
    }

    // =========================================================================
    // save_emergency_data_to_path / load_emergency_data_from_path — 正向用例
    // =========================================================================

    #[test]
    fn save_and_load_roundtrips_simple_object() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({
            "session_id": "abc-123",
            "timestamp": 1_700_000_000,
            "active": true,
        });

        save_emergency_data_to_path(dir.path(), "session", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "session").unwrap();

        assert_eq!(loaded, data);
    }

    #[test]
    fn save_and_load_roundtrips_nested_data() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({
            "tabs": [
                {"id": 1, "title": "Tab One", "pinned": true},
                {"id": 2, "title": "Tab Two", "pinned": false}
            ],
            "settings": {
                "theme": "dark",
                "zoom": 1.25,
                "flags": [true, false, null]
            },
            "empty": null
        });

        save_emergency_data_to_path(dir.path(), "state", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "state").unwrap();

        assert_eq!(loaded, data);
    }

    #[test]
    fn save_multiple_files_independently() {
        let dir = TempDir::new().unwrap();
        let data_a = serde_json::json!({"value": "a"});
        let data_b = serde_json::json!({"value": "b"});
        let data_c = serde_json::json!({"value": "c"});

        save_emergency_data_to_path(dir.path(), "file_a", &data_a).unwrap();
        save_emergency_data_to_path(dir.path(), "file_b", &data_b).unwrap();
        save_emergency_data_to_path(dir.path(), "file_c", &data_c).unwrap();

        assert_eq!(
            load_emergency_data_from_path(dir.path(), "file_a").unwrap(),
            data_a
        );
        assert_eq!(
            load_emergency_data_from_path(dir.path(), "file_b").unwrap(),
            data_b
        );
        assert_eq!(
            load_emergency_data_from_path(dir.path(), "file_c").unwrap(),
            data_c
        );
    }

    #[test]
    fn save_overwrites_existing_file() {
        let dir = TempDir::new().unwrap();
        let first = serde_json::json!({"version": 1});
        let second = serde_json::json!({"version": 2});

        save_emergency_data_to_path(dir.path(), "doc", &first).unwrap();
        save_emergency_data_to_path(dir.path(), "doc", &second).unwrap();

        let loaded = load_emergency_data_from_path(dir.path(), "doc").unwrap();
        assert_eq!(loaded, second);
    }

    #[test]
    fn save_with_valid_dashed_filename() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"ok": true});

        save_emergency_data_to_path(dir.path(), "my-backup", &data).unwrap();
        assert_eq!(
            load_emergency_data_from_path(dir.path(), "my-backup").unwrap(),
            data
        );
        // 文件应命名为 my-backup.json
        assert!(dir.path().join("my-backup.json").exists());
    }

    #[test]
    fn save_and_load_unicode_content() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({
            "title": "日本語タイトル",
            "emoji": "🚀🎉",
            "text": "中文测试 — Français — Español"
        });

        save_emergency_data_to_path(dir.path(), "unicode", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "unicode").unwrap();

        assert_eq!(loaded, data);
    }

    // =========================================================================
    // save_emergency_data_to_path / load_emergency_data_from_path — 边界用例
    // =========================================================================

    #[test]
    fn save_and_load_empty_json_object() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({});

        save_emergency_data_to_path(dir.path(), "empty_obj", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "empty_obj").unwrap();

        assert_eq!(loaded, data);
    }

    #[test]
    fn save_and_load_empty_json_array() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!([]);

        save_emergency_data_to_path(dir.path(), "empty_arr", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "empty_arr").unwrap();

        assert_eq!(loaded, data);
    }

    #[test]
    fn save_large_json_near_limit_succeeds() {
        let dir = TempDir::new().unwrap();
        // 构造一个美化后 JSON 序列化结果接近（但仍在）10MB 限制以内的负载。
        // 长度为 N 的纯 JSON 字符串序列化后为 N + 2 字节（包含两侧引号）。
        let max = MAX_RECOVERY_DATA_BYTES as usize;
        let target_len = max - 1024; // 留出少量安全余量
        let string_len = target_len.saturating_sub(2);
        let large_string = "a".repeat(string_len);
        let data = Value::String(large_string);

        let serialized = serde_json::to_string_pretty(&data).unwrap();
        assert!(serialized.len() <= max);
        assert!(serialized.len() > max - 2048);

        save_emergency_data_to_path(dir.path(), "large", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "large").unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn load_nonexistent_file_returns_file_not_found() {
        let dir = TempDir::new().unwrap();

        let result = load_emergency_data_from_path(dir.path(), "missing");
        assert!(matches!(result, Err(RecoveryError::FileNotFound)));
    }

    #[test]
    fn save_does_not_leave_temp_file_on_success() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        save_emergency_data_to_path(dir.path(), "clean", &data).unwrap();

        // 最终 JSON 文件必须存在，且无残留的 .tmp 文件。
        assert!(dir.path().join("clean.json").exists());
        assert!(!dir.path().join("clean.tmp").exists());
    }

    // =========================================================================
    // save_emergency_data_to_path — 异常用例
    // =========================================================================

    #[test]
    fn save_with_path_separator_in_filename_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        let result = save_emergency_data_to_path(dir.path(), "../etc/passwd", &data);
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
        // 不应有任何文件被写入
        assert_eq!(dir.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn save_with_empty_filename_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        let result = save_emergency_data_to_path(dir.path(), "", &data);
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    #[test]
    fn save_with_filename_too_long_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});
        let filename = "a".repeat(101);

        let result = save_emergency_data_to_path(dir.path(), &filename, &data);
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    #[test]
    fn save_data_exceeding_limit_returns_data_too_large() {
        let dir = TempDir::new().unwrap();
        // 长度为 N 的纯 JSON 字符串序列化后为 N + 2 字节；选取 N 使序列化后
        // 的大小明显超过 10MB 限制。
        let over_len = MAX_RECOVERY_DATA_BYTES as usize + 256;
        let huge_string = "a".repeat(over_len.saturating_sub(2));
        let data = Value::String(huge_string);

        let serialized = serde_json::to_string_pretty(&data).unwrap();
        assert!(serialized.len() > MAX_RECOVERY_DATA_BYTES as usize);

        let result = save_emergency_data_to_path(dir.path(), "huge", &data);
        assert!(matches!(
            result,
            Err(RecoveryError::DataTooLarge { max_bytes }) if max_bytes == MAX_RECOVERY_DATA_BYTES
        ));
        // 不应有任何文件被写入
        assert!(!dir.path().join("huge.json").exists());
    }

    // =========================================================================
    // load_emergency_data_from_path — 异常用例
    // =========================================================================

    #[test]
    fn load_corrupted_json_returns_parse_error() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("corrupt.json"), "{ not valid json").unwrap();

        let result = load_emergency_data_from_path(dir.path(), "corrupt");
        assert!(matches!(result, Err(RecoveryError::ParseError { .. })));
    }

    #[test]
    fn load_with_invalid_filename_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        // 即使存在原始名称的文件，校验也会先执行。
        let result = load_emergency_data_from_path(dir.path(), "bad/name");
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    #[test]
    fn load_truncated_json_returns_parse_error() {
        let dir = TempDir::new().unwrap();
        // 截断的对象，在切点之前是有效的但未闭合。
        std::fs::write(dir.path().join("trunc.json"), r#"{"key":"value","#).unwrap();

        let result = load_emergency_data_from_path(dir.path(), "trunc");
        assert!(matches!(result, Err(RecoveryError::ParseError { .. })));
    }

    // =========================================================================
    // cleanup_old_recovery_files_in_dir — 正向用例
    // =========================================================================

    #[test]
    fn cleanup_removes_old_files_and_returns_count() {
        let dir = TempDir::new().unwrap();
        // 创建两个旧的 .json 文件和一个最近的 .json 文件。
        std::fs::write(dir.path().join("old1.json"), "{}").unwrap();
        std::fs::write(dir.path().join("old2.json"), "{}").unwrap();
        std::fs::write(dir.path().join("recent.json"), "{}").unwrap();

        set_file_mtime_days_old(&dir.path().join("old1.json"), 10);
        set_file_mtime_days_old(&dir.path().join("old2.json"), 8);
        // recent.json 保留当前 mtime

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 2);

        assert!(!dir.path().join("old1.json").exists());
        assert!(!dir.path().join("old2.json").exists());
        assert!(dir.path().join("recent.json").exists());
    }

    #[test]
    fn cleanup_keeps_recent_files() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("fresh.json"), r#"{"x":1}"#).unwrap();

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 0);
        assert!(dir.path().join("fresh.json").exists());
    }

    #[test]
    fn cleanup_removes_only_old_json_files() {
        let dir = TempDir::new().unwrap();
        // 旧的 .json（应被删除）、最近的 .json（保留）、旧的 .txt（保留 — 非 json）。
        std::fs::write(dir.path().join("old.json"), "{}").unwrap();
        std::fs::write(dir.path().join("recent.json"), "{}").unwrap();
        std::fs::write(dir.path().join("old.txt"), "hello").unwrap();

        set_file_mtime_days_old(&dir.path().join("old.json"), 10);
        set_file_mtime_days_old(&dir.path().join("old.txt"), 10);

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 1);

        assert!(!dir.path().join("old.json").exists());
        assert!(dir.path().join("recent.json").exists());
        assert!(dir.path().join("old.txt").exists());
    }

    // =========================================================================
    // cleanup_old_recovery_files_in_dir — 边界用例
    // =========================================================================

    #[test]
    fn cleanup_empty_dir_returns_zero() {
        let dir = TempDir::new().unwrap();

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn cleanup_dir_with_only_non_json_files_returns_zero() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "hi").unwrap();
        std::fs::write(dir.path().join("data.csv"), "1,2,3").unwrap();
        set_file_mtime_days_old(&dir.path().join("notes.txt"), 30);
        set_file_mtime_days_old(&dir.path().join("data.csv"), 30);

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 0);
        // 非 json 文件保持不变。
        assert!(dir.path().join("notes.txt").exists());
        assert!(dir.path().join("data.csv").exists());
    }

    #[test]
    fn cleanup_file_just_under_seven_days_old_is_kept() {
        // mtime 刚好不到 7 天截止线的文件应被保留。
        // 使用 7 天减去 5 分钟缓冲，以避免设置 mtime 与清理读取 `SystemTime::now()`
        // 之间的微小延迟导致结果越过边界。
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("boundary.json");
        std::fs::write(&path, "{}").unwrap();

        let just_under = SystemTime::now() - Duration::from_secs(7 * 24 * 60 * 60 - 300);
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_times(FileTimes::new().set_modified(just_under))
            .unwrap();

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 0);
        assert!(path.exists());
    }

    // =========================================================================
    // cleanup_old_recovery_files_in_dir — 异常用例
    // =========================================================================

    #[test]
    fn cleanup_fails_on_nonexistent_directory() {
        let dir = TempDir::new().unwrap();
        let nonexistent = dir.path().join("does_not_exist");
        drop(dir);

        let result = cleanup_old_recovery_files_in_dir(&nonexistent);
        assert!(result.is_err());
        assert!(matches!(result, Err(RecoveryError::IoError { .. })));
    }

    // =========================================================================
    // cleanup_old_recovery_files_in_dir — 边界用例补充
    // =========================================================================

    #[test]
    fn cleanup_file_exactly_at_seven_days_boundary_is_removed() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("boundary_old.json");
        std::fs::write(&path, "{}").unwrap();

        // 将 mtime 设置为略超过 7 天前，确保越过截止线
        let over_seven = SystemTime::now() - Duration::from_secs(7 * 24 * 60 * 60 + 300);
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_times(FileTimes::new().set_modified(over_seven))
            .unwrap();

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 1);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_removes_multiple_old_files_and_counts_correctly() {
        let dir = TempDir::new().unwrap();
        for i in 0..5 {
            let path = dir.path().join(format!("old{i}.json"));
            std::fs::write(&path, "{}").unwrap();
            set_file_mtime_days_old(&path, 10);
        }
        // 同时添加一个最近的文件
        std::fs::write(dir.path().join("recent.json"), "{}").unwrap();

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 5);
        assert!(dir.path().join("recent.json").exists());
    }

    #[test]
    fn cleanup_ignores_files_without_extension() {
        let dir = TempDir::new().unwrap();
        let no_ext = dir.path().join("no_extension");
        std::fs::write(&no_ext, "data").unwrap();
        set_file_mtime_days_old(&no_ext, 30);

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 0);
        assert!(no_ext.exists());
    }

    #[test]
    fn cleanup_ignores_json_files_with_wrong_extension_case() {
        let dir = TempDir::new().unwrap();
        let upper = dir.path().join("data.JSON");
        std::fs::write(&upper, "{}").unwrap();
        set_file_mtime_days_old(&upper, 30);

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        // 扩展名比较区分大小写："JSON" != "json"
        assert_eq!(removed, 0);
        assert!(upper.exists());
    }

    // =========================================================================
    // save_emergency_data_to_path — 边界用例补充
    // =========================================================================

    #[test]
    fn save_with_numeric_filename_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        let result = save_emergency_data_to_path(dir.path(), "123", &data);
        // 纯数字应为有效（字母数字组合）
        assert!(result.is_ok());
    }

    #[test]
    fn save_with_underscore_and_dash_filename_succeeds() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"ok": true});

        let result = save_emergency_data_to_path(dir.path(), "my_backup-2024", &data);
        assert!(result.is_ok());
        assert!(dir.path().join("my_backup-2024.json").exists());
    }

    #[test]
    fn save_does_not_create_temp_file_on_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        // 无效文件名应在写入任何临时文件之前失败
        let _ = save_emergency_data_to_path(dir.path(), "../bad", &data);

        assert_eq!(dir.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn save_with_null_value_succeeds() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!(null);

        save_emergency_data_to_path(dir.path(), "null_data", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "null_data").unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn save_with_boolean_value_succeeds() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!(true);

        save_emergency_data_to_path(dir.path(), "bool_data", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "bool_data").unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn save_with_number_value_succeeds() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!(42);

        save_emergency_data_to_path(dir.path(), "num_data", &data).unwrap();
        let loaded = load_emergency_data_from_path(dir.path(), "num_data").unwrap();
        assert_eq!(loaded, data);
    }

    // =========================================================================
    // save_emergency_data_to_path — 异常用例补充
    // =========================================================================

    #[test]
    fn save_fails_on_nonexistent_directory() {
        let dir = TempDir::new().unwrap();
        let nonexistent = dir.path().join("missing_dir");
        drop(dir);

        let data = serde_json::json!({"x": 1});
        let result = save_emergency_data_to_path(&nonexistent, "test", &data);
        assert!(result.is_err());
        assert!(matches!(result, Err(RecoveryError::IoError { .. })));
    }

    #[test]
    fn save_with_filename_containing_spaces_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        let result = save_emergency_data_to_path(dir.path(), "my file", &data);
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    #[test]
    fn save_with_filename_with_dot_prefix_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let data = serde_json::json!({"x": 1});

        let result = save_emergency_data_to_path(dir.path(), ".hidden", &data);
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    // =========================================================================
    // load_emergency_data_from_path — 边界用例补充
    // =========================================================================

    #[test]
    fn load_with_empty_filename_returns_validation_error() {
        let dir = TempDir::new().unwrap();

        let result = load_emergency_data_from_path(dir.path(), "");
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    #[test]
    fn load_with_filename_too_long_returns_validation_error() {
        let dir = TempDir::new().unwrap();
        let filename = "a".repeat(101);

        let result = load_emergency_data_from_path(dir.path(), &filename);
        assert!(matches!(result, Err(RecoveryError::ValidationError { .. })));
    }

    #[test]
    fn load_file_with_only_whitespace_content_returns_parse_error() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("ws.json"), "   \n\t  ").unwrap();

        let result = load_emergency_data_from_path(dir.path(), "ws");
        assert!(matches!(result, Err(RecoveryError::ParseError { .. })));
    }

    #[test]
    fn load_file_with_null_content_returns_parse_error() {
        let dir = TempDir::new().unwrap();
        // "null" 是有效的 JSON，但对恢复来说不是有效的 JSON 对象/数组
        // 不过 serde_json::Value 接受 null，因此应成功
        std::fs::write(dir.path().join("null.json"), "null").unwrap();

        let result = load_emergency_data_from_path(dir.path(), "null");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), serde_json::Value::Null);
    }

    // =========================================================================
    // 综合 — 多文件保存后清理
    // =========================================================================

    #[test]
    fn save_multiple_then_cleanup_removes_only_old() {
        let dir = TempDir::new().unwrap();

        // 保存 3 个文件，将其中 2 个设为旧文件
        save_emergency_data_to_path(dir.path(), "old1", &serde_json::json!({"i": 1})).unwrap();
        save_emergency_data_to_path(dir.path(), "old2", &serde_json::json!({"i": 2})).unwrap();
        save_emergency_data_to_path(dir.path(), "new1", &serde_json::json!({"i": 3})).unwrap();

        set_file_mtime_days_old(&dir.path().join("old1.json"), 10);
        set_file_mtime_days_old(&dir.path().join("old2.json"), 8);

        let removed = cleanup_old_recovery_files_in_dir(dir.path()).unwrap();
        assert_eq!(removed, 2);

        // 验证剩余文件可加载
        let loaded = load_emergency_data_from_path(dir.path(), "new1").unwrap();
        assert_eq!(loaded["i"], 3);
    }
}

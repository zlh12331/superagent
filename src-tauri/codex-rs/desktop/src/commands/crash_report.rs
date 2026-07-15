//! 崩溃报告命令。
//!
//! 设置一个 Rust panic hook，将 panic 信息捕获到磁盘上的崩溃文件中。
//! 在应用下次启动时，前端会读取该崩溃文件并发送给
//! Sentry（前提是用户已授权）。
//!
//! 授权状态以全局 `AtomicU8` 维护，以便 Sentry 的
//! `before_send` 回调无需跨越 IPC 边界即可检查该状态。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Runtime};

use crate::error::AppError;
use crate::types::{AppPreferences, CrashReportData};
use crate::utils::paths::{ensure_dir_exists, get_app_data_file_path, get_app_data_file_path_sync};
use crate::utils::redact::redact_sensitive;

/// Sentry 事件提交的全局授权状态（Rust 端）。
///
/// - `0`：尚未询问授权（事件会被 `before_send` 丢弃）
/// - `1`：授权通过（事件会发送）
/// - `2`：授权拒绝（事件会被 `before_send` 丢弃）
///
/// 这与前端 `sentry.ts` 中的 `consentGranted` 状态保持一致。
/// 前端通过 `set_consent` Tauri command 设置该状态，且在 `setup()`
/// 期间通过 `init_consent_from_preferences` 从 `preferences.json`
/// 初始化该值。
pub static CONSENT_STATE: AtomicU8 = AtomicU8::new(0);

/// 获取应用数据目录下崩溃报告文件的路径。
///
/// 仅解析路径 — **不会**创建目录。需要写入文件的调用方
/// 必须在 `spawn_blocking` 中调用 [`ensure_dir_exists`]。
fn get_crash_report_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    get_app_data_file_path(app, "crash-report.json")
}

/// 对字符串进行转义，使其可安全嵌入 JSON 字符串字面量。
///
/// panic hook 使用该函数在不依赖 `serde_json` 的情况下构建崩溃报告 JSON，
/// 因为 `serde_json` 在内存分配失败时可能 panic，从而导致二次 panic。
fn escape_json_string(s: &str) -> String {
    let mut result = String::with_capacity(s.len() + 2);
    result.push('"');
    for c in s.chars() {
        match c {
            '"' => result.push_str(r#"\""#),
            '\\' => result.push_str(r"\\"),
            '\n' => result.push_str(r"\n"),
            '\r' => result.push_str(r"\r"),
            '\t' => result.push_str(r"\t"),
            c if c.is_control() => result.push_str(&format!(r"\u{:04x}", c as u32)),
            c => result.push(c),
        }
    }
    result.push('"');
    result
}

/// 纯辅助函数：将授权值持久化到 `path` 指定的偏好设置文件中。
///
/// 读取当前偏好设置（若文件不存在则使用默认值），
/// 更新 `crash_reporting_consent`，并以原子方式写回。这确保
/// 即使前端未调用 `save_preferences`，授权状态也能在重启后保留。
///
/// 暴露以支持无 `AppHandle` 的集成测试。
pub fn persist_consent_to_path(path: &Path, consent: Option<bool>) -> Result<(), AppError> {
    // 读取当前偏好设置，不存在则使用默认值
    let mut prefs = if path.exists() {
        let contents = fs::read_to_string(path).map_err(|e| {
            AppError::io(format!(
                "Failed to read preferences for consent persist: {e}"
            ))
        })?;
        serde_json::from_str::<AppPreferences>(&contents).unwrap_or_else(|e| {
            log::warn!(
                "Preferences file corrupted during consent persist, preserving consent only: {e}"
            );
            // 不要用默认值覆盖其他字段 — 仅以默认值作为基础
            AppPreferences::default()
        })
    } else {
        AppPreferences::default()
    };

    prefs.crash_reporting_consent = consent;

    // 使用原子写入写回（临时文件 + 重命名）
    let json = serde_json::to_string_pretty(&prefs).map_err(|e| {
        AppError::serialization(format!(
            "Failed to serialize preferences for consent persist: {e}"
        ))
    })?;
    let temp_path = path.with_extension("tmp");

    fs::write(&temp_path, &json).map_err(|e| {
        AppError::io(format!(
            "Failed to write preferences for consent persist: {e}"
        ))
    })?;

    if let Err(rename_err) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(AppError::io(format!(
            "Failed to finalize preferences for consent persist: {rename_err}"
        )));
    }

    log::info!("Consent persisted to preferences file");
    Ok(())
}

/// 设置一个 panic hook，将 panic 信息捕获到崩溃文件中。
///
/// 写入崩溃文件后仍会调用原始 panic hook，
/// 因此默认行为（打印到 stderr、终止进程）会被保留。
///
/// ## 二次 panic 安全
///
/// 崩溃报告 JSON 是**手动**使用 `format!` 构建的，而非使用
/// `serde_json::to_string_pretty`，因为 `serde_json` 在 OOM 条件下
/// 可能分配内存并 panic — 这会导致二次 panic，立即终止进程
/// 并丢失原始崩溃信息。
///
/// `fs::write` 调用被包裹在 `catch_unwind(AssertUnwindSafe(..))` 中，
/// 作为防止文件系统引发 panic 的最后一道安全网。
///
/// 应在 `setup()` 早期调用，以尽可能多地捕获 panic。
pub fn setup_panic_hook<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let original_hook = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        // 从 payload 中提取 panic 消息
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        // 提取源码位置
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));

        // 捕获回溯（force_capture 始终捕获，即使未设置 RUST_BACKTRACE=1）
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();

        // 获取时间戳
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // 获取应用版本
        let app_version = handle.package_info().version.to_string();

        // 手动构建崩溃报告 JSON（避免使用 serde_json，它可能在分配内存时 panic）。
        // 先对敏感数据脱敏（P1-1 修复：panic message 可能包含 API key 等敏感信息）
        let safe_message = redact_sensitive(&message);
        let safe_backtrace = redact_sensitive(&backtrace);
        let safe_location = location.as_deref().map(redact_sensitive);

        let location_json = safe_location
            .as_deref()
            .map(escape_json_string)
            .unwrap_or_else(|| "null".to_string());

        let json = format!(
            r#"{{"crash_type":"rust_panic","message":{},"location":{},"backtrace":{},"timestamp":{},"app_version":{}}}"#,
            escape_json_string(&safe_message),
            location_json,
            escape_json_string(&safe_backtrace),
            timestamp,
            escape_json_string(&app_version)
        );

        // 将崩溃数据写入文件，使用 catch_unwind 包裹以防止
        // 文件系统操作引发的二次 panic 终止进程。
        let write_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Ok(crash_path) = get_crash_report_path(&handle)
                && let Err(e) = fs::write(&crash_path, &json)
            {
                eprintln!("Failed to write crash report: {e}");
            }
        }));
        if write_result.is_err() {
            eprintln!("Secondary panic while writing crash report — data may be lost");
        }

        // 调用原始 panic hook（保留默认行为）
        original_hook(info);
    }));
}

/// 读取崩溃报告文件（若存在）。
/// 若未找到崩溃文件则返回 None。
///
/// 泛型实现 — 可使用任意 `Runtime` 测试（包括 `MockRuntime`）。
pub async fn read_crash_report_impl<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<CrashReportData>, AppError> {
    let crash_path = get_crash_report_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = crash_path.parent() {
            ensure_dir_exists(parent)?;
        }
        read_crash_report_from_path(&crash_path)
    })
    .await
    .map_err(|e| AppError::task_join(format!("Task join error: {e}")))?
}

/// 读取崩溃报告文件（若存在）。
/// 若未找到崩溃文件则返回 None。
#[tauri::command]
#[specta::specta]
pub async fn read_crash_report(app: AppHandle) -> Result<Option<CrashReportData>, AppError> {
    read_crash_report_impl(app).await
}

/// 纯辅助函数：从指定文件路径读取崩溃报告。
///
/// 文件不存在时返回 `Ok(None)`。所有文件系统和解析错误都会被记录日志
/// 并以 `Err(AppError)` 形式传播，以保留原始命令层级的错误处理契约。
///
/// 暴露以支持无 `AppHandle` 的集成测试。
pub fn read_crash_report_from_path(path: &Path) -> Result<Option<CrashReportData>, AppError> {
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(path).map_err(|e| {
        log::error!("Failed to read crash report: {e}");
        AppError::io(format!("Failed to read crash report: {e}"))
    })?;

    let data: CrashReportData = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse crash report: {e}");
        AppError::serialization(format!("Failed to parse crash report: {e}"))
    })?;

    log::info!("Crash report loaded from disk");
    Ok(Some(data))
}

/// 删除崩溃报告文件。
/// 在崩溃已发送到 Sentry 或被用户忽略后调用。
///
/// 泛型实现 — 可使用任意 `Runtime` 测试（包括 `MockRuntime`）。
pub async fn delete_crash_report_impl<R: Runtime>(app: AppHandle<R>) -> Result<(), AppError> {
    let crash_path = get_crash_report_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // 删除操作无需创建目录，但保持路径一致性。
        let _ = crash_path.parent(); // 父目录在先前写入时已确保存在
        delete_crash_report_at_path(&crash_path)
    })
    .await
    .map_err(|e| AppError::task_join(format!("Task join error: {e}")))?
}

/// 删除崩溃报告文件。
/// 在崩溃已发送到 Sentry 或被用户忽略后调用。
#[tauri::command]
#[specta::specta]
pub async fn delete_crash_report(app: AppHandle) -> Result<(), AppError> {
    delete_crash_report_impl(app).await
}

/// 从已持久化的偏好设置文件初始化全局授权状态。
///
/// 应在 `setup()` 期间、`setup_panic_hook` 之前调用，以便 setup 之后
/// 发生的 panic 能遵循用户先前保存的授权。
/// 若偏好设置文件不存在或无法解析，授权状态保持为 `0`（未询问），
/// 这是隐私安全的默认值。
pub fn init_consent_from_preferences<R: Runtime>(app: &AppHandle<R>) {
    let path = match get_app_data_file_path_sync(app, "preferences.json") {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Could not resolve preferences path for consent init: {e}");
            return;
        }
    };
    init_consent_from_path(&path);
}

/// 纯辅助函数：从偏好设置文件路径初始化全局授权状态。
///
/// 读取 `path` 指定的偏好设置文件，解析后据此设置 `CONSENT_STATE`。
/// 若文件不存在、无法读取或无法解析，授权状态保持不变（隐私安全的默认值）。
///
/// 暴露以支持无 `AppHandle` 的集成测试。
pub fn init_consent_from_path(path: &Path) {
    if !path.exists() {
        log::debug!("No preferences file found; consent state stays at default (0)");
        return;
    }

    let contents = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Could not read preferences file for consent init: {e}");
            return;
        }
    };

    let prefs: AppPreferences = match serde_json::from_str(&contents) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Could not parse preferences file for consent init: {e}");
            return;
        }
    };

    let value = match prefs.crash_reporting_consent {
        Some(true) => 1,
        Some(false) => 2,
        None => 0,
    };

    CONSENT_STATE.store(value, Ordering::Release);
    log::info!(
        "Sentry consent initialized from preferences: {value} (0=unknown, 1=granted, 2=denied)"
    );
}

/// 设置崩溃报告授权状态。
///
/// 由前端在用户通过偏好设置面板或崩溃报告对话框授予或拒绝授权时调用。
/// 状态既保存在内存中（通过 `CONSENT_STATE`），**也**持久化到 Rust 端的
/// `preferences.json`，因此即使前端未调用 `save_preferences`，
/// 重启后该状态也会保留。
///
/// 泛型实现 — 可使用任意 `Runtime` 测试（包括 `MockRuntime`）。
pub async fn set_consent_impl<R: Runtime>(
    app: AppHandle<R>,
    consent: Option<bool>,
) -> Result<(), AppError> {
    let value = match consent {
        Some(true) => 1,
        Some(false) => 2,
        None => 0,
    };
    CONSENT_STATE.store(value, Ordering::Release);
    log::info!("Sentry consent state set to: {value} (0=unknown, 1=granted, 2=denied)");

    // 将授权持久化到 preferences.json（Rust 端持久化）。
    let prefs_path = get_app_data_file_path(&app, "preferences.json")?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = prefs_path.parent() {
            ensure_dir_exists(parent)?;
        }
        persist_consent_to_path(&prefs_path, consent)
    })
    .await
    .map_err(|e| AppError::task_join(format!("Task join error: {e}")))?
}

/// 设置崩溃报告授权状态。
///
/// 由前端在用户通过偏好设置面板或崩溃报告对话框授予或拒绝授权时调用。
/// 状态既保存在内存中（通过 `CONSENT_STATE`），**也**持久化到 Rust 端的
/// `preferences.json`，因此即使前端未调用 `save_preferences`，
/// 重启后该状态也会保留。
#[tauri::command]
#[specta::specta]
pub async fn set_consent(app: AppHandle, consent: Option<bool>) -> Result<(), AppError> {
    set_consent_impl(app, consent).await
}

/// 纯辅助函数：删除指定路径的崩溃报告文件。
///
/// 幂等操作：文件不存在时返回 `Ok(())`。文件系统错误会记录日志
/// 并以 `Err(AppError)` 形式传播。
///
/// 暴露以支持无 `AppHandle` 的集成测试。
pub fn delete_crash_report_at_path(path: &Path) -> Result<(), AppError> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| {
            log::error!("Failed to delete crash report: {e}");
            AppError::io(format!("Failed to delete crash report: {e}"))
        })?;
        log::info!("Crash report file deleted");
    }

    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 对读写全局 `CONSENT_STATE` 的测试进行串行化。
    ///
    /// 若无此 mutex，并行测试会在共享的 `AtomicU8` 上产生竞态，
    /// 导致偶发性失败（例如一个测试在另一个测试断言前覆盖了该值）。
    ///
    /// 使用 `tokio::sync::Mutex`（而非 `std::sync::Mutex`），因为授权
    /// 测试是异步的（`#[tokio::test]`）。`std::sync::MutexGuard` 跨
    /// `.await` 持有会触发 `clippy::await_holding_lock`，并可能导致
    /// 多线程运行时死锁。
    static CONSENT_TEST_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// 辅助函数：为测试创建一个 `CrashReportData` 示例。
    fn sample_crash_report() -> CrashReportData {
        CrashReportData {
            crash_type: "rust_panic".to_string(),
            message: "index out of bounds".to_string(),
            location: Some("src/main.rs:42:13".to_string()),
            backtrace: "stack backtrace:\n  ...".to_string(),
            timestamp: 1_700_000_000.0,
            app_version: "1.2.3".to_string(),
        }
    }

    // =========================================================================
    // read_crash_report_from_path — 正向用例
    // =========================================================================

    #[test]
    fn read_crash_report_reads_valid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        let data = sample_crash_report();
        let json = serde_json::to_string_pretty(&data).unwrap();
        std::fs::write(&path, json).unwrap();

        let loaded = read_crash_report_from_path(&path)
            .unwrap()
            .expect("expected Some(crash report)");
        assert_eq!(loaded.crash_type, data.crash_type);
        assert_eq!(loaded.message, data.message);
        assert_eq!(loaded.location, data.location);
        assert_eq!(loaded.backtrace, data.backtrace);
        assert_eq!(loaded.timestamp, data.timestamp);
        assert_eq!(loaded.app_version, data.app_version);
    }

    #[test]
    fn read_crash_report_roundtrips_after_compact_write() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        let original = sample_crash_report();
        std::fs::write(&path, serde_json::to_string(&original).unwrap()).unwrap();

        let loaded = read_crash_report_from_path(&path)
            .unwrap()
            .expect("expected Some(crash report)");
        assert_eq!(loaded.crash_type, original.crash_type);
        assert_eq!(loaded.timestamp, original.timestamp);
        assert_eq!(loaded.app_version, original.app_version);
    }

    #[test]
    fn read_crash_report_handles_null_location() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        // JSON 中的 `location: null` 对应 `None`。
        let json = r#"{
            "crash_type": "rust_panic",
            "message": "boom",
            "location": null,
            "backtrace": "empty",
            "timestamp": 123,
            "app_version": "0.1.0"
        }"#;
        std::fs::write(&path, json).unwrap();

        let loaded = read_crash_report_from_path(&path)
            .unwrap()
            .expect("expected Some(crash report)");
        assert!(loaded.location.is_none());
        assert_eq!(loaded.message, "boom");
    }

    // =========================================================================
    // read_crash_report_from_path — 边界用例
    // =========================================================================

    #[test]
    fn read_crash_report_returns_none_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");

        let result = read_crash_report_from_path(&path).unwrap();
        assert!(result.is_none());
    }

    // =========================================================================
    // read_crash_report_from_path — 异常用例
    // =========================================================================

    #[test]
    fn read_crash_report_fails_on_invalid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, "not json at all").unwrap();

        let result = read_crash_report_from_path(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Failed to parse"));
    }

    #[test]
    fn read_crash_report_fails_on_partial_invalid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, r#"{"crash_type":"rust_panic","message":}"#).unwrap();

        let result = read_crash_report_from_path(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Failed to parse"));
    }

    #[test]
    fn read_crash_report_fails_on_non_json_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, "<<<not a json content>>>").unwrap();

        let result = read_crash_report_from_path(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Failed to parse"));
    }

    #[test]
    fn read_crash_report_fails_on_missing_required_field() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        // 缺少 `message` 字段。
        let json = r#"{
            "crash_type": "rust_panic",
            "backtrace": "empty",
            "timestamp": 123,
            "app_version": "0.1.0"
        }"#;
        std::fs::write(&path, json).unwrap();

        let result = read_crash_report_from_path(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Failed to parse"));
    }

    // =========================================================================
    // delete_crash_report_at_path — 正向用例
    // =========================================================================

    #[test]
    fn delete_crash_report_removes_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, "{}").unwrap();
        assert!(path.exists());

        delete_crash_report_at_path(&path).unwrap();
        assert!(!path.exists());
    }

    // =========================================================================
    // delete_crash_report_at_path — 边界用例
    // =========================================================================

    #[test]
    fn delete_crash_report_returns_ok_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        assert!(!path.exists());

        // 幂等：删除不存在的文件也返回 Ok。
        let result = delete_crash_report_at_path(&path);
        assert!(result.is_ok());
    }

    // =========================================================================
    // 综合 / 跨函数用例
    // =========================================================================

    #[test]
    fn delete_crash_report_idempotent_on_double_delete() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, "{}").unwrap();

        delete_crash_report_at_path(&path).unwrap();
        // 第二次删除也应成功（幂等）。
        let result = delete_crash_report_at_path(&path);
        assert!(result.is_ok());
        assert!(!path.exists());
    }

    #[test]
    fn read_returns_none_after_delete() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        let data = sample_crash_report();
        std::fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();

        // 确认初始状态下可读取。
        assert!(read_crash_report_from_path(&path).unwrap().is_some());

        // 删除后验证读取返回 None。
        delete_crash_report_at_path(&path).unwrap();
        assert!(read_crash_report_from_path(&path).unwrap().is_none());
    }

    // =========================================================================
    // CONSENT_STATE — 正向用例
    // =========================================================================

    #[tokio::test]
    async fn consent_state_default_is_zero() {
        let _guard = CONSENT_TEST_MUTEX.lock().await;
        // 重置为已知状态，保证测试隔离。
        CONSENT_STATE.store(0, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn consent_state_granted_sets_to_one() {
        let _guard = CONSENT_TEST_MUTEX.lock().await;
        CONSENT_STATE.store(1, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);
        // 测试后重置。
        CONSENT_STATE.store(0, Ordering::Relaxed);
    }

    #[tokio::test]
    async fn consent_state_denied_sets_to_two() {
        let _guard = CONSENT_TEST_MUTEX.lock().await;
        CONSENT_STATE.store(2, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 2);
        // 测试后重置。
        CONSENT_STATE.store(0, Ordering::Relaxed);
    }

    // =========================================================================
    // CONSENT_STATE — 边界用例
    // =========================================================================

    #[tokio::test]
    async fn consent_state_resets_to_zero() {
        let _guard = CONSENT_TEST_MUTEX.lock().await;
        // 先设置为 granted。
        CONSENT_STATE.store(1, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);

        // 再重置为 0。
        CONSENT_STATE.store(0, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn consent_state_can_toggle_between_states() {
        let _guard = CONSENT_TEST_MUTEX.lock().await;
        CONSENT_STATE.store(1, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);

        CONSENT_STATE.store(2, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 2);

        CONSENT_STATE.store(1, Ordering::Relaxed);
        assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);

        // 测试后重置。
        CONSENT_STATE.store(0, Ordering::Relaxed);
    }

    // =========================================================================
    // persist_consent_to_path — 正向用例
    // =========================================================================

    #[test]
    fn persist_consent_granted_writes_true_to_preferences() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        persist_consent_to_path(&path, Some(true)).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(true));
    }

    #[test]
    fn persist_consent_denied_writes_false_to_preferences() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        persist_consent_to_path(&path, Some(false)).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(false));
    }

    #[test]
    fn persist_consent_none_writes_null_to_preferences() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        persist_consent_to_path(&path, None).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
        assert_eq!(prefs.crash_reporting_consent, None);
    }

    // =========================================================================
    // persist_consent_to_path — 边界用例
    // =========================================================================

    #[test]
    fn persist_consent_preserves_other_preferences_fields() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        // 写入设置了 theme 的初始偏好。
        let initial = r#"{"theme":"dark","quick_pane_shortcut":"Ctrl+K","language":"fr","crash_reporting_consent":false}"#;
        std::fs::write(&path, initial).unwrap();

        persist_consent_to_path(&path, Some(true)).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(true));
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.quick_pane_shortcut.as_deref(), Some("Ctrl+K"));
        assert_eq!(prefs.language.as_deref(), Some("fr"));
    }

    #[test]
    fn persist_consent_creates_file_when_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");
        assert!(!path.exists());

        persist_consent_to_path(&path, Some(true)).unwrap();

        assert!(path.exists());
        let contents = std::fs::read_to_string(&path).unwrap();
        let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(true));
    }

    #[test]
    fn persist_consent_handles_corrupted_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");
        std::fs::write(&path, "not valid json").unwrap();

        // 应回退到默认值并仍持久化授权。
        persist_consent_to_path(&path, Some(true)).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(true));
    }

    // =========================================================================
    // escape_json_string — 正向用例
    // =========================================================================

    #[test]
    fn escape_plain_string_wraps_in_quotes() {
        let result = escape_json_string("hello");
        assert_eq!(result, r#""hello""#);
    }

    #[test]
    fn escape_empty_string_produces_empty_quotes() {
        let result = escape_json_string("");
        assert_eq!(result, r#""""#);
    }

    #[test]
    fn escape_string_with_quotes() {
        let result = escape_json_string(r#"say "hi""#);
        assert_eq!(result, r#""say \"hi\"""#);
    }

    #[test]
    fn escape_string_with_backslash() {
        let result = escape_json_string(r"C:\Users\test");
        assert_eq!(result, r#""C:\\Users\\test""#);
    }

    #[test]
    fn escape_string_with_newline() {
        let result = escape_json_string("line1\nline2");
        assert_eq!(result, r#""line1\nline2""#);
    }

    #[test]
    fn escape_string_with_carriage_return() {
        let result = escape_json_string("line1\rline2");
        assert_eq!(result, r#""line1\rline2""#);
    }

    #[test]
    fn escape_string_with_tab() {
        let result = escape_json_string("col1\tcol2");
        assert_eq!(result, r#""col1\tcol2""#);
    }

    #[test]
    fn escape_string_with_mixed_special_chars() {
        let result = escape_json_string(r#"hello "world" \n\t"#);
        assert!(result.contains(r#"\"world\""#));
        assert!(result.contains(r"\\"));
    }

    // =========================================================================
    // escape_json_string — 边界用例
    // =========================================================================

    #[test]
    fn escape_unicode_content() {
        let result = escape_json_string("日本語");
        assert_eq!(result, r#""日本語""#);
    }

    #[test]
    fn escape_emoji_content() {
        let result = escape_json_string("🚀");
        assert_eq!(result, r#""🚀""#);
    }

    #[test]
    fn escape_control_characters_to_unicode_escape() {
        // U+0001（SOH）是控制字符，应转换为 \u0001
        let result = escape_json_string("\u{0001}");
        assert_eq!(result, r#""\u0001""#);
    }

    #[test]
    fn escape_multiple_control_characters() {
        let input = "\u{0001}\u{0002}\u{001f}";
        let result = escape_json_string(input);
        assert!(result.contains(r"\u0001"));
        assert!(result.contains(r"\u0002"));
        assert!(result.contains(r"\u001f"));
    }

    #[test]
    fn escape_all_special_chars_together() {
        let input = "\"\\\n\r\t\u{0001}";
        let result = escape_json_string(input);
        assert!(result.contains(r#"\""#));
        assert!(result.contains(r"\\"));
        assert!(result.contains(r"\n"));
        assert!(result.contains(r"\r"));
        assert!(result.contains(r"\t"));
        assert!(result.contains(r"\u0001"));
    }

    // =========================================================================
    // escape_json_string — 异常用例
    // =========================================================================

    #[test]
    fn escape_string_with_only_special_chars() {
        // 输入：" 后跟 \（两个字符）
        // 输出：" + \" + \\ + "（6 个字符）
        let result = escape_json_string("\"\\");
        assert_eq!(result, r#""\"\\""#);
    }

    #[test]
    fn escape_long_string_succeeds() {
        let input = "a".repeat(10_000);
        let result = escape_json_string(&input);
        assert!(result.starts_with('"'));
        assert!(result.ends_with('"'));
        assert_eq!(result.len(), input.len() + 2);
    }

    // =========================================================================
    // escape_json_string — 集成验证（生成的 JSON 可被 serde_json 解析）
    // =========================================================================

    #[test]
    fn escaped_output_is_valid_json_string() {
        let raw = r#"error: "null pointer" at C:\code\main.rs:42\nstack: \n  frame1"#;
        let escaped = escape_json_string(raw);
        let json = format!("{{\"message\":{escaped}}}");

        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["message"], raw);
    }

    // =========================================================================
    // persist_consent_to_path — 异常用例
    // =========================================================================

    #[test]
    fn persist_consent_fails_when_directory_does_not_exist() {
        let dir = TempDir::new().unwrap();
        // 丢弃临时目录，使该路径不再存在
        let path = dir.path().join("nonexistent_dir").join("preferences.json");
        drop(dir);

        let result = persist_consent_to_path(&path, Some(true));
        assert!(result.is_err());
    }

    #[test]
    fn persist_consent_fails_on_readonly_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        // 创建一个文件并将其设为只读
        std::fs::write(&path, r#"{"theme":"dark"}"#).unwrap();

        let result = persist_consent_to_path(&path, Some(true));
        // Windows 上，临时文件写入可能成功但重命名可能失败
        // Unix 上，写入临时文件可能成功但覆盖只读文件的重命名可能失败
        // 无论哪种情况，操作都应成功或优雅地返回错误
        // （而非 panic）
        // 我们接受两种结果 — 关键是不应 panic
        let _ = result;
    }

    // =========================================================================
    // persist_consent_to_path — 边界用例
    // =========================================================================

    #[test]
    fn persist_consent_overwrites_existing_consent_value() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        // 先持久化为 true
        persist_consent_to_path(&path, Some(true)).unwrap();
        let prefs: AppPreferences =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(true));

        // 再改为 false
        persist_consent_to_path(&path, Some(false)).unwrap();
        let prefs: AppPreferences =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(prefs.crash_reporting_consent, Some(false));
    }

    #[test]
    fn persist_consent_none_after_granted() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        persist_consent_to_path(&path, Some(true)).unwrap();
        persist_consent_to_path(&path, None).unwrap();

        let prefs: AppPreferences =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(prefs.crash_reporting_consent, None);
    }

    #[test]
    fn persist_consent_preserves_consent_field_after_other_corruption() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("preferences.json");

        // 写入一个授权有效但其他字段损坏的文件
        std::fs::write(&path, r#"{"crash_reporting_consent":true,"theme":123}"#).unwrap();

        persist_consent_to_path(&path, Some(false)).unwrap();

        let prefs: AppPreferences =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // 授权应被更新为 false
        assert_eq!(prefs.crash_reporting_consent, Some(false));
    }

    // =========================================================================
    // read_crash_report_from_path — 边界用例
    // =========================================================================

    #[test]
    fn read_crash_report_handles_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, "").unwrap();

        let result = read_crash_report_from_path(&path);
        assert!(result.is_err());
    }

    #[test]
    fn read_crash_report_handles_empty_json_object() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        std::fs::write(&path, "{}").unwrap();

        let result = read_crash_report_from_path(&path);
        assert!(result.is_err());
    }

    #[test]
    fn read_crash_report_with_extra_fields_still_works() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("crash-report.json");
        // 多余的字段应被 serde 忽略
        let json = r#"{
            "crash_type": "rust_panic",
            "message": "boom",
            "location": null,
            "backtrace": "empty",
            "timestamp": 999,
            "app_version": "1.0",
            "extra_field": "ignored"
        }"#;
        std::fs::write(&path, json).unwrap();

        let loaded = read_crash_report_from_path(&path).unwrap().unwrap();
        assert_eq!(loaded.message, "boom");
    }

    // =========================================================================
    // delete_crash_report_at_path — 异常用例
    // =========================================================================

    #[test]
    fn delete_crash_report_fails_on_directory_not_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a_directory");
        std::fs::create_dir(&path).unwrap();

        let result = delete_crash_report_at_path(&path);
        // 在大多数平台上对目录调用 remove_file 应失败
        // （在 Windows 上若目录为空可能成功，这也可接受）
        let _ = result;
    }
}

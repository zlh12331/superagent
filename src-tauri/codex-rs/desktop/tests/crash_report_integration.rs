//! 崩溃上报相关 Tauri 命令的集成测试。
//!
//! 本测试覆盖三层：
//!
//! 1. **基于 AppHandle 的只读测试** — 通过 `mock_builder()`（MockRuntime）验证
//!    路径解析。仅用于不会产生文件写入的操作（无 crash 文件、无 preferences 文件）。
//!
//! 2. **`_from_path` + TempDir 写入测试** — 使用独立的 `tempfile::TempDir`
//!    目录验证纯文件 I/O 辅助函数（`persist_consent_to_path`、
//!    `read_crash_report_from_path`、`delete_crash_report_at_path`、
//!    `init_consent_from_path`）。
//!
//! 3. **CONSENT_STATE 测试** — 验证内存中的原子状态，不涉及任何文件 I/O。
//!    通过 `tokio::sync::Mutex` 串行化，避免并发访问共享的 `AtomicU8` 竞态。

use std::sync::atomic::Ordering;

use codex_desktop_lib::commands::crash_report::{
    CONSENT_STATE, delete_crash_report_at_path, delete_crash_report_impl, init_consent_from_path,
    init_consent_from_preferences, persist_consent_to_path, read_crash_report_from_path,
    read_crash_report_impl,
};
use codex_desktop_lib::types::{AppPreferences, CrashReportData};
use tempfile::TempDir;

// ============================================================================
// CONSENT_STATE 测试用的进程内互斥锁
// ============================================================================

/// 串行化所有读写全局 `CONSENT_STATE` 的测试。
///
/// 使用 `tokio::sync::Mutex`（而非 `std::sync::Mutex`），因为部分 consent
/// 测试是异步的（`#[tokio::test]`）。若将 `std::sync::MutexGuard` 跨 `.await`
/// 持有，会触发 `clippy::await_holding_lock` 警告，并可能导致多线程 runtime
/// 死锁。
static CONSENT_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ============================================================================

/// 创建 mock Tauri app 并返回其 handle 用于测试。
fn mock_app_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    app.handle().clone()
}

/// 辅助函数：构造一个用于测试的 `CrashReportData` 示例。
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
// read_crash_report (AppHandle) — 正向用例 (read-only)
// =========================================================================

#[tokio::test]
async fn read_crash_report_returns_none_when_no_file() {
    let handle = mock_app_handle();
    let result = read_crash_report_impl(handle).await.unwrap();
    assert!(result.is_none());
}

// =========================================================================
// delete_crash_report (AppHandle) — 正向用例 (read-only / idempotent)
// =========================================================================

#[tokio::test]
async fn delete_crash_report_succeeds_when_no_file() {
    let handle = mock_app_handle();
    let result = delete_crash_report_impl(handle).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn delete_crash_report_is_idempotent() {
    let handle = mock_app_handle();
    delete_crash_report_impl(handle.clone()).await.unwrap();
    let result = delete_crash_report_impl(handle).await;
    assert!(result.is_ok());
}

// =========================================================================
// init_consent_from_preferences (AppHandle) — 正向用例 (read-only)
// =========================================================================

#[test]
fn init_consent_with_no_preferences_file_defaults_to_unknown() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let handle = mock_app_handle();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_preferences(&handle);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

// =========================================================================
// CONSENT_STATE — 正向用例（无文件 I/O）
// =========================================================================

#[tokio::test]
async fn consent_state_default_is_zero() {
    let _guard = CONSENT_MUTEX.lock().await;
    CONSENT_STATE.store(0, Ordering::Relaxed);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn consent_state_can_be_set_to_granted() {
    let _guard = CONSENT_MUTEX.lock().await;
    CONSENT_STATE.store(1, Ordering::Relaxed);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);
    CONSENT_STATE.store(0, Ordering::Relaxed);
}

#[tokio::test]
async fn consent_state_can_be_set_to_denied() {
    let _guard = CONSENT_MUTEX.lock().await;
    CONSENT_STATE.store(2, Ordering::Relaxed);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 2);
    CONSENT_STATE.store(0, Ordering::Relaxed);
}

// =========================================================================
// CONSENT_STATE — 边界用例
// =========================================================================

#[tokio::test]
async fn consent_state_can_toggle_between_states() {
    let _guard = CONSENT_MUTEX.lock().await;
    CONSENT_STATE.store(1, Ordering::Relaxed);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);

    CONSENT_STATE.store(2, Ordering::Relaxed);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 2);

    CONSENT_STATE.store(0, Ordering::Relaxed);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

// =========================================================================
// persist_consent_to_path (TempDir) — 正向用例
// =========================================================================

#[test]
fn persist_consent_granted_writes_to_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    persist_consent_to_path(&path, Some(true)).unwrap();

    let contents = std::fs::read_to_string(&path).unwrap();
    let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
    assert_eq!(prefs.crash_reporting_consent, Some(true));
}

#[test]
fn persist_consent_denied_writes_to_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    persist_consent_to_path(&path, Some(false)).unwrap();

    let contents = std::fs::read_to_string(&path).unwrap();
    let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
    assert_eq!(prefs.crash_reporting_consent, Some(false));
}

#[test]
fn persist_consent_none_writes_to_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
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
fn persist_consent_creates_file_when_none_exists() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    // 此时文件尚不存在
    assert!(!path.exists());

    persist_consent_to_path(&path, Some(true)).unwrap();

    // 写入后文件应存在，包含默认偏好 + 同意状态
    assert!(path.exists());
    let contents = std::fs::read_to_string(&path).unwrap();
    let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
    assert_eq!(prefs.crash_reporting_consent, Some(true));
    // 其余字段应为默认值
    assert_eq!(prefs.theme, "system");
}

#[test]
fn persist_consent_overwrites_previous_consent() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    // 第一次写入：granted
    persist_consent_to_path(&path, Some(true)).unwrap();
    let prefs1: AppPreferences =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(prefs1.crash_reporting_consent, Some(true));

    // 第二次写入：denied
    persist_consent_to_path(&path, Some(false)).unwrap();
    let prefs2: AppPreferences =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(prefs2.crash_reporting_consent, Some(false));
}

#[test]
fn persist_consent_preserves_other_preferences_fields() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    // 先写入所有字段都设过值的偏好
    let original = AppPreferences {
        theme: "dark".to_string(),
        quick_pane_shortcut: Some("Ctrl+K".to_string()),
        language: Some("zh".to_string()),
        crash_reporting_consent: None,
    };
    let json = serde_json::to_string_pretty(&original).unwrap();
    std::fs::write(&path, &json).unwrap();

    // 持久化 consent —— 应保留其他字段不变
    persist_consent_to_path(&path, Some(true)).unwrap();

    let contents = std::fs::read_to_string(&path).unwrap();
    let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
    assert_eq!(prefs.crash_reporting_consent, Some(true));
    assert_eq!(prefs.theme, "dark");
    assert_eq!(prefs.quick_pane_shortcut.as_deref(), Some("Ctrl+K"));
    assert_eq!(prefs.language.as_deref(), Some("zh"));
}

// =========================================================================
// persist_consent_to_path — 异常用例
// =========================================================================

#[test]
fn persist_consent_handles_corrupted_existing_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    // 写入损坏的 JSON
    std::fs::write(&path, "not valid json").unwrap();

    // 不应 panic —— 回退到默认值
    persist_consent_to_path(&path, Some(true)).unwrap();

    let contents = std::fs::read_to_string(&path).unwrap();
    let prefs: AppPreferences = serde_json::from_str(&contents).unwrap();
    assert_eq!(prefs.crash_reporting_consent, Some(true));
    // 其余字段应为默认值（损坏的文件已被替换）
    assert_eq!(prefs.theme, "system");
}

#[test]
fn persist_consent_fails_when_parent_dir_does_not_exist() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let nested = dir.path().join("nested").join("subdir");
    let path = nested.join("preferences.json");

    let result = persist_consent_to_path(&path, Some(true));
    assert!(result.is_err());
}

// =========================================================================
// read_crash_report_from_path (TempDir) — 正向用例
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

// =========================================================================
// read_crash_report_from_path — 边界用例
// =========================================================================

#[test]
fn read_crash_report_returns_none_for_missing_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");

    let result = read_crash_report_from_path(&path).unwrap();
    assert!(result.is_none());
}

#[test]
fn read_crash_report_roundtrips_after_compact_write() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("crash-report.json");
    let data = sample_crash_report();
    let json = serde_json::to_string(&data).unwrap();
    std::fs::write(&path, json).unwrap();

    let loaded = read_crash_report_from_path(&path)
        .unwrap()
        .expect("expected Some(crash report)");
    assert_eq!(loaded.crash_type, data.crash_type);
    assert_eq!(loaded.message, data.message);
}

// =========================================================================
// read_crash_report_from_path — 异常用例
// =========================================================================

#[test]
fn read_crash_report_fails_on_invalid_json() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("crash-report.json");
    std::fs::write(&path, "not json").unwrap();

    let result = read_crash_report_from_path(&path);
    assert!(result.is_err());
}

#[test]
fn read_crash_report_fails_on_partial_json() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("crash-report.json");
    std::fs::write(&path, r#"{"crash_type":"panic","message":}"#).unwrap();

    let result = read_crash_report_from_path(&path);
    assert!(result.is_err());
}

// =========================================================================
// delete_crash_report_at_path (TempDir) — 正向用例
// =========================================================================

#[test]
fn delete_crash_report_removes_existing_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("crash-report.json");
    std::fs::write(&path, r#"{"crash_type":"panic"}"#).unwrap();

    assert!(path.exists());
    delete_crash_report_at_path(&path).unwrap();
    assert!(!path.exists());
}

// =========================================================================
// delete_crash_report_at_path — 边界用例
// =========================================================================

#[test]
fn delete_crash_report_is_idempotent_for_missing_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");

    // 文件不存在时也应成功（幂等）
    let result = delete_crash_report_at_path(&path);
    assert!(result.is_ok());
}

#[test]
fn delete_crash_report_can_delete_after_recreation() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("crash-report.json");

    // 创建 → 删除 → 再创建 → 再删除
    std::fs::write(&path, r#"{"crash_type":"panic"}"#).unwrap();
    delete_crash_report_at_path(&path).unwrap();
    assert!(!path.exists());

    std::fs::write(&path, r#"{"crash_type":"panic2"}"#).unwrap();
    delete_crash_report_at_path(&path).unwrap();
    assert!(!path.exists());
}

// =========================================================================
// init_consent_from_path (TempDir) — 正向用例
// =========================================================================

#[test]
fn init_consent_reads_granted_from_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs = AppPreferences {
        theme: "system".to_string(),
        quick_pane_shortcut: None,
        language: None,
        crash_reporting_consent: Some(true),
    };
    std::fs::write(&path, serde_json::to_string_pretty(&prefs).unwrap()).unwrap();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);

    CONSENT_STATE.store(0, Ordering::Relaxed);
}

#[test]
fn init_consent_reads_denied_from_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs = AppPreferences {
        theme: "system".to_string(),
        quick_pane_shortcut: None,
        language: None,
        crash_reporting_consent: Some(false),
    };
    std::fs::write(&path, serde_json::to_string_pretty(&prefs).unwrap()).unwrap();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 2);

    CONSENT_STATE.store(0, Ordering::Relaxed);
}

#[test]
fn init_consent_reads_none_from_file() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs = AppPreferences {
        theme: "system".to_string(),
        quick_pane_shortcut: None,
        language: None,
        crash_reporting_consent: None,
    };
    std::fs::write(&path, serde_json::to_string_pretty(&prefs).unwrap()).unwrap();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

// =========================================================================
// init_consent_from_path — 边界用例
// =========================================================================

#[test]
fn init_consent_with_missing_file_stays_at_default() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

// =========================================================================
// init_consent_from_path — 异常用例
// =========================================================================

#[test]
fn init_consent_with_corrupted_file_stays_at_default() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    std::fs::write(&path, "not valid json").unwrap();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

#[test]
fn init_consent_with_partial_json_stays_at_default() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    std::fs::write(&path, r#"{"theme":"dark","language":}"#).unwrap();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 0);
}

// =========================================================================
// persist_consent + init_consent roundtrip — 综合
// =========================================================================

#[test]
fn persist_then_init_consent_roundtrip_granted() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    // 持久化 consent 为 granted
    persist_consent_to_path(&path, Some(true)).unwrap();

    // 从已持久化的文件初始化 consent
    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 1);

    CONSENT_STATE.store(0, Ordering::Relaxed);
}

#[test]
fn persist_then_init_consent_roundtrip_denied() {
    let _guard = CONSENT_MUTEX.blocking_lock();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    persist_consent_to_path(&path, Some(false)).unwrap();

    CONSENT_STATE.store(0, Ordering::Relaxed);
    init_consent_from_path(&path);
    assert_eq!(CONSENT_STATE.load(Ordering::Relaxed), 2);

    CONSENT_STATE.store(0, Ordering::Relaxed);
}

//! 偏好设置 Tauri 命令的集成测试。
//!
//! 这些测试覆盖两个层级：
//!
//! 1. **基于 AppHandle 的只读测试** — 通过 `mock_builder()`
//!    （MockRuntime）验证路径解析。Mock 应用的 `app_data_dir()`
//!    解析为 `AppData\Roaming\`（空标识符），因此此处仅进行
//!    只读操作（无文件）是安全的。
//!
//! 2. **`_from_path` + TempDir 写入测试** — 使用隔离的
//!    `tempfile::TempDir` 目录测试纯文件 I/O 辅助函数
//!    （`save_preferences_to_path`、`load_preferences_from_path`）。
//!    这避免了在 `AppData\Roaming\` 根目录上写入文件时，
//!    因 Mock 应用空标识符导致所有文件写入共享 Roaming 根目录
//!    而出现的间歇性写入失败。

use codex_desktop_lib::commands::preferences::{
    greet, load_preferences_from_path, load_preferences_impl, load_quick_pane_shortcut_from_path,
    save_preferences_to_path,
};
use codex_desktop_lib::types::AppPreferences;
use tempfile::TempDir;

// ============================================================================

/// 创建一个 Mock Tauri 应用并返回其句柄用于测试。
///
/// 使用 `mock_builder()`（MockRuntime），它不需要在主线程上运行
/// Windows 事件循环。
fn mock_app_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    app.handle().clone()
}

// =========================================================================
// greet — 正向用例
// =========================================================================

#[test]
fn greet_returns_greeting_with_name() {
    let result = greet("World").unwrap();
    assert!(result.contains("World"));
}

#[test]
fn greet_returns_greeting_with_special_chars() {
    let result = greet("User_123").unwrap();
    assert!(result.contains("User_123"));
}

#[test]
fn greet_returns_greeting_with_unicode() {
    let result = greet("用户").unwrap();
    assert!(result.contains("用户"));
}

// =========================================================================
// greet — 边界用例
// =========================================================================

#[test]
fn greet_accepts_max_length_name() {
    let name = "a".repeat(100);
    let result = greet(&name).unwrap();
    assert!(result.contains(&name));
}

#[test]
fn greet_rejects_empty_name() {
    let result = greet("");
    assert!(result.is_err());
}

#[test]
fn greet_rejects_name_exceeding_max_length() {
    let name = "a".repeat(101);
    let result = greet(&name);
    assert!(result.is_err());
}

// =========================================================================
// greet — 异常用例
//
// validate_string_input 仅检查字符数量，不检查路径遍历或 null 字节。
// greet 是一个简单的问候函数，不需要路径安全性 — 它将名字格式化为字符串，
// 而非文件路径。这些测试验证 greet 正确接受异常但有效的输入。
// =========================================================================

#[test]
fn greet_accepts_name_with_slashes() {
    let result = greet("a/b/c").unwrap();
    assert!(result.contains("a/b/c"));
}

#[test]
fn greet_accepts_name_with_special_symbols() {
    let result = greet("user@domain!#").unwrap();
    assert!(result.contains("user@domain!#"));
}

// =========================================================================
// load_preferences (AppHandle) — 正向用例（只读）
// =========================================================================

#[tokio::test]
async fn load_preferences_returns_defaults_when_no_file() {
    let handle = mock_app_handle();
    let prefs = load_preferences_impl(handle).await.unwrap();
    assert_eq!(prefs.theme, "system");
    assert!(prefs.quick_pane_shortcut.is_none());
    assert!(prefs.language.is_none());
    assert_eq!(prefs.crash_reporting_consent, None);
}

// =========================================================================
// save/load_preferences_to_path (TempDir) — 正向用例
// =========================================================================

#[test]
fn save_and_load_preferences_roundtrip() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs = AppPreferences {
        theme: "dark".to_string(),
        quick_pane_shortcut: Some("Cmd+Shift+P".to_string()),
        language: Some("zh".to_string()),
        crash_reporting_consent: Some(true),
    };

    save_preferences_to_path(&path, &prefs).unwrap();
    let loaded = load_preferences_from_path(&path).unwrap();

    assert_eq!(loaded.theme, "dark");
    assert_eq!(loaded.quick_pane_shortcut.as_deref(), Some("Cmd+Shift+P"));
    assert_eq!(loaded.language.as_deref(), Some("zh"));
    assert_eq!(loaded.crash_reporting_consent, Some(true));
}

#[test]
fn save_preferences_multiple_times_overwrites() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs1 = AppPreferences {
        theme: "dark".to_string(),
        quick_pane_shortcut: Some("Ctrl+1".to_string()),
        language: Some("en".to_string()),
        crash_reporting_consent: Some(true),
    };
    save_preferences_to_path(&path, &prefs1).unwrap();

    let prefs2 = AppPreferences {
        theme: "light".to_string(),
        quick_pane_shortcut: Some("Ctrl+2".to_string()),
        language: Some("zh".to_string()),
        crash_reporting_consent: Some(false),
    };
    save_preferences_to_path(&path, &prefs2).unwrap();

    let loaded = load_preferences_from_path(&path).unwrap();
    assert_eq!(loaded.theme, "light");
    assert_eq!(loaded.quick_pane_shortcut.as_deref(), Some("Ctrl+2"));
    assert_eq!(loaded.language.as_deref(), Some("zh"));
    assert_eq!(loaded.crash_reporting_consent, Some(false));
}

#[test]
fn save_preferences_writes_valid_json_format() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs = AppPreferences {
        theme: "dark".to_string(),
        quick_pane_shortcut: Some("Cmd+Shift+P".to_string()),
        language: Some("en".to_string()),
        crash_reporting_consent: Some(true),
    };

    save_preferences_to_path(&path, &prefs).unwrap();

    let contents = std::fs::read_to_string(&path).unwrap();
    // 验证是有效的 JSON
    let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(parsed["theme"], "dark");
    assert_eq!(parsed["quick_pane_shortcut"], "Cmd+Shift+P");
    assert_eq!(parsed["language"], "en");
    assert_eq!(parsed["crash_reporting_consent"], true);
    // 验证是美化格式（包含换行符）
    assert!(contents.contains('\n'));
}

// =========================================================================
// load_preferences_from_path — 正向用例
// =========================================================================

#[test]
fn load_preferences_reads_valid_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    let json = r#"{"theme":"dark","quick_pane_shortcut":"CommandOrControl+Shift+Space","language":"en","crash_reporting_consent":true}"#;
    std::fs::write(&path, json).unwrap();

    let prefs = load_preferences_from_path(&path).unwrap();
    assert_eq!(prefs.theme, "dark");
    assert_eq!(
        prefs.quick_pane_shortcut.as_deref(),
        Some("CommandOrControl+Shift+Space")
    );
    assert_eq!(prefs.language.as_deref(), Some("en"));
    assert_eq!(prefs.crash_reporting_consent, Some(true));
}

// =========================================================================
// load_preferences_from_path — 边界用例
// =========================================================================

#[test]
fn load_preferences_returns_defaults_for_missing_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");

    let prefs = load_preferences_from_path(&path).unwrap();
    assert_eq!(prefs.theme, "system");
    assert!(prefs.quick_pane_shortcut.is_none());
    assert!(prefs.language.is_none());
    assert_eq!(prefs.crash_reporting_consent, None);
}

#[test]
fn load_preferences_handles_minimal_json() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    std::fs::write(&path, r#"{"theme":"light"}"#).unwrap();

    let prefs = load_preferences_from_path(&path).unwrap();
    assert_eq!(prefs.theme, "light");
    assert!(prefs.quick_pane_shortcut.is_none());
}

#[test]
fn load_preferences_handles_empty_object() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    std::fs::write(&path, "{}").unwrap();

    let prefs = load_preferences_from_path(&path).unwrap();
    assert_eq!(prefs.theme, "system");
}

#[test]
fn load_preferences_with_partial_data() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    let json = r#"{"theme":"dark","language":"zh"}"#;
    std::fs::write(&path, json).unwrap();

    let prefs = load_preferences_from_path(&path).unwrap();
    assert_eq!(prefs.theme, "dark");
    assert!(prefs.quick_pane_shortcut.is_none());
    assert_eq!(prefs.language.as_deref(), Some("zh"));
    assert_eq!(prefs.crash_reporting_consent, None);
}

// =========================================================================
// load_preferences_from_path — 异常用例
// =========================================================================

#[test]
fn load_preferences_fails_on_invalid_json() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    std::fs::write(&path, "not json").unwrap();

    let result = load_preferences_from_path(&path);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Failed to parse"));
}

#[test]
fn load_preferences_fails_on_partial_invalid_json() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    std::fs::write(&path, r#"{"theme":"dark","language":}"#).unwrap();

    let result = load_preferences_from_path(&path);
    assert!(result.is_err());
}

// =========================================================================
// save_preferences_to_path — 边界用例
// =========================================================================

#[test]
fn save_preferences_with_all_none_optional_fields() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let prefs = AppPreferences {
        theme: "system".to_string(),
        quick_pane_shortcut: None,
        language: None,
        crash_reporting_consent: None,
    };
    save_preferences_to_path(&path, &prefs).unwrap();

    let loaded = load_preferences_from_path(&path).unwrap();
    assert_eq!(loaded.theme, "system");
    assert!(loaded.quick_pane_shortcut.is_none());
    assert!(loaded.language.is_none());
    assert_eq!(loaded.crash_reporting_consent, None);
}

#[test]
fn save_preferences_fails_when_parent_dir_does_not_exist() {
    let dir = TempDir::new().unwrap();
    let nested = dir.path().join("nested").join("subdir");
    let path = nested.join("preferences.json");

    let prefs = AppPreferences::default();
    let result = save_preferences_to_path(&path, &prefs);
    assert!(result.is_err());
}

#[test]
fn save_preferences_does_not_leave_temp_file_on_success() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    save_preferences_to_path(&path, &AppPreferences::default()).unwrap();

    // 临时文件应已被重命名，故不应残留 .tmp 文件
    let temp_path = path.with_extension("tmp");
    assert!(!temp_path.exists());
    // 最终文件应存在
    assert!(path.exists());
}

// =========================================================================
// load_quick_pane_shortcut_from_path — 正向用例
// =========================================================================

#[test]
fn load_quick_pane_shortcut_returns_value_when_present() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    let json = r#"{"theme":"dark","quick_pane_shortcut":"Ctrl+Shift+Space"}"#;
    std::fs::write(&path, json).unwrap();

    let shortcut = load_quick_pane_shortcut_from_path(&path);
    assert_eq!(shortcut.as_deref(), Some("Ctrl+Shift+Space"));
}

#[test]
fn load_quick_pane_shortcut_returns_none_when_absent() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    let json = r#"{"theme":"dark"}"#;
    std::fs::write(&path, json).unwrap();

    let shortcut = load_quick_pane_shortcut_from_path(&path);
    assert!(shortcut.is_none());
}

// =========================================================================
// load_quick_pane_shortcut_from_path — 边界用例
// =========================================================================

#[test]
fn load_quick_pane_shortcut_returns_none_for_missing_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");

    let shortcut = load_quick_pane_shortcut_from_path(&path);
    assert!(shortcut.is_none());
}

#[test]
fn load_quick_pane_shortcut_returns_none_for_corrupted_json() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");
    std::fs::write(&path, "not valid json").unwrap();

    let shortcut = load_quick_pane_shortcut_from_path(&path);
    assert!(shortcut.is_none());
}

// =========================================================================
// save/load roundtrip — 综合
// =========================================================================

#[test]
fn full_roundtrip_preserves_all_fields() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("preferences.json");

    let original = AppPreferences {
        theme: "light".to_string(),
        quick_pane_shortcut: Some("Ctrl+K".to_string()),
        language: Some("fr".to_string()),
        crash_reporting_consent: Some(false),
    };

    save_preferences_to_path(&path, &original).unwrap();
    let loaded = load_preferences_from_path(&path).unwrap();

    assert_eq!(loaded.theme, original.theme);
    assert_eq!(loaded.quick_pane_shortcut, original.quick_pane_shortcut);
    assert_eq!(loaded.language, original.language);
    assert_eq!(
        loaded.crash_reporting_consent,
        original.crash_reporting_consent
    );
}

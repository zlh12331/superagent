//! 处理平台特定行为的跨平台工具。
//!
//! 这些工具提供给基于此模板构建的应用使用。
//! 模板自身可能未使用它们。
//!
//! 本模块提供在 Tauri 应用中编写跨平台 Rust 代码的工具。
//! 使用条件编译（`#[cfg(target_os = "...")]`）处理平台特定行为。
//!
//! # 示例
//!
//! ```ignore
//! use crate::utils::platform;
//!
//! // 将 Windows 路径规范化为正斜杠，便于前端处理
//! let normalized = platform::normalize_path_for_serialization(&some_path);
//!
//! // 使用 cfg 实现平台特定行为
//! #[cfg(target_os = "macos")]
//! fn macos_specific() {
//!     // macOS 专属代码
//! }
//!
//! #[cfg(target_os = "windows")]
//! fn windows_specific() {
//!     // Windows 专属代码
//! }
//!
//! #[cfg(target_os = "linux")]
//! fn linux_specific() {
//!     // Linux 专属代码
//! }
//! ```

// 允许未使用代码——这些工具供基于此模板构建的应用使用
#![allow(dead_code)]

use std::path::Path;

/// 将路径规范化为使用正斜杠，便于前端统一处理。
///
/// Windows 路径如 `C:\Users\foo\bar.txt` 会变为 `C:/Users/foo/bar.txt`。
/// 在向 React 前端发送路径时很有用，前端无论在哪个平台都期望正斜杠。
///
/// 在 macOS 和 Linux 上，路径已使用正斜杠，因此这实际上是空操作，
/// 但确保了一致性。
///
/// # 示例
///
/// ```ignore
/// use std::path::Path;
/// use crate::utils::platform::normalize_path_for_serialization;
///
/// let path = Path::new("some/path/file.txt");
/// let normalized = normalize_path_for_serialization(path);
/// assert_eq!(normalized, "some/path/file.txt");
/// ```
pub fn normalize_path_for_serialization(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

/// 如果运行在 macOS 上则返回 true。
///
/// 用于运行时检查。编译时检查请使用 `#[cfg(target_os = "macos")]`。
#[inline]
pub const fn is_macos() -> bool {
    cfg!(target_os = "macos")
}

/// 如果运行在 Windows 上则返回 true。
///
/// 用于运行时检查。编译时检查请使用 `#[cfg(target_os = "windows")]`。
#[inline]
pub const fn is_windows() -> bool {
    cfg!(target_os = "windows")
}

/// 如果运行在 Linux 上则返回 true。
///
/// 用于运行时检查。编译时检查请使用 `#[cfg(target_os = "linux")]`。
#[inline]
pub const fn is_linux() -> bool {
    cfg!(target_os = "linux")
}

/// 以字符串形式返回当前平台（"macos"、"windows" 或 "linux"）。
///
/// 当需要在不使用 OS 插件的情况下将平台信息传给前端时很有用。
pub const fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_normalize_path_forward_slashes() {
        let path = PathBuf::from("foo/bar/baz.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "foo/bar/baz.txt");
    }

    #[test]
    fn test_normalize_path_empty() {
        let path = PathBuf::from("");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "");
    }

    #[test]
    fn test_current_platform_is_valid() {
        let platform = current_platform();
        assert!(
            platform == "macos" || platform == "windows" || platform == "linux",
            "Platform should be one of: macos, windows, linux"
        );
    }

    #[test]
    fn test_platform_detection_consistency() {
        // 这些当中只有一个应为 true
        let platforms = [is_macos(), is_windows(), is_linux()];
        let count = platforms.iter().filter(|&&x| x).count();
        assert_eq!(count, 1, "Exactly one platform should be detected");
    }

    // =========================================================================
    // normalize_path_for_serialization — 正向用例补充
    // =========================================================================

    #[test]
    fn normalize_windows_style_path_converts_backslashes() {
        let path = PathBuf::from(r"C:\Users\test\file.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "C:/Users/test/file.txt");
    }

    #[test]
    fn normalize_mixed_slashes_and_backslashes() {
        let path = PathBuf::from(r"foo\bar/baz\qux.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "foo/bar/baz/qux.txt");
    }

    #[test]
    fn normalize_path_with_multiple_consecutive_backslashes() {
        let path = PathBuf::from(r"foo\\bar\\\baz.txt");
        let normalized = normalize_path_for_serialization(&path);
        // 每个反斜杠被单独替换
        assert_eq!(normalized, "foo//bar///baz.txt");
    }

    #[test]
    fn normalize_path_with_only_backslashes() {
        let path = PathBuf::from(r"\\\\");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "////");
    }

    #[test]
    fn normalize_single_backslash() {
        let path = PathBuf::from(r"\");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "/");
    }

    #[test]
    fn normalize_path_root() {
        let path = PathBuf::from("/");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "/");
    }

    #[test]
    fn normalize_path_with_trailing_slash() {
        let path = PathBuf::from("foo/bar/");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "foo/bar/");
    }

    #[test]
    fn normalize_path_with_trailing_backslash() {
        let path = PathBuf::from(r"foo\bar\");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "foo/bar/");
    }

    #[test]
    fn normalize_path_single_file() {
        let path = PathBuf::from("file.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "file.txt");
    }

    #[test]
    fn normalize_path_with_dot_segment() {
        let path = PathBuf::from("./foo/bar.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "./foo/bar.txt");
    }

    #[test]
    fn normalize_path_with_double_dot_segment() {
        let path = PathBuf::from("../foo/bar.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "../foo/bar.txt");
    }

    #[test]
    fn normalize_path_with_unicode_chars() {
        let path = PathBuf::from("文件夹/文件.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "文件夹/文件.txt");
    }

    // =========================================================================
    // normalize_path_for_serialization — 边界用例
    // =========================================================================

    #[test]
    fn normalize_path_with_space_in_name() {
        let path = PathBuf::from("my folder/my file.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "my folder/my file.txt");
    }

    #[test]
    fn normalize_path_with_special_chars() {
        let path = PathBuf::from("foo@bar/baz#qux.txt");
        let normalized = normalize_path_for_serialization(&path);
        assert_eq!(normalized, "foo@bar/baz#qux.txt");
    }

    // =========================================================================
    // is_macos / is_windows / is_linux — 正向用例
    // =========================================================================

    #[test]
    fn is_windows_returns_true_on_windows() {
        // 此测试在 Windows 上运行，因此 is_windows() 应返回 true
        assert!(is_windows(), "is_windows() should be true on Windows");
    }

    #[test]
    fn is_macos_returns_false_on_windows() {
        // 此测试在 Windows 上运行，因此 is_macos() 应返回 false
        assert!(!is_macos(), "is_macos() should be false on Windows");
    }

    #[test]
    fn is_linux_returns_false_on_windows() {
        // 此测试在 Windows 上运行，因此 is_linux() 应返回 false
        assert!(!is_linux(), "is_linux() should be false on Windows");
    }

    // =========================================================================
    // current_platform — 正向用例
    // =========================================================================

    #[test]
    fn current_platform_returns_windows_on_windows() {
        assert_eq!(current_platform(), "windows");
    }

    #[test]
    fn current_platform_matches_is_windows_flag() {
        // current_platform() 与 is_windows() 应保持一致
        if is_windows() {
            assert_eq!(current_platform(), "windows");
        } else if is_macos() {
            assert_eq!(current_platform(), "macos");
        } else {
            assert_eq!(current_platform(), "linux");
        }
    }
}

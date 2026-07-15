//! 项目根目录标记（project root markers）的读取与默认值。
//!
//! 本模块从合并后的 `config.toml` 中读取 `project_root_markers` 字段，
//! 用于在文件系统向上查找时识别项目根目录（默认检测 `.git` 目录）。

use std::io;

use toml::Value as TomlValue;

/// 默认的项目根目录标记列表。
const DEFAULT_PROJECT_ROOT_MARKERS: &[&str] = &[".git"];

/// 从合并后的 `config.toml`（`toml::Value`）中读取 `project_root_markers`。
///
/// 不变量：
/// - 若未指定 `project_root_markers`，返回 `Ok(None)`。
/// - 若指定了 `project_root_markers`，返回 `Ok(Some(markers))`，
///   其中 `markers` 是 `Vec<String>`
///   （包括空数组返回 `Ok(Some(Vec::new()))`，表示禁用根检测）。
/// - 若 `project_root_markers` 指定但不是字符串数组，返回错误。
///
/// # Errors
/// 当 `project_root_markers` 存在但不是字符串数组时返回 `io::Error`
/// （`InvalidData`）。
pub fn project_root_markers_from_config(config: &TomlValue) -> io::Result<Option<Vec<String>>> {
    let Some(table) = config.as_table() else {
        return Ok(None);
    };
    let Some(markers_value) = table.get("project_root_markers") else {
        return Ok(None);
    };
    let TomlValue::Array(entries) = markers_value else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "project_root_markers must be an array of strings",
        ));
    };
    if entries.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let mut markers = Vec::new();
    for entry in entries {
        let Some(marker) = entry.as_str() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "project_root_markers must be an array of strings",
            ));
        };
        markers.push(marker.to_string());
    }
    Ok(Some(markers))
}

/// 返回默认的项目根目录标记列表（当前为 `[".git"]`）。
pub fn default_project_root_markers() -> Vec<String> {
    DEFAULT_PROJECT_ROOT_MARKERS
        .iter()
        .map(ToString::to_string)
        .collect()
}

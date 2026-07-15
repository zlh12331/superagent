//! 严格配置校验，基于 serde 的 ignored-field 追踪能力实现。
//!
//! 本模块用于检测用户配置文件中的未知字段，提供比 serde 默认行为更友好的
//! 错误诊断。核心流程：
//! 1. 使用 `serde_ignored` 包装反序列化过程，收集被忽略的字段路径
//! 2. 使用 `serde_path_to_error` 捕获反序列化错误的精确路径
//! 3. 单独扫描 `[features]` 表以检测未知 feature key
//! 4. 将所有错误转换为带行号、列号范围的 `ConfigError`，便于 IDE 高亮
//!
//! 当 `strict_config` 开启时，任何未知字段都会导致配置加载失败；
//! 关闭时未知字段被静默忽略以保持向前兼容。

use crate::diagnostics::ConfigDiagnosticSource;
use crate::diagnostics::ConfigError;
use crate::diagnostics::config_error_from_toml_for_source;
use crate::diagnostics::default_range;
use crate::diagnostics::span_for_config_path;
use crate::diagnostics::span_for_toml_key_path;
use crate::diagnostics::text_range_from_span;
use codex_features::is_known_feature_key;
use serde::de::DeserializeOwned;
use std::path::Path;
use toml::Value as TomlValue;

/// 从 TOML 文件内容中检测未知字段并返回首个 `ConfigError`。
///
/// 先将 `contents` 解析为 `TomlValue`，再委托
/// [`config_error_from_ignored_toml_value_fields`] 进行字段检测。
/// 若 TOML 解析失败，则返回对应的解析错误。
///
/// # 参数
/// - `path`: 配置文件路径，仅用于错误诊断中的来源标识
/// - `contents`: 配置文件的原始文本内容
///
/// # 返回值
/// - `Some(ConfigError)`: 存在未知字段或解析错误
/// - `None`: 配置完全合法，无未知字段
pub fn config_error_from_ignored_toml_fields<T: DeserializeOwned>(
    path: impl AsRef<Path>,
    contents: &str,
) -> Option<ConfigError> {
    let source = ConfigDiagnosticSource::Path(path.as_ref());
    match toml::from_str::<TomlValue>(contents) {
        Ok(value) => {
            config_error_from_ignored_toml_value_fields_for_source::<T>(source, contents, value)
        }
        Err(err) => Some(config_error_from_toml_for_source(source, contents, err)),
    }
}

/// 从已解析的 `TomlValue` 中检测未知字段（带文件路径来源）。
///
/// 与 [`config_error_from_ignored_toml_value_fields_for_source`] 的区别仅在于
/// 来源使用 `Path` 而非显示名称，适用于大多数磁盘文件场景。
pub(crate) fn config_error_from_ignored_toml_value_fields<T: DeserializeOwned>(
    path: impl AsRef<Path>,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError> {
    config_error_from_ignored_toml_value_fields_for_source::<T>(
        ConfigDiagnosticSource::Path(path.as_ref()),
        contents,
        value,
    )
}

/// 从已解析的 `TomlValue` 中检测未知字段（带显示名称来源）。
///
/// 适用于非文件来源的配置（如 MDM payload、内联字符串），使用人类可读的
/// `source_name` 作为错误来源标识。
pub(crate) fn config_error_from_ignored_toml_value_fields_for_source_name<T: DeserializeOwned>(
    source_name: &str,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError> {
    config_error_from_ignored_toml_value_fields_for_source::<T>(
        ConfigDiagnosticSource::DisplayName(source_name),
        contents,
        value,
    )
}

/// 未知字段检测的核心实现，统一处理任意 `ConfigDiagnosticSource`。
///
/// 工作流程：
/// 1. 扫描 `[features]` 表收集未知 feature key 路径
/// 2. 使用 `serde_ignored::Deserializer` 包装原值，捕获被 serde 忽略的字段
/// 3. 使用 `serde_path_to_error::deserialize` 在反序列化时记录错误路径
/// 4. 若反序列化成功，检查 ignored 与 unknown feature 路径
/// 5. 若反序列化失败，构造带文本范围的 `ConfigError`
fn config_error_from_ignored_toml_value_fields_for_source<T: DeserializeOwned>(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    value: TomlValue,
) -> Option<ConfigError> {
    // 先扫描 `[features]` 表，单独检测未知 feature key。
    // 这样即使 serde 反序列化未忽略这些字段（例如使用了 flatten），
    // 仍然能给用户提供准确的错误提示。
    let unknown_feature_paths = unknown_feature_toml_value_path(&value);
    let mut ignored_paths = Vec::new();
    let mut ignored_callback = |ignored_path: serde_ignored::Path<'_>| {
        let path_segments = ignored_path_segments(&ignored_path);
        if !path_segments.is_empty() {
            ignored_paths.push(path_segments);
        }
    };
    let deserializer = serde_ignored::Deserializer::new(value, &mut ignored_callback);
    let result: Result<T, _> = serde_path_to_error::deserialize(deserializer);

    match result {
        Ok(_) => unknown_field_error_from_paths(source, contents, ignored_paths)
            .or_else(|| unknown_field_error_from_paths(source, contents, unknown_feature_paths)),
        Err(err) => {
            // 反序列化失败：提取 serde_path_to_error 记录的路径提示，
            // 优先使用该路径对应的 span；若不存在则回退到 toml 错误自带的 span；
            // 都没有时使用全文本范围作为兜底。
            let path_hint = err.path().clone();
            let toml_err = err.into_inner();
            let range = span_for_config_path(contents, &path_hint)
                .or_else(|| toml_err.span())
                .map(|span| text_range_from_span(contents, span))
                .unwrap_or_else(default_range);
            Some(ConfigError::new(
                source.to_path_buf(),
                range,
                toml_err.message(),
            ))
        }
    }
}

/// 返回首个被忽略字段的点分路径字符串（如 `profiles.x.unknown_field`）。
///
/// 用于在不构造完整 `ConfigError` 的情况下快速判断是否存在未知字段。
/// 反序列化失败时返回 `None`。
pub(crate) fn ignored_toml_value_field<T: DeserializeOwned>(value: TomlValue) -> Option<String> {
    let mut ignored_paths = Vec::new();
    let result: Result<T, _> = serde_ignored::deserialize(value, |ignored_path| {
        let path_segments = ignored_path_segments(&ignored_path);
        if !path_segments.is_empty() {
            ignored_paths.push(path_segments);
        }
    });
    if result.is_err() {
        return None;
    }

    ignored_paths
        .into_iter()
        .next()
        .map(|path_segments| path_segments.join("."))
}

/// 返回首个未知 feature key 的点分路径字符串。
///
/// 仅扫描顶层 `[features]` 与 `[profiles.<name>.features]` 表，
/// 不进行 serde 反序列化，因此可在任意阶段调用。
pub(crate) fn unknown_feature_toml_value_field(value: &TomlValue) -> Option<String> {
    unknown_feature_toml_value_path(value)
        .into_iter()
        .next()
        .map(|path_segments| path_segments.join("."))
}

/// 将一组被忽略字段路径转换为 `ConfigError`，取首个路径作为错误位置。
///
/// 若 `ignored_paths` 为空，返回 `None` 表示无未知字段。
fn unknown_field_error_from_paths(
    source: ConfigDiagnosticSource<'_>,
    contents: &str,
    ignored_paths: Vec<Vec<String>>,
) -> Option<ConfigError> {
    let path_segments = ignored_paths.into_iter().next()?;
    let ignored_path = path_segments.join(".");
    let range = span_for_toml_key_path(contents, &path_segments)
        .map(|span| text_range_from_span(contents, span))
        .unwrap_or_else(default_range);
    Some(ConfigError::new(
        source.to_path_buf(),
        range,
        format!("unknown configuration field `{ignored_path}`"),
    ))
}

/// 扫描 TOML 值中的所有未知 feature key 路径。
///
/// 检查两个位置：
/// 1. 顶层 `[features]` 表
/// 2. `[profiles.<name>.features]` 表（每个 profile 单独检查）
///
/// 返回的路径段列表可直接用于 `span_for_toml_key_path` 定位文本范围。
fn unknown_feature_toml_value_path(value: &TomlValue) -> Vec<Vec<String>> {
    let Some(root) = value.as_table() else {
        return Vec::new();
    };

    let mut paths = Vec::new();
    push_unknown_feature_paths(&mut paths, &["features"], root.get("features"));

    if let Some(profiles) = root.get("profiles").and_then(TomlValue::as_table) {
        for (profile_name, profile) in profiles {
            let prefix = ["profiles", profile_name.as_str(), "features"];
            let features = profile
                .as_table()
                .and_then(|profile| profile.get("features"));
            push_unknown_feature_paths(&mut paths, &prefix, features);
        }
    }

    paths
}

/// 将一个 `[features]` 表中的未知 feature key 路径追加到 `paths`。
///
/// `prefix` 是该 features 表在 TOML 中的完整路径前缀
/// （如 `["features"]` 或 `["profiles", "work", "features"]`）。
/// 通过 `is_known_feature_key` 判断 key 是否已知。
fn push_unknown_feature_paths(
    paths: &mut Vec<Vec<String>>,
    prefix: &[&str],
    features: Option<&TomlValue>,
) {
    let Some(features) = features.and_then(TomlValue::as_table) else {
        return;
    };

    for feature_key in features
        .keys()
        .map(String::as_str)
        .filter(|key| !is_known_feature_key(key))
    {
        let mut path = prefix
            .iter()
            .map(|segment| (*segment).to_string())
            .collect::<Vec<_>>();
        path.push(feature_key.to_string());
        paths.push(path);
    }
}

/// 将 `serde_ignored::Path` 递归转换为字符串段列表。
///
/// 例如 `Path::Map { parent: Root, key: "foo" }` 转换为 `["foo"]`，
/// `Path::Seq { parent: Map{Root, "bar"}, index: 0 }` 转换为 `["bar", "0"]`。
fn ignored_path_segments(path: &serde_ignored::Path<'_>) -> Vec<String> {
    let mut segments = Vec::new();
    push_ignored_path_segments(path, &mut segments);
    segments
}

/// `ignored_path_segments` 的递归辅助函数，按从根到叶的顺序追加段。
fn push_ignored_path_segments(path: &serde_ignored::Path<'_>, segments: &mut Vec<String>) {
    match path {
        serde_ignored::Path::Root => {}
        serde_ignored::Path::Seq { parent, index } => {
            push_ignored_path_segments(parent, segments);
            segments.push(index.to_string());
        }
        serde_ignored::Path::Map { parent, key } => {
            push_ignored_path_segments(parent, segments);
            segments.push(key.clone());
        }
        serde_ignored::Path::Some { parent }
        | serde_ignored::Path::NewtypeStruct { parent }
        | serde_ignored::Path::NewtypeVariant { parent } => {
            push_ignored_path_segments(parent, segments);
        }
    }
}

#[cfg(test)]
#[path = "strict_config_tests.rs"]
mod tests;

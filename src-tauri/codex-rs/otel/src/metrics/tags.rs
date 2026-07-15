//! Metrics 标签（tag）常量与会话级标签组装。
//!
//! 定义了常用的低基数标签键名，以及 [`SessionMetricTagValues`] 用于
//! 将会话级 metadata 组装为有序的标签切片。

use crate::metrics::Result;
use crate::metrics::validation::validate_tag_key;
use crate::metrics::validation::validate_tag_value;
use codex_utils_string::sanitize_metric_tag_value;

/// 应用版本标签键。
pub const APP_VERSION_TAG: &str = "app.version";
/// 认证模式标签键。
pub const AUTH_MODE_TAG: &str = "auth_mode";
/// 模型名标签键。
pub const MODEL_TAG: &str = "model";
/// 发起方（originator）标签键。
pub const ORIGINATOR_TAG: &str = "originator";
/// 服务名标签键。
pub const SERVICE_NAME_TAG: &str = "service_name";
/// 会话来源标签键。
pub const SESSION_SOURCE_TAG: &str = "session_source";

/// 未知 originator 的兜底标签值。
const OTHER_ORIGINATOR_TAG_VALUE: &str = "other";
/// 已知的低基数 originator 标签值白名单。
const KNOWN_ORIGINATOR_TAG_VALUES: &[&str] = &[
    "codex_desktop",
    "codex-app-server",
    "codex_mcp_server",
    "codex_cli_rs",
    "codex-tui",
    "codex_vscode",
    "none",
    "codex_exec",
    "codex-cli",
    "codex_sdk_ts",
    "codex-app-server-sdk",
];

/// 返回已知的低基数 originator 标签值；未知值统一归为 `other`。
pub fn bounded_originator_tag_value(originator: &str) -> &'static str {
    let sanitized = sanitize_metric_tag_value(originator);
    KNOWN_ORIGINATOR_TAG_VALUES
        .iter()
        .copied()
        .find(|known| *known == sanitized.as_str())
        .unwrap_or(OTHER_ORIGINATOR_TAG_VALUE)
}

/// 会话级 metrics 标签值集合，用于统一组装标签切片。
pub struct SessionMetricTagValues<'a> {
    /// 认证模式（可选）。
    pub auth_mode: Option<&'a str>,
    /// 会话来源。
    pub session_source: &'a str,
    /// 发起方。
    pub originator: &'a str,
    /// 服务名（可选）。
    pub service_name: Option<&'a str>,
    /// 模型名。
    pub model: &'a str,
    /// 应用版本。
    pub app_version: &'a str,
}

impl<'a> SessionMetricTagValues<'a> {
    /// 将会话级标签值组装为有序的 `(&'static str, &str)` 标签切片。
    pub fn into_tags(self) -> Result<Vec<(&'static str, &'a str)>> {
        let mut tags = Vec::with_capacity(6);
        Self::push_optional_tag(&mut tags, AUTH_MODE_TAG, self.auth_mode)?;
        Self::push_optional_tag(&mut tags, SESSION_SOURCE_TAG, Some(self.session_source))?;
        Self::push_optional_tag(&mut tags, ORIGINATOR_TAG, Some(self.originator))?;
        Self::push_optional_tag(&mut tags, SERVICE_NAME_TAG, self.service_name)?;
        Self::push_optional_tag(&mut tags, MODEL_TAG, Some(self.model))?;
        Self::push_optional_tag(&mut tags, APP_VERSION_TAG, Some(self.app_version))?;
        Ok(tags)
    }

    /// 将一个可选标签值校验后推入标签向量（值为 `None` 时跳过）。
    fn push_optional_tag(
        tags: &mut Vec<(&'static str, &'a str)>,
        key: &'static str,
        value: Option<&'a str>,
    ) -> Result<()> {
        let Some(value) = value else {
            return Ok(());
        };
        validate_tag_key(key)?;
        validate_tag_value(value)?;
        tags.push((key, value));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::APP_VERSION_TAG;
    use super::AUTH_MODE_TAG;
    use super::MODEL_TAG;
    use super::ORIGINATOR_TAG;
    use super::SERVICE_NAME_TAG;
    use super::SESSION_SOURCE_TAG;
    use super::SessionMetricTagValues;
    use pretty_assertions::assert_eq;

    #[test]
    fn session_metric_tags_include_expected_tags_in_order() {
        let tags = SessionMetricTagValues {
            auth_mode: Some("api_key"),
            session_source: "cli",
            originator: "codex_cli",
            service_name: Some("desktop_app"),
            model: "gpt-5.1",
            app_version: "1.2.3",
        }
        .into_tags()
        .expect("tags");

        assert_eq!(
            tags,
            vec![
                (AUTH_MODE_TAG, "api_key"),
                (SESSION_SOURCE_TAG, "cli"),
                (ORIGINATOR_TAG, "codex_cli"),
                (SERVICE_NAME_TAG, "desktop_app"),
                (MODEL_TAG, "gpt-5.1"),
                (APP_VERSION_TAG, "1.2.3"),
            ]
        );
    }

    #[test]
    fn session_metric_tags_skip_missing_optional_tags() {
        let tags = SessionMetricTagValues {
            auth_mode: None,
            session_source: "exec",
            originator: "codex_exec",
            service_name: None,
            model: "gpt-5.1",
            app_version: "1.2.3",
        }
        .into_tags()
        .expect("tags");

        assert_eq!(
            tags,
            vec![
                (SESSION_SOURCE_TAG, "exec"),
                (ORIGINATOR_TAG, "codex_exec"),
                (MODEL_TAG, "gpt-5.1"),
                (APP_VERSION_TAG, "1.2.3"),
            ]
        );
    }
}

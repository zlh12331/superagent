//! Metrics 指标名与标签的合法性校验。
//!
//! 在指标记录前校验名称、标签键值是否符合 OTEL 字符集要求，
//! 避免非法字符导致 exporter 拒绝或指标聚合异常。

use crate::metrics::error::MetricsError;
use crate::metrics::error::Result;
use std::collections::BTreeMap;

/// 校验标签集合中的所有键值是否合法。
pub(crate) fn validate_tags(tags: &BTreeMap<String, String>) -> Result<()> {
    for (key, value) in tags {
        validate_tag_key(key)?;
        validate_tag_value(value)?;
    }
    Ok(())
}

/// 校验指标名称是否非空且仅包含合法字符。
pub(crate) fn validate_metric_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(MetricsError::EmptyMetricName);
    }
    if !name.chars().all(is_metric_char) {
        return Err(MetricsError::InvalidMetricName {
            name: name.to_string(),
        });
    }
    Ok(())
}

/// 校验标签键是否合法。
pub(crate) fn validate_tag_key(key: &str) -> Result<()> {
    validate_tag_component(key, "tag key")?;
    Ok(())
}

/// 校验标签值是否合法。
pub(crate) fn validate_tag_value(value: &str) -> Result<()> {
    validate_tag_component(value, "tag value")
}

/// 校验单个标签组件（键或值）的通用逻辑。
fn validate_tag_component(value: &str, label: &str) -> Result<()> {
    if value.is_empty() {
        return Err(MetricsError::EmptyTagComponent {
            label: label.to_string(),
        });
    }
    if !value.chars().all(is_tag_char) {
        return Err(MetricsError::InvalidTagComponent {
            label: label.to_string(),
            value: value.to_string(),
        });
    }
    Ok(())
}

/// 判断字符是否为合法的指标名字符。
fn is_metric_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// 判断字符是否为合法的标签字符。
fn is_tag_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/')
}

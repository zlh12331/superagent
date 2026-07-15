//! Metrics 客户端配置。
//!
//! 定义 [`MetricsConfig`] 与 [`MetricsExporter`]，用于描述 metrics 客户端
//! 构建时所需的运行环境、服务信息、exporter 类型与默认标签等参数。

use crate::config::OtelExporter;
use crate::metrics::Result;
use crate::metrics::validation::validate_tag_key;
use crate::metrics::validation::validate_tag_value;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use std::collections::BTreeMap;
use std::time::Duration;

/// Metrics exporter 类型，支持 OTLP 与内存（测试用）两种。
#[derive(Clone, Debug)]
pub enum MetricsExporter {
    /// OTLP exporter。
    Otlp(OtelExporter),
    /// 内存 exporter（仅用于测试）。
    InMemory(InMemoryMetricExporter),
}

/// Metrics 客户端构建配置。
#[derive(Clone, Debug)]
pub struct MetricsConfig {
    /// 运行环境标识。
    pub(crate) environment: String,
    /// 服务名。
    pub(crate) service_name: String,
    /// 服务版本号。
    pub(crate) service_version: String,
    /// exporter 类型。
    pub(crate) exporter: MetricsExporter,
    /// 周期性导出间隔（可选）。
    pub(crate) export_interval: Option<Duration>,
    /// 是否启用手动 reader 用于按需运行时快照。
    pub(crate) runtime_reader: bool,
    /// 附加到每个指标的默认标签。
    pub(crate) default_tags: BTreeMap<String, String>,
}

impl MetricsConfig {
    /// 创建一个使用 OTLP exporter 的配置。
    pub fn otlp(
        environment: impl Into<String>,
        service_name: impl Into<String>,
        service_version: impl Into<String>,
        exporter: OtelExporter,
    ) -> Self {
        Self {
            environment: environment.into(),
            service_name: service_name.into(),
            service_version: service_version.into(),
            exporter: MetricsExporter::Otlp(exporter),
            export_interval: None,
            runtime_reader: false,
            default_tags: BTreeMap::new(),
        }
    }

    /// 创建一个使用内存 exporter 的配置（用于测试）。
    pub fn in_memory(
        environment: impl Into<String>,
        service_name: impl Into<String>,
        service_version: impl Into<String>,
        exporter: InMemoryMetricExporter,
    ) -> Self {
        Self {
            environment: environment.into(),
            service_name: service_name.into(),
            service_version: service_version.into(),
            exporter: MetricsExporter::InMemory(exporter),
            export_interval: None,
            runtime_reader: false,
            default_tags: BTreeMap::new(),
        }
    }

    /// 设置周期性导出间隔。
    pub fn with_export_interval(mut self, interval: Duration) -> Self {
        self.export_interval = Some(interval);
        self
    }

    /// 启用手动 reader，支持按需获取运行时快照。
    pub fn with_runtime_reader(mut self) -> Self {
        self.runtime_reader = true;
        self
    }

    /// 添加一个将附加到每个指标的默认标签。
    pub fn with_tag(mut self, key: impl Into<String>, value: impl Into<String>) -> Result<Self> {
        let key = key.into();
        let value = value.into();
        validate_tag_key(&key)?;
        validate_tag_value(&value)?;
        self.default_tags.insert(key, value);
        Ok(self)
    }
}

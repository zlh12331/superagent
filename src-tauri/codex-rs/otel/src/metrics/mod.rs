//! OTEL metrics 客户端与全局状态管理。
//!
//! 提供 [`MetricsClient`] 的构建、全局安装与访问，以及 metrics exporter
//! 配置（[`MetricsConfig`]）、指标名称常量、标签处理、计时器等基础设施。

mod client;
mod config;
mod error;
pub(crate) mod names;
mod process;
pub(crate) mod runtime_metrics;
pub(crate) mod tags;
pub(crate) mod timer;
pub(crate) mod validation;

use crate::config::StatsigMetricsSettings;
pub use crate::metrics::client::MetricsClient;
pub use crate::metrics::config::MetricsConfig;
pub use crate::metrics::config::MetricsExporter;
pub use crate::metrics::error::MetricsError;
pub use crate::metrics::error::Result;
pub use crate::metrics::process::record_process_start_once;
pub use names::*;
use std::sync::OnceLock;
pub use tags::ORIGINATOR_TAG;
pub use tags::SessionMetricTagValues;
pub use tags::bounded_originator_tag_value;

static GLOBAL_METRICS: OnceLock<MetricsClient> = OnceLock::new();
static GLOBAL_STATSIG_METRICS_SETTINGS: OnceLock<StatsigMetricsSettings> = OnceLock::new();

/// 安装全局 metrics 客户端，后续可通过 [`global`] 获取。
pub(crate) fn install_global(metrics: MetricsClient) {
    let _ = GLOBAL_METRICS.set(metrics);
}

/// 返回全局安装的 metrics 客户端（若已安装）。
pub fn global() -> Option<MetricsClient> {
    GLOBAL_METRICS.get().cloned()
}

/// 安装全局 Statsig metrics 配置，供后续通过 [`global_statsig_settings`] 获取。
pub(crate) fn install_global_statsig_settings(settings: StatsigMetricsSettings) {
    let _ = GLOBAL_STATSIG_METRICS_SETTINGS.set(settings);
}

/// 返回全局安装的 Statsig metrics 配置（若已安装）。
pub(crate) fn global_statsig_settings() -> Option<StatsigMetricsSettings> {
    GLOBAL_STATSIG_METRICS_SETTINGS.get().cloned()
}

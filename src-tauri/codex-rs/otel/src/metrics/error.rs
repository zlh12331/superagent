//! Metrics 操作的错误类型定义。

use thiserror::Error;

/// Metrics 操作的统一返回类型。
pub type Result<T> = std::result::Result<T, MetricsError>;

/// Metrics 相关的错误变体。
#[derive(Debug, Error)]
pub enum MetricsError {
    // Metrics 相关错误。
    #[error("metric name cannot be empty")]
    EmptyMetricName,
    #[error("metric name contains invalid characters: {name}")]
    InvalidMetricName { name: String },
    #[error("{label} cannot be empty")]
    EmptyTagComponent { label: String },
    #[error("{label} contains invalid characters: {value}")]
    InvalidTagComponent { label: String, value: String },

    #[error("metrics exporter is disabled")]
    ExporterDisabled,

    #[error("counter increment must be non-negative for {name}: {inc}")]
    NegativeCounterIncrement { name: String, inc: i64 },

    #[error("failed to build OTLP metrics exporter")]
    ExporterBuild {
        #[source]
        source: opentelemetry_otlp::ExporterBuildError,
    },

    #[error("invalid OTLP metrics configuration: {message}")]
    InvalidConfig { message: String },

    #[error("failed to flush or shutdown metrics provider")]
    ProviderShutdown {
        #[source]
        source: opentelemetry_sdk::error::OTelSdkError,
    },

    #[error("runtime metrics snapshot reader is not enabled")]
    RuntimeSnapshotUnavailable,

    #[error("failed to collect runtime metrics snapshot from metrics reader")]
    RuntimeSnapshotCollect {
        #[source]
        source: opentelemetry_sdk::error::OTelSdkError,
    },
}

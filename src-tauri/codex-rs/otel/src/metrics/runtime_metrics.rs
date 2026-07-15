//! 运行时 metrics 快照汇总。
//!
//! [`RuntimeMetricsSummary`] 从 [`ResourceMetrics`] 快照中提取
//! 工具调用、API 调用、SSE/WebSocket 事件、Responses API 计时等
//! 关键指标的聚合计数与耗时，供诊断与调试使用。

use crate::metrics::names::API_CALL_COUNT_METRIC;
use crate::metrics::names::API_CALL_DURATION_METRIC;
use crate::metrics::names::RESPONSES_API_ENGINE_IAPI_TBT_DURATION_METRIC;
use crate::metrics::names::RESPONSES_API_ENGINE_IAPI_TTFT_DURATION_METRIC;
use crate::metrics::names::RESPONSES_API_ENGINE_SERVICE_TBT_DURATION_METRIC;
use crate::metrics::names::RESPONSES_API_ENGINE_SERVICE_TTFT_DURATION_METRIC;
use crate::metrics::names::RESPONSES_API_INFERENCE_TIME_DURATION_METRIC;
use crate::metrics::names::RESPONSES_API_OVERHEAD_DURATION_METRIC;
use crate::metrics::names::SSE_EVENT_COUNT_METRIC;
use crate::metrics::names::SSE_EVENT_DURATION_METRIC;
use crate::metrics::names::TOOL_CALL_COUNT_METRIC;
use crate::metrics::names::TOOL_CALL_DURATION_METRIC;
use crate::metrics::names::TURN_TTFM_DURATION_METRIC;
use crate::metrics::names::TURN_TTFT_DURATION_METRIC;
use crate::metrics::names::WEBSOCKET_EVENT_COUNT_METRIC;
use crate::metrics::names::WEBSOCKET_EVENT_DURATION_METRIC;
use crate::metrics::names::WEBSOCKET_REQUEST_COUNT_METRIC;
use crate::metrics::names::WEBSOCKET_REQUEST_DURATION_METRIC;
use opentelemetry_sdk::metrics::data::AggregatedMetrics;
use opentelemetry_sdk::metrics::data::Metric;
use opentelemetry_sdk::metrics::data::MetricData;
use opentelemetry_sdk::metrics::data::ResourceMetrics;

/// 单个指标类别的计数与耗时总计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimeMetricTotals {
    /// 事件计数。
    pub count: u64,
    /// 耗时总计（毫秒）。
    pub duration_ms: u64,
}

impl RuntimeMetricTotals {
    /// 判断计数与耗时是否均为零。
    pub fn is_empty(self) -> bool {
        self.count == 0 && self.duration_ms == 0
    }

    /// 饱和加法合并另一个总计。
    pub fn merge(&mut self, other: Self) {
        self.count = self.count.saturating_add(other.count);
        self.duration_ms = self.duration_ms.saturating_add(other.duration_ms);
    }
}

/// 运行时 metrics 快照汇总，聚合各类关键指标。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimeMetricsSummary {
    /// 工具调用计数与耗时。
    pub tool_calls: RuntimeMetricTotals,
    /// API 调用计数与耗时。
    pub api_calls: RuntimeMetricTotals,
    /// SSE 流式事件计数与耗时。
    pub streaming_events: RuntimeMetricTotals,
    /// WebSocket 请求计数与耗时。
    pub websocket_calls: RuntimeMetricTotals,
    /// WebSocket 事件计数与耗时。
    pub websocket_events: RuntimeMetricTotals,
    /// Responses API 开销耗时（毫秒）。
    pub responses_api_overhead_ms: u64,
    /// Responses API 推理耗时（毫秒）。
    pub responses_api_inference_time_ms: u64,
    /// Responses API 引擎 IAPI TTFT 耗时（毫秒）。
    pub responses_api_engine_iapi_ttft_ms: u64,
    /// Responses API 引擎服务 TTFT 耗时（毫秒）。
    pub responses_api_engine_service_ttft_ms: u64,
    /// Responses API 引擎 IAPI TBT 耗时（毫秒）。
    pub responses_api_engine_iapi_tbt_ms: u64,
    /// Responses API 引擎服务 TBT 耗时（毫秒）。
    pub responses_api_engine_service_tbt_ms: u64,
    /// Turn TTFT 耗时（毫秒）。
    pub turn_ttft_ms: u64,
    /// Turn TTFM 耗时（毫秒）。
    pub turn_ttfm_ms: u64,
}

impl RuntimeMetricsSummary {
    /// 判断所有指标是否均为零。
    pub fn is_empty(self) -> bool {
        self.tool_calls.is_empty()
            && self.api_calls.is_empty()
            && self.streaming_events.is_empty()
            && self.websocket_calls.is_empty()
            && self.websocket_events.is_empty()
            && self.responses_api_overhead_ms == 0
            && self.responses_api_inference_time_ms == 0
            && self.responses_api_engine_iapi_ttft_ms == 0
            && self.responses_api_engine_service_ttft_ms == 0
            && self.responses_api_engine_iapi_tbt_ms == 0
            && self.responses_api_engine_service_tbt_ms == 0
            && self.turn_ttft_ms == 0
            && self.turn_ttfm_ms == 0
    }

    /// 合并另一个汇总；计数类指标使用饱和加法，耗时类指标取非零值覆盖。
    pub fn merge(&mut self, other: Self) {
        self.tool_calls.merge(other.tool_calls);
        self.api_calls.merge(other.api_calls);
        self.streaming_events.merge(other.streaming_events);
        self.websocket_calls.merge(other.websocket_calls);
        self.websocket_events.merge(other.websocket_events);
        if other.responses_api_overhead_ms > 0 {
            self.responses_api_overhead_ms = other.responses_api_overhead_ms;
        }
        if other.responses_api_inference_time_ms > 0 {
            self.responses_api_inference_time_ms = other.responses_api_inference_time_ms;
        }
        if other.responses_api_engine_iapi_ttft_ms > 0 {
            self.responses_api_engine_iapi_ttft_ms = other.responses_api_engine_iapi_ttft_ms;
        }
        if other.responses_api_engine_service_ttft_ms > 0 {
            self.responses_api_engine_service_ttft_ms = other.responses_api_engine_service_ttft_ms;
        }
        if other.responses_api_engine_iapi_tbt_ms > 0 {
            self.responses_api_engine_iapi_tbt_ms = other.responses_api_engine_iapi_tbt_ms;
        }
        if other.responses_api_engine_service_tbt_ms > 0 {
            self.responses_api_engine_service_tbt_ms = other.responses_api_engine_service_tbt_ms;
        }
        if other.turn_ttft_ms > 0 {
            self.turn_ttft_ms = other.turn_ttft_ms;
        }
        if other.turn_ttfm_ms > 0 {
            self.turn_ttfm_ms = other.turn_ttfm_ms;
        }
    }

    /// 仅提取 Responses API 相关的耗时汇总，其余字段清零。
    pub fn responses_api_summary(&self) -> RuntimeMetricsSummary {
        Self {
            responses_api_overhead_ms: self.responses_api_overhead_ms,
            responses_api_inference_time_ms: self.responses_api_inference_time_ms,
            responses_api_engine_iapi_ttft_ms: self.responses_api_engine_iapi_ttft_ms,
            responses_api_engine_service_ttft_ms: self.responses_api_engine_service_ttft_ms,
            responses_api_engine_iapi_tbt_ms: self.responses_api_engine_iapi_tbt_ms,
            responses_api_engine_service_tbt_ms: self.responses_api_engine_service_tbt_ms,
            ..RuntimeMetricsSummary::default()
        }
    }

    /// 从 metrics 快照中提取汇总数据。
    pub(crate) fn from_snapshot(snapshot: &ResourceMetrics) -> Self {
        let tool_calls = RuntimeMetricTotals {
            count: sum_counter(snapshot, TOOL_CALL_COUNT_METRIC),
            duration_ms: sum_histogram_ms(snapshot, TOOL_CALL_DURATION_METRIC),
        };
        let api_calls = RuntimeMetricTotals {
            count: sum_counter(snapshot, API_CALL_COUNT_METRIC),
            duration_ms: sum_histogram_ms(snapshot, API_CALL_DURATION_METRIC),
        };
        let streaming_events = RuntimeMetricTotals {
            count: sum_counter(snapshot, SSE_EVENT_COUNT_METRIC),
            duration_ms: sum_histogram_ms(snapshot, SSE_EVENT_DURATION_METRIC),
        };
        let websocket_calls = RuntimeMetricTotals {
            count: sum_counter(snapshot, WEBSOCKET_REQUEST_COUNT_METRIC),
            duration_ms: sum_histogram_ms(snapshot, WEBSOCKET_REQUEST_DURATION_METRIC),
        };
        let websocket_events = RuntimeMetricTotals {
            count: sum_counter(snapshot, WEBSOCKET_EVENT_COUNT_METRIC),
            duration_ms: sum_histogram_ms(snapshot, WEBSOCKET_EVENT_DURATION_METRIC),
        };
        let responses_api_overhead_ms =
            sum_histogram_ms(snapshot, RESPONSES_API_OVERHEAD_DURATION_METRIC);
        let responses_api_inference_time_ms =
            sum_histogram_ms(snapshot, RESPONSES_API_INFERENCE_TIME_DURATION_METRIC);
        let responses_api_engine_iapi_ttft_ms =
            sum_histogram_ms(snapshot, RESPONSES_API_ENGINE_IAPI_TTFT_DURATION_METRIC);
        let responses_api_engine_service_ttft_ms =
            sum_histogram_ms(snapshot, RESPONSES_API_ENGINE_SERVICE_TTFT_DURATION_METRIC);
        let responses_api_engine_iapi_tbt_ms =
            sum_histogram_ms(snapshot, RESPONSES_API_ENGINE_IAPI_TBT_DURATION_METRIC);
        let responses_api_engine_service_tbt_ms =
            sum_histogram_ms(snapshot, RESPONSES_API_ENGINE_SERVICE_TBT_DURATION_METRIC);
        let turn_ttft_ms = sum_histogram_ms(snapshot, TURN_TTFT_DURATION_METRIC);
        let turn_ttfm_ms = sum_histogram_ms(snapshot, TURN_TTFM_DURATION_METRIC);
        Self {
            tool_calls,
            api_calls,
            streaming_events,
            websocket_calls,
            websocket_events,
            responses_api_overhead_ms,
            responses_api_inference_time_ms,
            responses_api_engine_iapi_ttft_ms,
            responses_api_engine_service_ttft_ms,
            responses_api_engine_iapi_tbt_ms,
            responses_api_engine_service_tbt_ms,
            turn_ttft_ms,
            turn_ttfm_ms,
        }
    }
}

/// 对快照中所有同名 counter 指标求和。
fn sum_counter(snapshot: &ResourceMetrics, name: &str) -> u64 {
    snapshot
        .scope_metrics()
        .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
        .filter(|metric| metric.name() == name)
        .map(sum_counter_metric)
        .sum()
}

/// 对单个 counter 指标的数据点求和。
fn sum_counter_metric(metric: &Metric) -> u64 {
    match metric.data() {
        AggregatedMetrics::U64(MetricData::Sum(sum)) => sum
            .data_points()
            .map(opentelemetry_sdk::metrics::data::SumDataPoint::value)
            .sum(),
        _ => 0,
    }
}

/// 对快照中所有同名 histogram 指标求和（毫秒）。
fn sum_histogram_ms(snapshot: &ResourceMetrics, name: &str) -> u64 {
    snapshot
        .scope_metrics()
        .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
        .filter(|metric| metric.name() == name)
        .map(sum_histogram_metric_ms)
        .sum()
}

/// 对单个 histogram 指标的 sum 数据点求和（毫秒）。
fn sum_histogram_metric_ms(metric: &Metric) -> u64 {
    match metric.data() {
        AggregatedMetrics::F64(MetricData::Histogram(histogram)) => histogram
            .data_points()
            .map(|point| f64_to_u64(point.sum()))
            .sum(),
        _ => 0,
    }
}

/// 将 `f64` 安全转换为 `u64`；非有限值或负值返回 0。
fn f64_to_u64(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    let clamped = value.min(u64::MAX as f64);
    clamped.round() as u64
}

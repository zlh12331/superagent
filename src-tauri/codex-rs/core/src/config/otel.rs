//! OpenTelemetry(otel)配置解析模块。
//!
//! 将用户在 config.toml 中提供的 [`OtelConfigToml`] 解析为最终生效的 [`OtelConfig`],
//! 在解析过程中对用户可编辑的 trace 元数据(span attributes、tracestate)进行校验,
//! 将非法配置以启动警告(startup warning)形式上报,而非让进程启动失败。
//!
//! # 设计原因
//! provider 初始化会安装进程级 OTEL 状态,因此必须在初始化前完成校验,
//! 避免坏配置污染全局状态或导致启动失败。

use std::collections::BTreeMap;
use std::fmt::Display;

use codex_config::types::DEFAULT_OTEL_ENVIRONMENT;
use codex_config::types::OtelConfig;
use codex_config::types::OtelConfigToml;
use codex_config::types::OtelExporterKind;

/// 将用户配置解析为最终 [`OtelConfig`]。
///
/// # 参数
/// - `config`:用户提供的 OTel TOML 配置。
/// - `startup_warnings`:用于收集非法配置警告的列表,会在启动时展示给用户。
pub(crate) fn resolve_config(
    config: OtelConfigToml,
    startup_warnings: &mut Vec<String>,
) -> OtelConfig {
    let log_user_prompt = config.log_user_prompt.unwrap_or(false);
    let environment = config
        .environment
        .unwrap_or_else(|| DEFAULT_OTEL_ENVIRONMENT.to_string());
    let exporter = config.exporter.unwrap_or(OtelExporterKind::None);
    // OTLP HTTP 端点在配置中按 signal 区分,因此启用 log 导出
    // 不应隐式地将 span 发送到 /v1/logs 端点。
    let trace_exporter = config.trace_exporter.unwrap_or(OtelExporterKind::None);
    let metrics_exporter = config.metrics_exporter.unwrap_or(OtelExporterKind::Statsig);
    // provider 初始化会安装进程级 OTEL 状态。在此处对用户可编辑的 trace 元数据进行净化,
    // 让坏配置以启动警告形式上报,而不是让启动失败。
    let span_attributes = resolve_span_attributes(config.span_attributes, startup_warnings);
    let tracestate = resolve_tracestate(config.tracestate, startup_warnings);

    OtelConfig {
        log_user_prompt,
        environment,
        exporter,
        trace_exporter,
        metrics_exporter,
        span_attributes,
        tracestate,
    }
}

/// 校验并净化 span attributes。
///
/// 逐项校验每个键值对,非法项被丢弃并以警告形式上报,合法项保留。
fn resolve_span_attributes(
    span_attributes: Option<BTreeMap<String, String>>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, String> {
    let Some(span_attributes) = span_attributes else {
        return BTreeMap::new();
    };

    let mut valid_attributes = BTreeMap::new();
    for (key, value) in span_attributes {
        let attribute = BTreeMap::from([(key.clone(), value.clone())]);
        if let Err(err) = codex_otel::validate_span_attributes(&attribute) {
            push_invalid_config_warning("otel.span_attributes", err, startup_warnings);
            continue;
        }
        valid_attributes.insert(key, value);
    }

    valid_attributes
}

/// 校验并净化 tracestate 配置。
///
/// 先逐个成员校验,再对组合后的 W3C tracestate header 进行整体校验,
/// 因为单看每个成员合法,组合后仍可能违反 W3C 规范。
fn resolve_tracestate(
    tracestate: Option<BTreeMap<String, BTreeMap<String, String>>>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let Some(tracestate) = tracestate else {
        return BTreeMap::new();
    };

    let mut valid_entries = BTreeMap::new();
    for (member_key, fields) in tracestate {
        let fields = resolve_tracestate_member_fields(&member_key, fields, startup_warnings);
        if fields.is_empty() {
            continue;
        }
        if let Err(err) = codex_otel::validate_tracestate_member(&member_key, &fields) {
            push_invalid_config_warning("otel.tracestate", err, startup_warnings);
            continue;
        }
        valid_entries.insert(member_key, fields);
    }

    // tracestate 成员可能各自合法,但组合后的 W3C tracestate header 不合法,
    // 因此在交给 provider 初始化之前,对过滤后的集合做整体校验。
    if let Err(err) = codex_otel::validate_tracestate_entries(&valid_entries) {
        push_invalid_config_warning("otel.tracestate", err, startup_warnings);
        return BTreeMap::new();
    }

    valid_entries
}

/// 校验单个 tracestate 成员的字段集合。
fn resolve_tracestate_member_fields(
    member_key: &str,
    fields: BTreeMap<String, String>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, String> {
    let mut valid_fields = BTreeMap::new();
    for (field_key, value) in fields {
        let field = BTreeMap::from([(field_key.clone(), value.clone())]);
        if let Err(err) = codex_otel::validate_tracestate_member(member_key, &field) {
            push_invalid_config_warning("otel.tracestate", err, startup_warnings);
            continue;
        }
        valid_fields.insert(field_key, value);
    }
    valid_fields
}

/// 向 `startup_warnings` 追加一条非法配置警告,并记录到 tracing 日志。
fn push_invalid_config_warning(
    config_key: &str,
    err: impl Display,
    startup_warnings: &mut Vec<String>,
) {
    let message = format!("Ignoring invalid `{config_key}` config: {err}");
    tracing::warn!("{message}");
    startup_warnings.push(message);
}

//! 进程启动指标记录。
//!
//! 提供进程级一次性计数器记录能力，确保 `codex.process.start`
//! 指标在每个进程内最多记录一次。

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use super::client::MetricsClient;
use super::error::Result;
use super::names::PROCESS_START_METRIC;
use super::tags::ORIGINATOR_TAG;
use super::tags::bounded_originator_tag_value;

/// 进程级标记，确保进程启动计数器只记录一次。
static PROCESS_START_RECORDED: AtomicBool = AtomicBool::new(false);

/// 记录进程启动计数器，保证每个进程最多记录一次。
///
/// 使用原子比较交换确保线程安全的单次执行。返回 `true` 表示本次成功记录，
/// `false` 表示此前已记录过。
pub fn record_process_start_once(metrics: &MetricsClient, originator: &str) -> Result<bool> {
    if PROCESS_START_RECORDED
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return Ok(false);
    }

    metrics.counter(
        PROCESS_START_METRIC,
        /*inc*/ 1,
        &[(ORIGINATOR_TAG, bounded_originator_tag_value(originator))],
    )?;
    Ok(true)
}

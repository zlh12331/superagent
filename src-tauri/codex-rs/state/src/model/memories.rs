use chrono::DateTime;
use chrono::Utc;
use codex_protocol::ThreadId;
use std::path::PathBuf;

use super::ThreadMetadata;

/// 单个 thread 的 stage-1 memory 提取输出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage1Output {
    /// thread ID。
    pub thread_id: ThreadId,
    /// rollout 文件路径。
    pub rollout_path: PathBuf,
    /// 源 rollout 的最近更新时间。
    pub source_updated_at: DateTime<Utc>,
    /// 提取出的原始 memory 文本。
    pub raw_memory: String,
    /// rollout 摘要。
    pub rollout_summary: String,
    /// rollout slug（用于人类可读标识）。
    pub rollout_slug: Option<String>,
    /// 工作目录。
    pub cwd: PathBuf,
    /// git 分支（若存在）。
    pub git_branch: Option<String>,
    /// 该 memory 的生成时间。
    pub generated_at: DateTime<Utc>,
}

/// 尝试领取 stage-1 memory 提取任务的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stage1JobClaimOutcome {
    /// 调用方已领取该任务，可继续执行提取。
    Claimed { ownership_token: String },
    /// 已有输出不早于源 rollout，无需再次提取。
    SkippedUpToDate,
    /// 其他 worker 当前持有该任务的新鲜租约。
    SkippedRunning,
    /// 任务处于退避状态，暂不应重试。
    SkippedRetryBackoff,
    /// 任务已耗尽重试次数，不应自动重试。
    SkippedRetryExhausted,
}

/// 已领取的 stage-1 任务及其 thread 元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage1JobClaim {
    /// thread 元数据。
    pub thread: ThreadMetadata,
    /// 领取后获得的 ownership token。
    pub ownership_token: String,
}

/// 启动阶段领取 stage-1 任务时使用的参数。
#[derive(Debug, Clone, Copy)]
pub struct Stage1StartupClaimParams<'a> {
    /// 最多扫描的 thread 数量。
    pub scan_limit: usize,
    /// 最多领取的任务数量。
    pub max_claimed: usize,
    /// 仅考虑最近 N 天内更新的 thread。
    pub max_age_days: i64,
    /// 仅考虑 rollout 空闲超过 N 小时的 thread。
    pub min_rollout_idle_hours: i64,
    /// 允许的会话来源列表。
    pub allowed_sources: &'a [String],
    /// 租约时长（秒）。
    pub lease_seconds: i64,
}

/// 尝试领取 phase-2 合并任务的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase2JobClaimOutcome {
    /// 调用方持有全局锁，可检查 memory workspace。
    Claimed {
        ownership_token: String,
        /// 领取时刻的 `input_watermark` 快照。
        input_watermark: i64,
    },
    /// 全局任务处于重试不可用状态。
    SkippedRetryUnavailable,
    /// 全局任务最近刚完成，合并处于冷却期。
    SkippedCooldown,
    /// 其他 worker 当前持有新鲜的全局合并租约。
    SkippedRunning,
}

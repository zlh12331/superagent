//! 模型拉取进度报告模块。
//!
//! 定义从 Ollama 拉取模型时发出的事件（[`PullEvent`]）以及用于渲染进度的
//! 报告器 trait（[`PullProgressReporter`]）。内置两种实现：
//! - [`CliProgressReporter`]：面向命令行的单行进度报告
//! - [`TuiProgressReporter`]：面向 TUI 的报告器（当前委托给 CLI 实现）

use std::collections::HashMap;
use std::io;
use std::io::Write;

/// 从 Ollama 拉取模型时发出的事件。
#[derive(Debug, Clone)]
pub enum PullEvent {
    /// 人类可读的状态消息（例如 "verifying"、"writing"）。
    Status(String),
    /// 针对特定 layer digest 的字节级进度更新。
    ChunkProgress {
        digest: String,
        total: Option<u64>,
        completed: Option<u64>,
    },
    /// 拉取成功完成。
    Success,

    /// 带有错误消息的错误事件。
    Error(String),
}

/// 拉取进度事件的观察者。由实现方决定如何渲染进度
/// （CLI、TUI、日志等）。
pub trait PullProgressReporter {
    fn on_event(&mut self, event: &PullEvent) -> io::Result<()>;
}

/// 极简的 CLI 报告器，将行内进度写入 stderr。
pub struct CliProgressReporter {
    /// 是否已打印过汇总头（"Downloading model: total X GB"）
    printed_header: bool,
    /// 上一行输出长度，用于在新行变短时做尾部填充清屏
    last_line_len: usize,
    /// 上次记录的已完成字节数总和，用于计算瞬时速率
    last_completed_sum: u64,
    /// 上次记录时间戳，用于计算瞬时速率
    last_instant: std::time::Instant,
    /// 按 digest 维度的 (total, completed) 聚合表
    totals_by_digest: HashMap<String, (u64, u64)>,
}

impl Default for CliProgressReporter {
    fn default() -> Self {
        Self::new()
    }
}

impl CliProgressReporter {
    /// 创建一个全新的 CLI 报告器，所有状态归零。
    pub fn new() -> Self {
        Self {
            printed_header: false,
            last_line_len: 0,
            last_completed_sum: 0,
            last_instant: std::time::Instant::now(),
            totals_by_digest: HashMap::new(),
        }
    }
}

impl PullProgressReporter for CliProgressReporter {
    fn on_event(&mut self, event: &PullEvent) -> io::Result<()> {
        let mut out = std::io::stderr();
        match event {
            PullEvent::Status(status) => {
                // 过滤掉嘈杂的 manifest 拉取消息；其它状态消息按行内显示
                if status.eq_ignore_ascii_case("pulling manifest") {
                    return Ok(());
                }
                let pad = self.last_line_len.saturating_sub(status.len());
                let line = format!("\r{status}{}", " ".repeat(pad));
                self.last_line_len = status.len();
                out.write_all(line.as_bytes())?;
                out.flush()
            }
            PullEvent::ChunkProgress {
                digest,
                total,
                completed,
            } => {
                // 更新聚合表中该 digest 的 total / completed 字段
                if let Some(t) = *total {
                    self.totals_by_digest
                        .entry(digest.clone())
                        .or_insert((0, 0))
                        .0 = t;
                }
                if let Some(c) = *completed {
                    self.totals_by_digest
                        .entry(digest.clone())
                        .or_insert((0, 0))
                        .1 = c;
                }

                // 聚合所有 layer 的字节统计
                let (sum_total, sum_completed) = self
                    .totals_by_digest
                    .values()
                    .fold((0u64, 0u64), |acc, (t, c)| (acc.0 + *t, acc.1 + *c));
                if sum_total > 0 {
                    // 首次输出时打印汇总头（显示总大小）
                    if !self.printed_header {
                        let gb = (sum_total as f64) / (1024.0 * 1024.0 * 1024.0);
                        let header = format!("Downloading model: total {gb:.2} GB\n");
                        out.write_all(b"\r\x1b[2K")?;
                        out.write_all(header.as_bytes())?;
                        self.printed_header = true;
                    }
                    // 计算瞬时速率（MB/s）：基于本次与上次之间的字节差和时间差
                    let now = std::time::Instant::now();
                    let dt = now
                        .duration_since(self.last_instant)
                        .as_secs_f64()
                        .max(0.001);
                    let dbytes = sum_completed.saturating_sub(self.last_completed_sum) as f64;
                    let speed_mb_s = dbytes / (1024.0 * 1024.0) / dt;
                    self.last_completed_sum = sum_completed;
                    self.last_instant = now;

                    // 计算百分比并格式化进度行
                    let done_gb = (sum_completed as f64) / (1024.0 * 1024.0 * 1024.0);
                    let total_gb = (sum_total as f64) / (1024.0 * 1024.0 * 1024.0);
                    let pct = (sum_completed as f64) * 100.0 / (sum_total as f64);
                    let text =
                        format!("{done_gb:.2}/{total_gb:.2} GB ({pct:.1}%) {speed_mb_s:.1} MB/s");
                    let pad = self.last_line_len.saturating_sub(text.len());
                    let line = format!("\r{text}{}", " ".repeat(pad));
                    self.last_line_len = text.len();
                    out.write_all(line.as_bytes())?;
                    out.flush()
                } else {
                    Ok(())
                }
            }
            PullEvent::Error(_) => {
                // 错误事件由调用方处理；此处不做任何事，避免错误被打印两次
                Ok(())
            }
            PullEvent::Success => {
                // 拉取成功后输出换行，结束当前进度行
                out.write_all(b"\n")?;
                out.flush()
            }
        }
    }
}

/// 当前 TUI 报告器委托给 CLI 报告器实现。在专门的 TUI 集成落地之前，
/// 这样可以保持 UI 与 CLI 行为一致。
#[derive(Default)]
pub struct TuiProgressReporter(CliProgressReporter);

impl PullProgressReporter for TuiProgressReporter {
    fn on_event(&mut self, event: &PullEvent) -> io::Result<()> {
        self.0.on_event(event)
    }
}

//! Codex memories 写路径实现。
//!
//! 该 crate 负责启动期 memory 流水线、文件型 memory artifact 辅助工具、Phase 1 与
//! Phase 2 prompt 渲染、extension 修剪以及 workspace diff 计算。

mod control;
mod extensions;
mod guard;
mod metrics;
mod phase1;
mod phase2;
mod prompts;
mod runtime;
mod start;
mod storage;
pub mod workspace;

use codex_utils_absolute_path::AbsolutePathBuf;
use std::path::Path;
use std::path::PathBuf;

pub use control::clear_memory_roots_contents;
pub use extensions::prune_old_extension_resources;
pub use prompts::build_consolidation_prompt;
pub use prompts::build_stage_one_input_message;
pub use start::start_memories_startup_task;
pub use storage::rebuild_raw_memories_file_from_memories;
pub use storage::rollout_summary_file_stem;
pub use storage::sync_rollout_summaries_from_memories;

#[cfg(test)]
mod startup_tests;

/// artifact 文件名与子目录相关常量。
mod artifacts {
    /// extension 资源子目录名。
    pub(super) const EXTENSIONS_SUBDIR: &str = "extensions";
    /// rollout 摘要子目录名。
    pub(super) const ROLLOUT_SUMMARIES_SUBDIR: &str = "rollout_summaries";
    /// 原始 memories 文件名。
    pub(super) const RAW_MEMORIES_FILENAME: &str = "raw_memories.md";
}

/// extension 资源保留策略相关常量。
mod extension_resources {
    /// 资源文件名时间戳格式。
    pub(super) const FILENAME_TS_FORMAT: &str = "%Y-%m-%dT%H-%M-%S";
    /// 资源保留天数，超过该天数未使用的资源会被修剪。
    pub(super) const RETENTION_DAYS: i64 = 7;
}

/// guard（限流）相关常量。
mod guard_limits {
    /// codex 限流 id，用于在 backend 限流快照中定位 codex 专属限制。
    pub(super) const CODEX_LIMIT_ID: &str = "codex";
}

/// 拼接进 prompt 的静态文本块。
mod prompt_blocks {
    /// 描述 memory extensions 目录结构给模型，要求其读取 instructions.md。
    pub(super) const EXTENSIONS_FOLDER_STRUCTURE: &str = r#"
Memory extensions (under {{ memory_extensions_root }}/):

- <extension_name>/instructions.md
  - Source-specific guidance for interpreting additional memory signals. If an
    extension folder exists, you must read its instructions.md to determine how to use this memory
    source.

If the user has any memory extensions, you MUST read the instructions for each extension to
determine how to use the memory source. If the workspace diff shows deleted extension resource files,
remove stale memories derived only from those resources. If it has no extension folders, continue
with the standard memory inputs only.
"#;

    /// Phase 2 prompt 中可选的 source-specific 输入说明。
    pub(super) const EXTENSIONS_PRIMARY_INPUTS: &str = r#"
Optional source-specific inputs:
Under `{{ memory_extensions_root }}/`:

- `<extension_name>/instructions.md`
  - If extension folders exist, read each instructions.md first and follow it when interpreting
    that extension's memory source.

If the workspace diff shows deleted memory extension resources, use that extension-specific deletion
signal to remove stale memories derived only from those resources.
"#;
}

/// Phase 1（stage-1 extraction）相关常量。
mod stage_one {
    /// Phase 1 使用的 reasoning effort。
    pub(super) const REASONING_EFFORT: codex_protocol::openai_models::ReasoningEffort =
        codex_protocol::openai_models::ReasoningEffort::Low;
    /// Phase 1 并发任务上限。
    pub(super) const CONCURRENCY_LIMIT: usize = 8;
    /// Phase 1 任务租约时长（秒）。
    pub(super) const JOB_LEASE_SECONDS: i64 = 3_600;
    /// Phase 1 任务失败后重试延迟（秒）。
    pub(super) const JOB_RETRY_DELAY_SECONDS: i64 = 3_600;
    /// 扫描 thread 时最多读取的条目数。
    pub(super) const THREAD_SCAN_LIMIT: usize = 5_000;
    /// 单次修剪批量大小。
    pub(super) const PRUNE_BATCH_SIZE: usize = 200;

    /// Phase 1 extraction 使用的 system prompt。
    pub(super) const PROMPT: &str = include_str!("../templates/memories/stage_one_system.md");

    /// 当模型元数据未提供有效 context window 时，stage-1 rollout 截断的 fallback token 上限。
    pub(super) const DEFAULT_ROLLOUT_TOKEN_LIMIT: usize = 150_000;

    /// 模型有效输入窗口中预留给 stage-1 rollout 输入的比例（百分比）。
    ///
    /// 保留低于 100% 是为了给 system instructions、prompt framing 与模型输出留出空间。
    pub(super) const CONTEXT_WINDOW_PERCENT: i64 = 70;
}

/// Phase 2（consolidation）相关常量。
mod stage_two {
    /// Phase 2 使用的 reasoning effort。
    pub(super) const REASONING_EFFORT: codex_protocol::openai_models::ReasoningEffort =
        codex_protocol::openai_models::ReasoningEffort::Medium;
    /// Phase 2 任务租约时长（秒）。
    pub(super) const JOB_LEASE_SECONDS: i64 = 3_600;
    /// Phase 2 任务失败后重试延迟（秒）。
    pub(super) const JOB_RETRY_DELAY_SECONDS: i64 = 3_600;
    /// Phase 2 任务心跳间隔（秒）。
    pub(super) const JOB_HEARTBEAT_SECONDS: u64 = 90;
}

/// workspace diff 相关常量。
mod workspace_diff {
    /// Phase 2 consolidation agent 读取的 diff 文件名。
    pub(super) const FILENAME: &str = "phase2_workspace_diff.md";
    /// diff 文件最大字节数（4 MiB）。
    pub(super) const MAX_BYTES: usize = 4 * 1024 * 1024;
}

/// 返回指定 codex_home 下的 memories 目录路径。
pub fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf {
    codex_home.join("memories")
}

/// 返回 memories root 下的 rollout summaries 目录路径。
pub fn rollout_summaries_dir(root: &Path) -> PathBuf {
    root.join(artifacts::ROLLOUT_SUMMARIES_SUBDIR)
}

/// 返回 memories root 下的 extensions 目录路径。
pub fn memory_extensions_root(root: &Path) -> PathBuf {
    root.join(artifacts::EXTENSIONS_SUBDIR)
}

/// 返回 memories root 下的 raw memories 文件路径。
pub fn raw_memories_file(root: &Path) -> PathBuf {
    root.join(artifacts::RAW_MEMORIES_FILENAME)
}

/// 确保 memories 目录布局存在（创建 rollout summaries 子目录）。
pub async fn ensure_layout(root: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(rollout_summaries_dir(root)).await
}

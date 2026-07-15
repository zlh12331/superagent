//! memories 使用情况分类工具。
//!
//! 根据用户执行的 shell 命令推断其访问的 memory 资源类型，用于遥测统计。

use codex_protocol::parse_command::ParsedCommand;
use codex_shell_command::bash::parse_shell_script_into_commands;
use codex_shell_command::is_safe_command::is_known_safe_command;
use codex_shell_command::parse_command::parse_shell_script;

pub use crate::metrics::MEMORIES_USAGE_METRIC;

/// memories 资源使用类型，用于遥测 tag 分类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemoriesUsageKind {
    /// `memories/MEMORY.md` 主记忆文件。
    MemoryMd,
    /// `memories/memory_summary.md` 记忆摘要文件。
    MemorySummary,
    /// `memories/raw_memories.md` 原始记忆文件。
    RawMemories,
    /// `memories/rollout_summaries/` 目录下的 rollout 摘要。
    RolloutSummaries,
    /// `memories/skills/` 目录下的 skill 资源。
    Skills,
}

impl MemoriesUsageKind {
    /// 返回该类型对应的遥测 tag 字符串。
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::MemoryMd => "memory_md",
            Self::MemorySummary => "memory_summary",
            Self::RawMemories => "raw_memories",
            Self::RolloutSummaries => "rollout_summaries",
            Self::Skills => "skills",
        }
    }
}

/// 解析 shell 命令字符串，返回其中涉及的 memories 资源使用类型列表。
///
/// 解析流程：
/// 1. 将脚本拆分为单条命令，若任何一条命令不属于已知安全命令则返回空列表。
/// 2. 对每条命令的 read/search 路径做模式匹配，识别 memory 资源类型。
///
/// - `command`：用户输入的 shell 命令字符串。
///
/// 返回去重后的 [`MemoriesUsageKind`] 列表；若命令不可识别或包含不安全命令则返回空。
pub fn memories_usage_kinds_from_command(command: &str) -> Vec<MemoriesUsageKind> {
    // 先将脚本拆分为单条命令；解析失败直接返回空。
    let Some(commands) = parse_shell_script_into_commands(command) else {
        return Vec::new();
    };
    // 安全检查：所有命令必须属于已知安全命令，否则放弃分类。
    if !commands
        .iter()
        .all(|command| is_known_safe_command(command))
    {
        return Vec::new();
    }

    parse_shell_script(command)
        .into_iter()
        .filter_map(|command| match command {
            ParsedCommand::Read { path, .. } => get_memory_kind(path.display().to_string()),
            ParsedCommand::Search { path, .. } => path.and_then(get_memory_kind),
            ParsedCommand::ListFiles { .. } | ParsedCommand::Unknown { .. } => None,
        })
        .collect()
}

/// 根据路径字符串推断 memory 资源类型。
///
/// 通过子串匹配识别不同 memory 文件/目录，无法识别时返回 `None`。
fn get_memory_kind(path: String) -> Option<MemoriesUsageKind> {
    if path.contains("memories/MEMORY.md") {
        Some(MemoriesUsageKind::MemoryMd)
    } else if path.contains("memories/memory_summary.md") {
        Some(MemoriesUsageKind::MemorySummary)
    } else if path.contains("memories/raw_memories.md") {
        Some(MemoriesUsageKind::RawMemories)
    } else if path.contains("memories/rollout_summaries/") {
        Some(MemoriesUsageKind::RolloutSummaries)
    } else if path.contains("memories/skills/") {
        Some(MemoriesUsageKind::Skills)
    } else {
        None
    }
}

//! Skill mention 选择模块。
//!
//! 该模块从用户输入中提取显式的 skill mention，并将其匹配到目录中的 skill 条目。
//!
//! 支持的 mention 形式：
//! - `UserInput::Skill`：结构化 skill 引用
//! - `UserInput::Mention` 且路径以 `skill://` 开头或以 `SKILL.md` 结尾
//! - 文本输入中的 `skill://` 路径或 `SKILL.md` 文件名
//! - 文本输入中的纯名称 mention（通过 `extract_tool_mentions` 解析）
//!
//! 去重策略：通过 `(authority, package)` 键值确保每个 skill 只被选中一次。
//! 纯名称 mention 若已被显式路径 mention 阻断（`blocked_plain_names`），则跳过。

use std::collections::HashSet;

use codex_core_skills::injection::extract_tool_mentions;
use codex_protocol::user_input::UserInput;

use crate::catalog::SkillAuthority;
use crate::catalog::SkillCatalog;
use crate::catalog::SkillCatalogEntry;
use crate::catalog::SkillPackageId;

/// skill 路径前缀
const SKILL_PATH_PREFIX: &str = "skill://";

/// 从用户输入中收集显式 skill mention 并匹配到目录条目。
///
/// # 参数
/// - `inputs`：用户输入切片
/// - `catalog`：skill 目录
///
/// # 返回
/// 返回匹配到的目录条目列表（已去重）。
///
/// # 流程
/// 1. 第一轮：处理结构化 `UserInput::Skill` 和 `Mention`（路径形式），
///    将其纯名称加入 `blocked_plain_names` 防止后续纯名称 mention 重复选中
/// 2. 第二轮：从文本输入中提取 `skill://` 路径和纯名称 mention，
///    跳过被阻断的纯名称，匹配剩余的纯名称到目录条目
#[tracing::instrument(
    level = "trace",
    skip_all,
    fields(
        input_count = inputs.len(),
        catalog_entry_count = catalog.entries.len()
    )
)]
pub(crate) fn collect_explicit_skill_mentions(
    inputs: &[UserInput],
    catalog: &SkillCatalog,
) -> Vec<SkillCatalogEntry> {
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    let mut blocked_plain_names = HashSet::new();

    // 第一轮：处理结构化 skill 输入和 mention 路径
    for input in inputs {
        match input {
            UserInput::Skill { name, path } => {
                blocked_plain_names.insert(name.clone());
                select_by_path(catalog, &path.to_string_lossy(), &mut seen, &mut selected);
            }
            UserInput::Mention { name, path } if path_is_skill(path) => {
                blocked_plain_names.insert(name.clone());
                select_by_path(catalog, path, &mut seen, &mut selected);
            }
            UserInput::Text { .. } | UserInput::Image { .. } | UserInput::LocalImage { .. } => {}
            UserInput::Mention { .. } => {}
            _ => {}
        }
    }

    // 第二轮：从文本输入中提取 skill 路径和纯名称 mention
    for input in inputs {
        let UserInput::Text { text, .. } = input else {
            continue;
        };

        let mentions = extract_tool_mentions(text);
        // 处理 skill:// 路径形式的 mention
        for path in mentions.paths() {
            if path_is_skill(path) {
                select_by_path(
                    catalog,
                    normalize_skill_path(path),
                    &mut seen,
                    &mut selected,
                );
            }
        }
        // 处理纯名称形式的 mention，跳过被阻断的名称
        for name in mentions.plain_names() {
            if blocked_plain_names.contains(name) {
                continue;
            }
            if let Some(entry) = catalog
                .entries
                .iter()
                .find(|entry| entry.enabled && entry.name == name)
            {
                push_selected(entry, &mut seen, &mut selected);
            }
        }
    }

    selected
}

/// 通过路径匹配目录中的 skill 条目。
///
/// 对路径进行规范化后，与每个启用条目的 main_prompt、id 和 display_path 比较。
fn select_by_path(
    catalog: &SkillCatalog,
    path: &str,
    seen: &mut HashSet<SkillCatalogEntryKey>,
    selected: &mut Vec<SkillCatalogEntry>,
) {
    let normalized_path = normalize_skill_path(path);
    for entry in catalog.entries.iter().filter(|entry| entry.enabled) {
        if entry_matches_path(entry, normalized_path) {
            push_selected(entry, seen, selected);
        }
    }
}

/// 将 skill 条目加入选中列表（若尚未存在）。
fn push_selected(
    entry: &SkillCatalogEntry,
    seen: &mut HashSet<SkillCatalogEntryKey>,
    selected: &mut Vec<SkillCatalogEntry>,
) {
    let key = SkillCatalogEntryKey::from(entry);
    if seen.insert(key) {
        selected.push(entry.clone());
    }
}

/// 检查 skill 条目是否匹配指定路径。
///
/// 匹配规则：main_prompt、package id 或规范化的 display_path 任一匹配即可。
fn entry_matches_path(entry: &SkillCatalogEntry, path: &str) -> bool {
    entry.main_prompt.as_str() == path
        || entry.id.0 == path
        || entry
            .display_path
            .as_deref()
            .is_some_and(|display_path| normalize_skill_path(display_path) == path)
}

/// 判断路径是否为 skill 路径。
///
/// skill 路径以 `skill://` 开头，或文件名部分为 `SKILL.md`（不区分大小写）。
fn path_is_skill(path: &str) -> bool {
    path.starts_with(SKILL_PATH_PREFIX)
        || path
            .rsplit(['/', '\\'])
            .next()
            .is_some_and(|file_name| file_name.eq_ignore_ascii_case("SKILL.md"))
}

/// 规范化 skill 路径，去除 `skill://` 前缀。
fn normalize_skill_path(path: &str) -> &str {
    path.strip_prefix(SKILL_PATH_PREFIX).unwrap_or(path)
}

/// 用于去重的 skill 条目键，由 authority 和 package id 组成。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SkillCatalogEntryKey {
    authority: SkillAuthority,
    package: SkillPackageId,
}

impl From<&SkillCatalogEntry> for SkillCatalogEntryKey {
    fn from(entry: &SkillCatalogEntry) -> Self {
        Self {
            authority: entry.authority.clone(),
            package: entry.id.clone(),
        }
    }
}

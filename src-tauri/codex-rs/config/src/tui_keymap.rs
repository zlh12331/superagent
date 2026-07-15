//! TUI keymap 配置 schema 与规范 key-spec 标准化。
//!
//! 本模块定义磁盘上的 `[tui.keymap]` 契约，被
//! `~/.codex/config.toml` 使用，并将用户输入的 key spec 标准化为
//! 规范形式，供 `codex-rs/tui/src/keymap.rs` 中的运行时 keymap
//! 解析消费。
//!
//! 职责：
//!
//! 1. 定义强类型的配置 context/action，拒绝未知字段。
//! 2. 将接受的 key 别名标准化为规范名称。
//! 3. 在早期以用户友好的诊断信息拒绝格式错误的绑定。
//!
//! 非职责：
//!
//! 1. 分发优先级与冲突校验。
//! 2. 运行时输入事件匹配。

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as SerdeError;
use std::collections::BTreeMap;

/// 可移植 TUI keymap 配置支持的最高功能键编号。
pub const MAX_FUNCTION_KEY: u8 = 24;

/// 单个按键事件的规范字符串表示（例如 `ctrl-a`）。
///
/// 解析器接受少量别名集合（例如 `escape` -> `esc`、
/// `pageup` -> `page-up`），并存储规范形式。
///
/// 该类型刻意只表示单个终端按键事件，而非事件序列。
/// 类似 `ctrl-x ctrl-s` 的值在此 schema 中不是 chord（组合键）；
/// 添加多步 chord 需要单独的运行时状态机。
#[derive(Serialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[serde(transparent)]
pub struct KeybindingSpec(#[schemars(with = "String")] pub String);

impl KeybindingSpec {
    /// 返回规范的 key-spec 字符串（例如 `ctrl-a`）。
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de> Deserialize<'de> for KeybindingSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        let normalized = normalize_keybinding_spec(&raw).map_err(SerdeError::custom)?;
        Ok(Self(normalized))
    }
}

/// 配置中一个 action 的绑定值。
///
/// 接受两种形式：
///
/// 1. 单个 key spec 字符串（`"ctrl-a"`）。
/// 2. key spec 字符串列表（`["ctrl-a", "alt-a"]`）。
///
/// 空列表显式解除该 action 在此作用域的绑定。由于显式空列表仍是
/// 已配置的值，运行时解析不应为该 action 回退到全局或内置默认值。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[serde(untagged)]
pub enum KeybindingsSpec {
    One(KeybindingSpec),
    Many(Vec<KeybindingSpec>),
}

impl KeybindingsSpec {
    /// 按声明顺序返回一个 action 的所有已配置 key spec。
    ///
    /// 调用方在派生 UI 提示时应保留此顺序，使首个绑定保持为
    /// 向用户展示的主要操作方式。
    pub fn specs(&self) -> Vec<&KeybindingSpec> {
        match self {
            Self::One(spec) => vec![spec],
            Self::Many(specs) => specs.iter().collect(),
        }
    }
}

/// 全局 keybindings。当 context 未定义覆盖时使用这些绑定。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiGlobalKeymap {
    /// 打开 transcript 覆盖层。
    pub open_transcript: Option<KeybindingsSpec>,
    /// 为当前草稿打开外部编辑器。
    pub open_external_editor: Option<KeybindingsSpec>,
    /// 复制最近的 agent 响应到剪贴板。
    pub copy: Option<KeybindingsSpec>,
    /// 清空终端 UI。
    pub clear_terminal: Option<KeybindingsSpec>,
    /// 提交当前 composer 草稿。
    pub submit: Option<KeybindingsSpec>,
    /// 在任务运行时排队当前 composer 草稿。
    pub queue: Option<KeybindingsSpec>,
    /// 切换 composer 快捷键覆盖层。
    pub toggle_shortcuts: Option<KeybindingsSpec>,
    /// 切换 composer 输入的 Vim 模式。
    pub toggle_vim_mode: Option<KeybindingsSpec>,
    /// 切换 Fast 模式。
    pub toggle_fast_mode: Option<KeybindingsSpec>,
    /// 切换原始 scrollback 模式，便于复制友好的 transcript 选择。
    pub toggle_raw_output: Option<KeybindingsSpec>,
}

/// Chat context 的 keybindings。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiChatKeymap {
    /// 中断活动 turn。
    pub interrupt_turn: Option<KeybindingsSpec>,
    /// 降低活动 reasoning effort。
    pub decrease_reasoning_effort: Option<KeybindingsSpec>,
    /// 提高活动 reasoning effort。
    pub increase_reasoning_effort: Option<KeybindingsSpec>,
    /// 编辑最近排队的消息。
    pub edit_queued_message: Option<KeybindingsSpec>,
}

/// Composer context 的 keybindings。这些覆盖对应的 `global` action。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiComposerKeymap {
    /// 提交当前 composer 草稿。
    pub submit: Option<KeybindingsSpec>,
    /// 在任务运行时排队当前 composer 草稿。
    pub queue: Option<KeybindingsSpec>,
    /// 切换 composer 快捷键覆盖层。
    pub toggle_shortcuts: Option<KeybindingsSpec>,
    /// 打开反向历史搜索或移动到上一个匹配项。
    pub history_search_previous: Option<KeybindingsSpec>,
    /// 在反向历史搜索中移动到下一个匹配项。
    pub history_search_next: Option<KeybindingsSpec>,
}

/// Editor context 的 keybindings，用于文本区域内的文本编辑。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiEditorKeymap {
    /// 在编辑器中插入换行符。
    pub insert_newline: Option<KeybindingsSpec>,
    /// 光标左移一个字素。
    pub move_left: Option<KeybindingsSpec>,
    /// 光标右移一个字素。
    pub move_right: Option<KeybindingsSpec>,
    /// 光标上移一个视觉行。
    pub move_up: Option<KeybindingsSpec>,
    /// 光标下移一个视觉行。
    pub move_down: Option<KeybindingsSpec>,
    /// 光标移动到上一个词的开头。
    pub move_word_left: Option<KeybindingsSpec>,
    /// 光标移动到下一个词的结尾。
    pub move_word_right: Option<KeybindingsSpec>,
    /// 光标移动到行首。
    pub move_line_start: Option<KeybindingsSpec>,
    /// 光标移动到行尾。
    pub move_line_end: Option<KeybindingsSpec>,
    /// 向左删除一个字素。
    pub delete_backward: Option<KeybindingsSpec>,
    /// 向右删除一个字素。
    pub delete_forward: Option<KeybindingsSpec>,
    /// 删除前一个词。
    pub delete_backward_word: Option<KeybindingsSpec>,
    /// 删除后一个词。
    pub delete_forward_word: Option<KeybindingsSpec>,
    /// 删除从光标到行首的文本。
    pub kill_line_start: Option<KeybindingsSpec>,
    /// 删除整行。
    pub kill_whole_line: Option<KeybindingsSpec>,
    /// 删除从光标到行尾的文本。
    pub kill_line_end: Option<KeybindingsSpec>,
    /// 召回 kill buffer。
    pub yank: Option<KeybindingsSpec>,
}

/// Vim normal 模式的 keybindings，用于文本区域内的模态编辑。
///
/// 使用大写字母的 action（如 `A` 表示 append-line-end）应在配置中
/// 指定为 `shift-a`；运行时匹配器会自动处理跨终端的 shift 上报差异。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct TuiVimNormalKeymap {
    /// 在光标处进入 insert 模式（`i`）。
    pub enter_insert: Option<KeybindingsSpec>,
    /// 在光标后进入 insert 模式（`a`）。
    pub append_after_cursor: Option<KeybindingsSpec>,
    /// 在行尾进入 insert 模式（`A`）。
    pub append_line_end: Option<KeybindingsSpec>,
    /// 在行首第一个非空白字符处进入 insert 模式（`I`）。
    pub insert_line_start: Option<KeybindingsSpec>,
    /// 在下方新建一行并进入 insert 模式（`o`）。
    pub open_line_below: Option<KeybindingsSpec>,
    /// 在上方新建一行并进入 insert 模式（`O`）。
    pub open_line_above: Option<KeybindingsSpec>,
    /// 光标左移（`h`）。
    pub move_left: Option<KeybindingsSpec>,
    /// 光标右移（`l`）。
    pub move_right: Option<KeybindingsSpec>,
    /// 光标上移（`k`），或在历史边界处召回更早的 composer 历史。
    pub move_up: Option<KeybindingsSpec>,
    /// 光标下移（`j`），或在历史边界处召回更新的 composer 历史。
    pub move_down: Option<KeybindingsSpec>,
    /// 光标移动到下一个词的开头（`w`）。
    pub move_word_forward: Option<KeybindingsSpec>,
    /// 光标移动到上一个词的开头（`b`）。
    pub move_word_backward: Option<KeybindingsSpec>,
    /// 光标移动到当前/下一个词的结尾（`e`）。
    pub move_word_end: Option<KeybindingsSpec>,
    /// 光标移动到行首（`0`）。
    pub move_line_start: Option<KeybindingsSpec>,
    /// 光标移动到行尾（`$`）。
    pub move_line_end: Option<KeybindingsSpec>,
    /// 删除光标处的字符（`x`）。
    pub delete_char: Option<KeybindingsSpec>,
    /// 删除光标处的字符并进入 insert 模式（`s`）。
    pub substitute_char: Option<KeybindingsSpec>,
    /// 删除从光标到行尾的文本（`D`）。
    pub delete_to_line_end: Option<KeybindingsSpec>,
    /// 修改从光标到行尾的文本并进入 insert 模式（`C`）。
    pub change_to_line_end: Option<KeybindingsSpec>,
    /// 复制整行（`Y`）。
    pub yank_line: Option<KeybindingsSpec>,
    /// 在光标后粘贴（`p`）。
    pub paste_after: Option<KeybindingsSpec>,
    /// 开始 delete 操作符；下一个键选择 motion（`d`）。
    pub start_delete_operator: Option<KeybindingsSpec>,
    /// 开始 yank 操作符；下一个键选择 motion（`y`）。
    pub start_yank_operator: Option<KeybindingsSpec>,
    /// 开始 change 操作符；接下来的键选择 text object。
    pub start_change_operator: Option<KeybindingsSpec>,
    /// 取消待处理的操作符并返回 normal 模式。
    pub cancel_operator: Option<KeybindingsSpec>,
}

/// Vim operator-pending 模式的 keybindings，用于文本区域内的模态编辑。
///
/// 此 context 仅在 `d` 或 `y` 之后等待 motion 时激活。
/// 重复操作符键（`dd`、`yy`）针对整行。按 `Esc` 取消待处理操作符
/// 并返回 normal 模式，不修改文本。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct TuiVimOperatorKeymap {
    /// 重复 delete 操作符以删除整行（`dd`）。
    pub delete_line: Option<KeybindingsSpec>,
    /// 重复 yank 操作符以复制整行（`yy`）。
    pub yank_line: Option<KeybindingsSpec>,
    /// Motion：左（`h`）。
    pub motion_left: Option<KeybindingsSpec>,
    /// Motion：右（`l`）。
    pub motion_right: Option<KeybindingsSpec>,
    /// Motion：上一行（`k`）。
    pub motion_up: Option<KeybindingsSpec>,
    /// Motion：下一行（`j`）。
    pub motion_down: Option<KeybindingsSpec>,
    /// Motion：到下一个词的开头（`w`）。
    pub motion_word_forward: Option<KeybindingsSpec>,
    /// Motion：到上一个词的开头（`b`）。
    pub motion_word_backward: Option<KeybindingsSpec>,
    /// Motion：到当前/下一个词的结尾（`e`）。
    pub motion_word_end: Option<KeybindingsSpec>,
    /// Motion：到行首（`0`）。
    pub motion_line_start: Option<KeybindingsSpec>,
    /// Motion：到行尾（`$`）。
    pub motion_line_end: Option<KeybindingsSpec>,
    /// 在操作符后选择 inner text object。
    pub select_inner_text_object: Option<KeybindingsSpec>,
    /// 在操作符后选择 around text object。
    pub select_around_text_object: Option<KeybindingsSpec>,
    /// 取消待处理操作符并返回 normal 模式。
    pub cancel: Option<KeybindingsSpec>,
}

/// Vim text-object 的 keybindings，用于文本区域内的模态编辑。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiVimTextObjectKeymap {
    /// Text object：word。
    pub word: Option<KeybindingsSpec>,
    /// Text object：以空格分隔的 WORD。
    pub big_word: Option<KeybindingsSpec>,
    /// Text object：圆括号。
    pub parentheses: Option<KeybindingsSpec>,
    /// Text object：方括号。
    pub brackets: Option<KeybindingsSpec>,
    /// Text object：花括号。
    pub braces: Option<KeybindingsSpec>,
    /// Text object：双引号。
    pub double_quote: Option<KeybindingsSpec>,
    /// Text object：单引号。
    pub single_quote: Option<KeybindingsSpec>,
    /// Text object：反引号。
    pub backtick: Option<KeybindingsSpec>,
    /// 取消待处理的 text-object 命令。
    pub cancel: Option<KeybindingsSpec>,
}

/// Pager context 的 keybindings，用于 transcript 与静态覆盖层。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiPagerKeymap {
    /// 向上滚动一行。
    pub scroll_up: Option<KeybindingsSpec>,
    /// 向下滚动一行。
    pub scroll_down: Option<KeybindingsSpec>,
    /// 向上滚动一页。
    pub page_up: Option<KeybindingsSpec>,
    /// 向下滚动一页。
    pub page_down: Option<KeybindingsSpec>,
    /// 向上滚动半页。
    pub half_page_up: Option<KeybindingsSpec>,
    /// 向下滚动半页。
    pub half_page_down: Option<KeybindingsSpec>,
    /// 跳转到开头。
    pub jump_top: Option<KeybindingsSpec>,
    /// 跳转到结尾。
    pub jump_bottom: Option<KeybindingsSpec>,
    /// 关闭 pager 覆盖层。
    pub close: Option<KeybindingsSpec>,
    /// 通过专用切换键关闭 transcript 覆盖层。
    pub close_transcript: Option<KeybindingsSpec>,
}

/// 列表选择 context 的 keybindings，用于弹出式可选择列表。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiListKeymap {
    /// 列表选择上移。
    pub move_up: Option<KeybindingsSpec>,
    /// 列表选择下移。
    pub move_down: Option<KeybindingsSpec>,
    /// 在支持水平操作的列表选择器中水平左移。
    pub move_left: Option<KeybindingsSpec>,
    /// 在支持水平操作的列表选择器中水平右移。
    pub move_right: Option<KeybindingsSpec>,
    /// 列表选择上移一页。
    pub page_up: Option<KeybindingsSpec>,
    /// 列表选择下移一页。
    pub page_down: Option<KeybindingsSpec>,
    /// 跳转到第一个列表项。
    pub jump_top: Option<KeybindingsSpec>,
    /// 跳转到最后一个列表项。
    pub jump_bottom: Option<KeybindingsSpec>,
    /// 接受当前选择。
    pub accept: Option<KeybindingsSpec>,
    /// 取消并关闭选择视图。
    pub cancel: Option<KeybindingsSpec>,
}

/// 审批覆盖层的 keybindings。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiApprovalKeymap {
    /// 打开全屏审批详情视图。
    pub open_fullscreen: Option<KeybindingsSpec>,
    /// 当从其他 thread 显示审批时，打开请求审批的 thread。
    pub open_thread: Option<KeybindingsSpec>,
    /// 批准主要选项。
    pub approve: Option<KeybindingsSpec>,
    /// 当"会话级批准"选项存在时，批准整个会话。
    pub approve_for_session: Option<KeybindingsSpec>,
    /// 当"按前缀批准"选项存在时，按 exec-policy 前缀批准。
    pub approve_for_prefix: Option<KeybindingsSpec>,
    /// 拒绝且不提供后续指导。
    pub deny: Option<KeybindingsSpec>,
    /// 拒绝并提供纠正指导。
    pub decline: Option<KeybindingsSpec>,
    /// 取消 elicitation 请求。
    pub cancel: Option<KeybindingsSpec>,
}

/// 来自 `[tui.keymap]` 的原始 keymap 配置。
///
/// 每个 context 包含 action 级别的覆盖。缺失的 action 从内置默认值
/// 继承，部分 chat/composer action 可在运行时解析时回退到 `global`。
///
/// 该类型刻意设计为持久化形状，而非输入处理器使用的结构。
/// 运行时消费者应先将其解析为 `RuntimeKeymap`，以便一致地应用
/// 优先级、空列表解绑与重复键校验。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(deny_unknown_fields)]
pub struct TuiKeymap {
    #[serde(default)]
    pub global: TuiGlobalKeymap,
    #[serde(default)]
    pub chat: TuiChatKeymap,
    #[serde(default)]
    pub composer: TuiComposerKeymap,
    #[serde(default)]
    pub editor: TuiEditorKeymap,
    #[serde(default)]
    pub vim_normal: TuiVimNormalKeymap,
    #[serde(default)]
    pub vim_operator: TuiVimOperatorKeymap,
    #[serde(default)]
    pub vim_text_object: TuiVimTextObjectKeymap,
    #[serde(default)]
    pub pager: TuiPagerKeymap,
    #[serde(default)]
    pub list: TuiListKeymap,
    #[serde(default)]
    pub approval: TuiApprovalKeymap,
}

/// 将用户输入的一个 key spec 标准化为规范存储格式。
///
/// 输出始终将修饰键按 `ctrl-alt-shift-<key>` 顺序排列（若存在），
/// 并应用接受的别名（`escape` -> `esc`、`pageup` -> `page-up`）。
/// 无法明确表示的输入会被拒绝。
///
/// 标准化在配置反序列化时进行，使下游运行时代码只需为每个键解析
/// 一种拼写。调用方在接受用户编写的 key spec 时不应绕过此函数，
/// 否则等价的键在测试、UI 提示与重复检测中可能无法相等比较。
fn normalize_keybinding_spec(raw: &str) -> Result<String, String> {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return Err(
            "keybinding cannot be empty. Use values like `ctrl-a` or `shift-enter`.\n\
See the Codex keymap documentation for supported actions and examples."
                .to_string(),
        );
    }

    let segments: Vec<&str> = lower
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() {
        return Err(format!(
            "invalid keybinding `{raw}`. Use values like `ctrl-a`, `shift-enter`, or `page-down`."
        ));
    }

    let mut modifiers =
        BTreeMap::<&str, bool>::from([("ctrl", false), ("alt", false), ("shift", false)]);
    let mut key_segments = Vec::new();
    let mut saw_key = false;

    for segment in segments {
        let canonical_mod = match segment {
            "ctrl" | "control" => Some("ctrl"),
            "alt" | "option" => Some("alt"),
            "shift" => Some("shift"),
            _ => None,
        };

        if !saw_key && let Some(modifier) = canonical_mod {
            if modifiers.get(modifier).copied().unwrap_or(false) {
                return Err(format!(
                    "duplicate modifier in keybinding `{raw}`. Use each modifier at most once."
                ));
            }
            modifiers.insert(modifier, true);
            continue;
        }

        saw_key = true;
        key_segments.push(segment);
    }

    if key_segments.is_empty() {
        return Err(format!(
            "missing key in keybinding `{raw}`. Add a key name like `a`, `enter`, or `page-down`."
        ));
    }

    // 修饰键必须出现在主键之前，否则视为格式错误。
    if key_segments
        .iter()
        .any(|segment| matches!(*segment, "ctrl" | "control" | "alt" | "option" | "shift"))
    {
        return Err(format!(
            "invalid keybinding `{raw}`: modifiers must come before the key (for example `ctrl-a`)."
        ));
    }

    let key = normalize_key_name(&key_segments.join("-"), raw)?;
    // 按固定顺序输出修饰键：ctrl -> alt -> shift -> key。
    let mut normalized = Vec::new();
    if modifiers.get("ctrl").copied().unwrap_or(false) {
        normalized.push("ctrl".to_string());
    }
    if modifiers.get("alt").copied().unwrap_or(false) {
        normalized.push("alt".to_string());
    }
    if modifiers.get("shift").copied().unwrap_or(false) {
        normalized.push("shift".to_string());
    }
    normalized.push(key);
    Ok(normalized.join("-"))
}

/// 标准化并校验一个 key name 段。
///
/// 接受受限的 key 词汇表，以保持运行时解析器行为跨平台确定性。
fn normalize_key_name(key: &str, original: &str) -> Result<String, String> {
    // 应用接受的别名映射。
    let alias = match key {
        "escape" => "esc",
        "return" => "enter",
        "spacebar" => "space",
        "pgup" | "pageup" => "page-up",
        "pgdn" | "pagedown" => "page-down",
        "del" => "delete",
        other => other,
    };

    // 单字符：接受所有非控制字符的 ASCII 可打印字符（除 `-` 外）。
    if alias.len() == 1 {
        let ch = alias.chars().next().unwrap_or_default();
        if ch.is_ascii() && !ch.is_ascii_control() && ch != '-' {
            return Ok(alias.to_string());
        }
    }

    // 命名键白名单。
    if matches!(
        alias,
        "enter"
            | "tab"
            | "backspace"
            | "esc"
            | "delete"
            | "up"
            | "down"
            | "left"
            | "right"
            | "home"
            | "end"
            | "page-up"
            | "page-down"
            | "space"
            | "minus"
    ) {
        return Ok(alias.to_string());
    }

    // 功能键：f1 到 f{MAX_FUNCTION_KEY}。
    if let Some(number) = alias.strip_prefix('f')
        && let Ok(number) = number.parse::<u8>()
        && (1..=MAX_FUNCTION_KEY).contains(&number)
    {
        return Ok(alias.to_string());
    }

    Err(format!(
        "unknown key `{key}` in keybinding `{original}`. \
Use a printable character (for example `a`), function keys (`f1`-`f{MAX_FUNCTION_KEY}`), \
or one of: enter, tab, backspace, esc, delete, arrows, home/end, page-up/page-down, space, minus.\n\
See the Codex keymap documentation for supported actions and examples."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn misplaced_action_at_keymap_root_is_rejected() {
        // Actions placed directly under [tui.keymap] instead of a context
        // sub-table (e.g. [tui.keymap.global]) must produce a parse error,
        // not be silently ignored.
        let toml_input = r#"
            open_transcript = "ctrl-s"
        "#;
        let result = toml::from_str::<TuiKeymap>(toml_input);
        assert!(
            result.is_err(),
            "expected error for action at keymap root, got: {result:?}"
        );
    }

    #[test]
    fn misspelled_action_under_context_is_rejected() {
        let toml_input = r#"
            [global]
            open_transcrip = "ctrl-x"
        "#;
        let err = toml::from_str::<TuiKeymap>(toml_input)
            .expect_err("expected unknown action under context");
        assert!(
            err.to_string().contains("open_transcrip"),
            "expected error to mention misspelled field, got: {err}"
        );
    }

    #[test]
    fn misspelled_vim_text_object_action_is_rejected() {
        let toml_input = r#"
            [vim_text_object]
            double_quotes = "shift-quote"
        "#;
        let err = toml::from_str::<TuiKeymap>(toml_input)
            .expect_err("expected unknown vim text object action");
        assert!(
            err.to_string().contains("double_quotes"),
            "expected error to mention misspelled field, got: {err}"
        );
    }

    #[test]
    fn removed_backtrack_actions_are_rejected() {
        for (context, action) in [
            ("global", "edit_previous_message"),
            ("global", "confirm_edit_previous_message"),
            ("chat", "edit_previous_message"),
            ("chat", "confirm_edit_previous_message"),
            ("pager", "edit_previous_message"),
            ("pager", "edit_next_message"),
            ("pager", "confirm_edit_message"),
        ] {
            let toml_input = format!(
                r#"
                [{context}]
                {action} = "ctrl-x"
                "#
            );
            let err = toml::from_str::<TuiKeymap>(&toml_input)
                .expect_err("expected removed backtrack action to be rejected");
            assert!(
                err.to_string().contains(action),
                "expected error to mention removed field {action}, got: {err}"
            );
        }
    }

    #[test]
    fn action_under_global_context_is_accepted() {
        let toml_input = r#"
            [global]
            open_transcript = "ctrl-s"
        "#;
        let keymap: TuiKeymap = toml::from_str(toml_input).expect("valid config");
        assert!(keymap.global.open_transcript.is_some());
    }

    #[test]
    fn minus_bindings_under_global_context_are_accepted() {
        for (spec, expected) in [
            (
                "minus",
                KeybindingsSpec::One(KeybindingSpec("minus".to_string())),
            ),
            (
                "alt-minus",
                KeybindingsSpec::One(KeybindingSpec("alt-minus".to_string())),
            ),
        ] {
            let toml_input = format!(
                r#"
                [global]
                open_transcript = "{spec}"
                "#
            );
            let keymap: TuiKeymap = toml::from_str(&toml_input).expect("valid config");
            let mut expected_keymap = TuiKeymap::default();
            expected_keymap.global.open_transcript = Some(expected);

            assert_eq!(keymap, expected_keymap);
        }
    }

    #[test]
    fn function_keys_through_f24_are_accepted() {
        assert_eq!(normalize_keybinding_spec("F13"), Ok("f13".to_string()));
        assert_eq!(normalize_keybinding_spec("f24"), Ok("f24".to_string()));
        assert!(normalize_keybinding_spec("f25").is_err());
    }
}

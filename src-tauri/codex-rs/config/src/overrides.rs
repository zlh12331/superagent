//! CLI 覆盖 layer 构造。
//!
//! 将命令行传入的"点分路径 → 值"覆盖项构造为一个 TOML layer，作为最高
//! 优先级 layer 合并到配置栈中。例如 `("model", "gpt-5")` 会生成
//! `{ model = "gpt-5" }`，`("permissions.network.domains", ...)` 会生成
//! 嵌套表。

use toml::Value as TomlValue;

/// 返回一个空 TOML 表（layer 构造的常用初始值）。
pub(crate) fn default_empty_table() -> TomlValue {
    TomlValue::Table(Default::default())
}

/// 由一组 `(点分路径, 值)` 覆盖项构造一个 TOML layer。
///
/// 每个 `path` 按 `.` 分段，逐层创建嵌套表，最后一段写入值。同名 key
/// 后写覆盖先写。
pub fn build_cli_overrides_layer(cli_overrides: &[(String, TomlValue)]) -> TomlValue {
    let mut root = default_empty_table();
    for (path, value) in cli_overrides {
        apply_toml_override(&mut root, path, value.clone());
    }
    root
}

/// 将单条点分路径覆盖应用到 TOML 根值上。
///
/// 按 `.` 切分 `path`，逐段深入/创建 Table；最后一段插入值。若中间路径
/// 遇到非 Table 值，则替换为空 Table 后继续。
fn apply_toml_override(root: &mut TomlValue, path: &str, value: TomlValue) {
    use toml::value::Table;

    let mut current = root;
    let mut segments_iter = path.split('.').peekable();

    while let Some(segment) = segments_iter.next() {
        let is_last = segments_iter.peek().is_none();

        if is_last {
            match current {
                TomlValue::Table(table) => {
                    table.insert(segment.to_string(), value);
                }
                _ => {
                    let mut table = Table::new();
                    table.insert(segment.to_string(), value);
                    *current = TomlValue::Table(table);
                }
            }
            return;
        }

        match current {
            TomlValue::Table(table) => {
                current = table
                    .entry(segment.to_string())
                    .or_insert_with(|| TomlValue::Table(Table::new()));
            }
            _ => {
                *current = TomlValue::Table(Table::new());
                if let TomlValue::Table(tbl) = current {
                    current = tbl
                        .entry(segment.to_string())
                        .or_insert_with(|| TomlValue::Table(Table::new()));
                }
            }
        }
    }
}

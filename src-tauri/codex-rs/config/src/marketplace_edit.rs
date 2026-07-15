//! 用户级 marketplace（插件市场）配置的原子写入与移除。
//!
//! 本模块通过 `toml_edit` 在 `~/.codex/config.toml` 中以保留格式的方式
//! 更新 `[marketplaces.<name>]` 表，避免覆盖用户其他字段。所有写入操作
//! 都先读取现有内容（若不存在则创建空文档），更新后原子写回。

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use toml_edit::DocumentMut;
use toml_edit::Item as TomlItem;
use toml_edit::Table as TomlTable;
use toml_edit::Value as TomlValue;
use toml_edit::value;

use crate::CONFIG_TOML_FILE;

/// 一次 marketplace 配置更新操作的参数集合。
///
/// 字段对应 `[marketplaces.<name>]` 表中的列。`last_updated` 与 `source_type`、
/// `source` 为必填项，其余为可选。
pub struct MarketplaceConfigUpdate<'a> {
    /// 最后更新时间戳（RFC3339 字符串）。
    pub last_updated: &'a str,
    /// 最后一次拉取的 revision（如 git commit SHA），可选。
    pub last_revision: Option<&'a str>,
    /// 源类型（如 `"git"`、`"local"`）。
    pub source_type: &'a str,
    /// 源地址（git URL 或本地路径）。
    pub source: &'a str,
    /// 引用名（如 git 分支/tag），可选。
    pub ref_name: Option<&'a str>,
    /// sparse checkout 路径列表，为空时不写入该字段。
    pub sparse_paths: &'a [String],
}

/// `remove_user_marketplace_config` 的返回结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveMarketplaceConfigOutcome {
    /// 成功移除指定 marketplace 条目。
    Removed,
    /// 未找到任何匹配条目（包括大小写不敏感的匹配）。
    NotFound,
    /// 配置中存在大小写不敏感匹配但精确匹配不存在的条目。
    /// 携带配置中实际使用的名称，便于向用户提示。
    NameCaseMismatch { configured_name: String },
}

/// 在 `codex_home/config.toml` 中记录或更新一个用户级 marketplace 条目。
///
/// 若 `config.toml` 不存在则创建；若 `[marketplaces]` 表或对应条目已存在，
/// 则原地更新。写入前会确保 `codex_home` 目录存在。
///
/// # Errors
/// - 文件读取失败（且非 `NotFound`）
/// - TOML 解析失败
/// - 目录创建或文件写入失败
pub fn record_user_marketplace(
    codex_home: &Path,
    marketplace_name: &str,
    update: &MarketplaceConfigUpdate<'_>,
) -> std::io::Result<()> {
    let config_path = codex_home.join(CONFIG_TOML_FILE);
    let mut doc = read_or_create_document(&config_path)?;
    upsert_marketplace(&mut doc, marketplace_name, update);
    fs::create_dir_all(codex_home)?;
    fs::write(config_path, doc.to_string())
}

/// 移除一个用户级 marketplace 条目，返回是否成功移除。
///
/// 等价于调用 `remove_user_marketplace_config` 并判断结果是否为 `Removed`。
///
/// # Errors
/// 透传 `remove_user_marketplace_config` 的 IO 错误。
pub fn remove_user_marketplace(codex_home: &Path, marketplace_name: &str) -> std::io::Result<bool> {
    let outcome = remove_user_marketplace_config(codex_home, marketplace_name)?;
    Ok(outcome == RemoveMarketplaceConfigOutcome::Removed)
}

/// 移除一个用户级 marketplace 条目，返回详细的移除结果。
///
/// 与 [`remove_user_marketplace`] 的区别在于能区分 "未找到" 与 "大小写不匹配"
/// 两种失败场景，便于上层向用户提供准确的错误提示。
///
/// # Errors
/// - 文件读取失败（且非 `NotFound`）
/// - TOML 解析失败
/// - 目录创建或文件写入失败
pub fn remove_user_marketplace_config(
    codex_home: &Path,
    marketplace_name: &str,
) -> std::io::Result<RemoveMarketplaceConfigOutcome> {
    let config_path = codex_home.join(CONFIG_TOML_FILE);
    let mut doc = match fs::read_to_string(&config_path) {
        Ok(raw) => raw
            .parse::<DocumentMut>()
            .map_err(|err| std::io::Error::new(ErrorKind::InvalidData, err))?,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(RemoveMarketplaceConfigOutcome::NotFound);
        }
        Err(err) => return Err(err),
    };

    let outcome = remove_marketplace(&mut doc, marketplace_name);
    if outcome != RemoveMarketplaceConfigOutcome::Removed {
        return Ok(outcome);
    }

    fs::create_dir_all(codex_home)?;
    fs::write(config_path, doc.to_string())?;
    Ok(RemoveMarketplaceConfigOutcome::Removed)
}

/// 读取 `config_path` 处的 TOML 文件并解析为可变文档。
///
/// 文件不存在时返回一个空的 `DocumentMut`，便于调用方在此基础上插入新条目。
///
/// # Errors
/// - 文件读取失败（且非 `NotFound`）
/// - TOML 解析失败
fn read_or_create_document(config_path: &Path) -> std::io::Result<DocumentMut> {
    match fs::read_to_string(config_path) {
        Ok(raw) => raw
            .parse::<DocumentMut>()
            .map_err(|err| std::io::Error::new(ErrorKind::InvalidData, err)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(err) => Err(err),
    }
}

/// 在 `doc` 中插入或更新 `[marketplaces.<marketplace_name>]` 表。
///
/// 若 `[marketplaces]` 表不存在或被非表类型占用，则重建为隐式表。
/// 写入字段顺序固定：`last_updated`、`last_revision`（可选）、
/// `source_type`、`source`、`ref`（可选）、`sparse_paths`（非空时）。
fn upsert_marketplace(
    doc: &mut DocumentMut,
    marketplace_name: &str,
    update: &MarketplaceConfigUpdate<'_>,
) {
    let root = doc.as_table_mut();
    if !root.contains_key("marketplaces") {
        root.insert("marketplaces", TomlItem::Table(new_implicit_table()));
    }

    let Some(marketplaces_item) = root.get_mut("marketplaces") else {
        return;
    };
    if !marketplaces_item.is_table() {
        *marketplaces_item = TomlItem::Table(new_implicit_table());
    }

    let Some(marketplaces) = marketplaces_item.as_table_mut() else {
        return;
    };
    let mut entry = TomlTable::new();
    entry.set_implicit(false);
    entry["last_updated"] = value(update.last_updated.to_string());
    if let Some(last_revision) = update.last_revision {
        entry["last_revision"] = value(last_revision.to_string());
    }
    entry["source_type"] = value(update.source_type.to_string());
    entry["source"] = value(update.source.to_string());
    if let Some(ref_name) = update.ref_name {
        entry["ref"] = value(ref_name.to_string());
    }
    if !update.sparse_paths.is_empty() {
        entry["sparse_paths"] = TomlItem::Value(TomlValue::Array(
            update.sparse_paths.iter().map(String::as_str).collect(),
        ));
    }
    marketplaces.insert(marketplace_name, TomlItem::Table(entry));
}

/// 从 `doc` 中移除 `[marketplaces.<marketplace_name>]` 表。
///
/// 同时处理 `marketplaces` 为标准表与 inline 表两种情况。移除后若
/// `marketplaces` 表为空，则一并移除该键以保持文档整洁。
///
/// 匹配策略：先精确匹配；若失败则进行大小写不敏感匹配，返回 `NameCaseMismatch`。
fn remove_marketplace(
    doc: &mut DocumentMut,
    marketplace_name: &str,
) -> RemoveMarketplaceConfigOutcome {
    let root = doc.as_table_mut();
    let Some(marketplaces_item) = root.get_mut("marketplaces") else {
        return RemoveMarketplaceConfigOutcome::NotFound;
    };

    let mut remove_marketplaces = false;
    let outcome = match marketplaces_item {
        TomlItem::Table(marketplaces) => {
            let outcome = if marketplaces.remove(marketplace_name).is_some() {
                RemoveMarketplaceConfigOutcome::Removed
            } else if let Some(configured_name) =
                case_mismatched_key(marketplaces.iter().map(|(key, _)| key), marketplace_name)
            {
                RemoveMarketplaceConfigOutcome::NameCaseMismatch { configured_name }
            } else {
                RemoveMarketplaceConfigOutcome::NotFound
            };
            remove_marketplaces = marketplaces.is_empty();
            outcome
        }
        TomlItem::Value(value) => {
            let Some(marketplaces) = value.as_inline_table_mut() else {
                return RemoveMarketplaceConfigOutcome::NotFound;
            };
            let outcome = if marketplaces.remove(marketplace_name).is_some() {
                RemoveMarketplaceConfigOutcome::Removed
            } else if let Some(configured_name) =
                case_mismatched_key(marketplaces.iter().map(|(key, _)| key), marketplace_name)
            {
                RemoveMarketplaceConfigOutcome::NameCaseMismatch { configured_name }
            } else {
                RemoveMarketplaceConfigOutcome::NotFound
            };
            remove_marketplaces = marketplaces.is_empty();
            outcome
        }
        _ => RemoveMarketplaceConfigOutcome::NotFound,
    };

    if outcome == RemoveMarketplaceConfigOutcome::Removed && remove_marketplaces {
        root.remove("marketplaces");
    }
    outcome
}

/// 在 `keys` 中查找与 `requested_name` 大小写不敏感匹配但精确匹配不同的键。
///
/// 用于在移除操作中向用户报告 "你可能拼写错了大小写" 的情况。
fn case_mismatched_key<'a>(
    mut keys: impl Iterator<Item = &'a str>,
    requested_name: &str,
) -> Option<String> {
    keys.find(|key| *key != requested_name && key.eq_ignore_ascii_case(requested_name))
        .map(str::to_string)
}

/// 创建一个新的隐式 `TomlTable`。
///
/// 隐式表在序列化时不会输出表头（`[table_name]`），仅当其内部有显式键时
/// 才会被输出。适用于作为 `[marketplaces]` 这类容器表的初始状态。
fn new_implicit_table() -> TomlTable {
    let mut table = TomlTable::new();
    table.set_implicit(true);
    table
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn remove_user_marketplace_removes_requested_entry() {
        let codex_home = TempDir::new().unwrap();
        let update = MarketplaceConfigUpdate {
            last_updated: "2026-04-13T00:00:00Z",
            last_revision: None,
            source_type: "git",
            source: "https://github.com/owner/repo.git",
            ref_name: Some("main"),
            sparse_paths: &[],
        };
        record_user_marketplace(codex_home.path(), "debug", &update).unwrap();
        record_user_marketplace(codex_home.path(), "other", &update).unwrap();

        let removed = remove_user_marketplace(codex_home.path(), "debug").unwrap();

        assert!(removed);
        let config: toml::Value =
            toml::from_str(&fs::read_to_string(codex_home.path().join(CONFIG_TOML_FILE)).unwrap())
                .unwrap();
        let marketplaces = config
            .get("marketplaces")
            .and_then(toml::Value::as_table)
            .unwrap();
        assert_eq!(marketplaces.len(), 1);
        assert!(marketplaces.contains_key("other"));
    }

    #[test]
    fn remove_user_marketplace_returns_false_when_missing() {
        let codex_home = TempDir::new().unwrap();

        let removed = remove_user_marketplace(codex_home.path(), "debug").unwrap();

        assert!(!removed);
    }

    #[test]
    fn remove_user_marketplace_config_reports_case_mismatch() {
        let codex_home = TempDir::new().unwrap();
        let update = MarketplaceConfigUpdate {
            last_updated: "2026-04-13T00:00:00Z",
            last_revision: None,
            source_type: "git",
            source: "https://github.com/owner/repo.git",
            ref_name: Some("main"),
            sparse_paths: &[],
        };
        record_user_marketplace(codex_home.path(), "debug", &update).unwrap();

        let outcome = remove_user_marketplace_config(codex_home.path(), "Debug").unwrap();

        assert_eq!(
            outcome,
            RemoveMarketplaceConfigOutcome::NameCaseMismatch {
                configured_name: "debug".to_string()
            }
        );
    }

    #[test]
    fn remove_user_marketplace_config_removes_inline_table_entry() {
        let codex_home = TempDir::new().unwrap();
        fs::write(
            codex_home.path().join(CONFIG_TOML_FILE),
            r#"
marketplaces = {
  debug = { source_type = "git", source = "https://github.com/owner/repo.git" },
  other = { source_type = "local", source = "/tmp/marketplace" },
}
"#,
        )
        .unwrap();

        let outcome = remove_user_marketplace_config(codex_home.path(), "debug").unwrap();

        assert_eq!(outcome, RemoveMarketplaceConfigOutcome::Removed);
        let config: toml::Value =
            toml::from_str(&fs::read_to_string(codex_home.path().join(CONFIG_TOML_FILE)).unwrap())
                .unwrap();
        let marketplaces = config
            .get("marketplaces")
            .and_then(toml::Value::as_table)
            .unwrap();
        assert_eq!(marketplaces.len(), 1);
        assert!(marketplaces.contains_key("other"));
    }
}

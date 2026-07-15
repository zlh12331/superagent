//! 策略对象模块，承载规则集合并提供命令检查入口。
//!
//! [`Policy`] 是核心类型，持有前缀规则、网络规则和 host_executable 映射，
//! 提供 `check` / `matches_for_command` 等方法用于评估一条命令的执行决策。
//! [`Evaluation`] 是检查结果的聚合，包含最终决策和所有命中规则。
//! [`MatchOptions`] 控制匹配行为（如是否解析 host_executable）。

use crate::decision::Decision;
use crate::error::Error;
use crate::error::Result;
use crate::executable_name::executable_path_lookup_key;
use crate::rule::NetworkRule;
use crate::rule::NetworkRuleProtocol;
use crate::rule::PatternToken;
use crate::rule::PrefixPattern;
use crate::rule::PrefixRule;
use crate::rule::RuleMatch;
use crate::rule::RuleRef;
use crate::rule::normalize_network_rule_host;
use codex_utils_absolute_path::AbsolutePathBuf;
use multimap::MultiMap;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// 启发式回退函数类型，当无显式规则命中时调用。
type HeuristicsFallback<'a> = Option<&'a dyn Fn(&[String]) -> Decision>;

/// 命令匹配的可选行为开关。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MatchOptions {
    /// 是否将命令首 token 解析为绝对路径后，按 basename 匹配 host_executable 规则。
    pub resolve_host_executables: bool,
}

/// 策略对象，持有一组规则并提供命令检查入口。
///
/// 内部按程序名（命令首 token）索引前缀规则，同时维护网络规则列表和
/// host_executable 名称到绝对路径的映射。策略可通过 [`Policy::merge_overlay`]
/// 叠加合并，后叠加的规则与已有规则共存。
#[derive(Clone, Debug)]
pub struct Policy {
    /// 按程序名索引的前缀规则集合（一个程序名可对应多条规则）。
    rules_by_program: MultiMap<String, RuleRef>,
    /// 网络访问规则列表。
    network_rules: Vec<NetworkRule>,
    /// host_executable 名称到允许的绝对路径列表的映射。
    host_executables_by_name: HashMap<String, Arc<[AbsolutePathBuf]>>,
}

impl Policy {
    /// 仅用前缀规则创建策略，网络规则和 host_executable 映射为空。
    pub fn new(rules_by_program: MultiMap<String, RuleRef>) -> Self {
        Self::from_parts(rules_by_program, Vec::new(), HashMap::new())
    }

    /// 用全部组成部分创建策略。
    pub fn from_parts(
        rules_by_program: MultiMap<String, RuleRef>,
        network_rules: Vec<NetworkRule>,
        host_executables_by_name: HashMap<String, Arc<[AbsolutePathBuf]>>,
    ) -> Self {
        Self {
            rules_by_program,
            network_rules,
            host_executables_by_name,
        }
    }

    /// 创建空策略，不含任何规则。
    pub fn empty() -> Self {
        Self::new(MultiMap::new())
    }

    /// 返回按程序名索引的前缀规则集合的引用。
    pub fn rules(&self) -> &MultiMap<String, RuleRef> {
        &self.rules_by_program
    }

    /// 返回网络规则列表的引用。
    pub fn network_rules(&self) -> &[NetworkRule] {
        &self.network_rules
    }

    /// 返回 host_executable 名称到路径映射的引用。
    pub fn host_executables(&self) -> &HashMap<String, Arc<[AbsolutePathBuf]>> {
        &self.host_executables_by_name
    }

    /// 收集所有决策为 `Allow` 的前缀规则，返回其前缀 token 列表。
    ///
    /// 结果经过排序和去重，供外部消费方（如 shell 自动补全）使用。
    pub fn get_allowed_prefixes(&self) -> Vec<Vec<String>> {
        let mut prefixes = Vec::new();

        for (_program, rules) in self.rules_by_program.iter_all() {
            for rule in rules {
                let Some(prefix_rule) = rule.as_any().downcast_ref::<PrefixRule>() else {
                    continue;
                };
                if prefix_rule.decision != Decision::Allow {
                    continue;
                }

                let mut prefix = Vec::with_capacity(prefix_rule.pattern.rest.len() + 1);
                prefix.push(prefix_rule.pattern.first.as_ref().to_string());
                prefix.extend(prefix_rule.pattern.rest.iter().map(render_pattern_token));
                prefixes.push(prefix);
            }
        }

        prefixes.sort();
        prefixes.dedup();
        prefixes
    }

    /// 向策略中追加一条前缀规则。
    ///
    /// `prefix` 的第一个 token 作为索引键，后续 token 转为 [`PatternToken::Single`]。
    ///
    /// # Errors
    /// 当 `prefix` 为空时返回 [`Error::InvalidPattern`]。
    pub fn add_prefix_rule(&mut self, prefix: &[String], decision: Decision) -> Result<()> {
        let (first_token, rest) = prefix
            .split_first()
            .ok_or_else(|| Error::InvalidPattern("prefix cannot be empty".to_string()))?;

        let rule: RuleRef = Arc::new(PrefixRule {
            pattern: PrefixPattern {
                first: Arc::from(first_token.as_str()),
                rest: rest
                    .iter()
                    .map(|token| PatternToken::Single(token.clone()))
                    .collect::<Vec<_>>()
                    .into(),
            },
            decision,
            justification: None,
        });

        self.rules_by_program.insert(first_token.clone(), rule);
        Ok(())
    }

    /// 向策略中追加一条网络规则。
    ///
    /// `host` 会经过 [`normalize_network_rule_host`] 规范化处理。
    ///
    /// # Errors
    /// 当 `host` 规范化失败，或 `justification` 为空白字符串时返回 [`Error::InvalidRule`]。
    pub fn add_network_rule(
        &mut self,
        host: &str,
        protocol: NetworkRuleProtocol,
        decision: Decision,
        justification: Option<String>,
    ) -> Result<()> {
        let host = normalize_network_rule_host(host)?;
        if let Some(raw) = justification.as_deref()
            && raw.trim().is_empty()
        {
            return Err(Error::InvalidRule(
                "justification cannot be empty".to_string(),
            ));
        }
        self.network_rules.push(NetworkRule {
            host,
            protocol,
            decision,
            justification,
        });
        Ok(())
    }

    /// 设置指定名称的 host_executable 允许路径列表，覆盖已有值。
    pub fn set_host_executable_paths(&mut self, name: String, paths: Vec<AbsolutePathBuf>) {
        self.host_executables_by_name.insert(name, paths.into());
    }

    /// 将 `overlay` 策略叠加到当前策略上，返回合并后的新策略。
    ///
    /// 合并规则：
    /// - 前缀规则：overlay 的规则追加到现有规则集合中（共存，不去重）
    /// - 网络规则：overlay 的规则追加到现有列表末尾
    /// - host_executable：overlay 的条目覆盖同名条目
    pub fn merge_overlay(&self, overlay: &Policy) -> Policy {
        let mut combined_rules = self.rules_by_program.clone();
        for (program, rules) in overlay.rules_by_program.iter_all() {
            for rule in rules {
                combined_rules.insert(program.clone(), rule.clone());
            }
        }

        let mut combined_network_rules = self.network_rules.clone();
        combined_network_rules.extend(overlay.network_rules.iter().cloned());

        let mut host_executables_by_name = self.host_executables_by_name.clone();
        host_executables_by_name.extend(
            overlay
                .host_executables_by_name
                .iter()
                .map(|(name, paths)| (name.clone(), paths.clone())),
        );

        Policy::from_parts(
            combined_rules,
            combined_network_rules,
            host_executables_by_name,
        )
    }

    /// 汇编网络规则，返回 `(allowed, denied)` 域名列表。
    ///
    /// 遍历网络规则列表，按决策分类：
    /// - `Allow`：将主机加入 allowed，从 denied 中移除
    /// - `Forbidden`：将主机加入 denied，从 allowed 中移除
    /// - `Prompt`：不改变 allowed/denied 列表
    ///
    /// 后定义的规则覆盖先前对同一主机的决策。
    pub fn compiled_network_domains(&self) -> (Vec<String>, Vec<String>) {
        let mut allowed = Vec::new();
        let mut denied = Vec::new();

        for rule in &self.network_rules {
            match rule.decision {
                Decision::Allow => {
                    denied.retain(|entry| entry != &rule.host);
                    upsert_domain(&mut allowed, &rule.host);
                }
                Decision::Forbidden => {
                    allowed.retain(|entry| entry != &rule.host);
                    upsert_domain(&mut denied, &rule.host);
                }
                Decision::Prompt => {}
            }
        }

        (allowed, denied)
    }

    /// 评估单条命令的执行决策。
    ///
    /// 等价于以默认 [`MatchOptions`] 调用 [`Self::check_with_options`]。
    /// 当无显式规则命中时，调用 `heuristics_fallback` 返回回退决策。
    pub fn check<F>(&self, cmd: &[String], heuristics_fallback: &F) -> Evaluation
    where
        F: Fn(&[String]) -> Decision,
    {
        let matched_rules = self.matches_for_command_with_options(
            cmd,
            Some(heuristics_fallback),
            &MatchOptions::default(),
        );
        Evaluation::from_matches(matched_rules)
    }

    /// 与 [`Self::check`] 等价，但允许通过 `options` 控制匹配行为（例如
    /// 启用 host_executable 解析）。
    pub fn check_with_options<F>(
        &self,
        cmd: &[String],
        heuristics_fallback: &F,
        options: &MatchOptions,
    ) -> Evaluation
    where
        F: Fn(&[String]) -> Decision,
    {
        let matched_rules =
            self.matches_for_command_with_options(cmd, Some(heuristics_fallback), options);
        Evaluation::from_matches(matched_rules)
    }

    /// 评估多条命令并聚合结果。
    ///
    /// 等价于以默认 [`MatchOptions`] 调用 [`Self::check_multiple_with_options`]。
    /// 所有命令的命中规则会被合并到一个 [`Evaluation`] 中，最终决策取最高优先级。
    pub fn check_multiple<Commands, F>(
        &self,
        commands: Commands,
        heuristics_fallback: &F,
    ) -> Evaluation
    where
        Commands: IntoIterator,
        Commands::Item: AsRef<[String]>,
        F: Fn(&[String]) -> Decision,
    {
        self.check_multiple_with_options(commands, heuristics_fallback, &MatchOptions::default())
    }

    /// 与 [`Self::check_multiple`] 等价，但允许通过 `options` 控制匹配行为。
    pub fn check_multiple_with_options<Commands, F>(
        &self,
        commands: Commands,
        heuristics_fallback: &F,
        options: &MatchOptions,
    ) -> Evaluation
    where
        Commands: IntoIterator,
        Commands::Item: AsRef<[String]>,
        F: Fn(&[String]) -> Decision,
    {
        let matched_rules: Vec<RuleMatch> = commands
            .into_iter()
            .flat_map(|command| {
                self.matches_for_command_with_options(
                    command.as_ref(),
                    Some(heuristics_fallback),
                    options,
                )
            })
            .collect();

        Evaluation::from_matches(matched_rules)
    }

    /// 返回与命令匹配的规则列表。
    ///
    /// 当没有显式规则命中且提供了 `heuristics_fallback` 时，返回一个
    /// `HeuristicsRuleMatch`，其决策由 `heuristics_fallback` 给出。
    ///
    /// 若 `heuristics_fallback.is_some()`，则返回的向量保证非空。
    pub fn matches_for_command(
        &self,
        cmd: &[String],
        heuristics_fallback: HeuristicsFallback<'_>,
    ) -> Vec<RuleMatch> {
        self.matches_for_command_with_options(cmd, heuristics_fallback, &MatchOptions::default())
    }

    /// 与 [`Self::matches_for_command`] 等价，但允许通过 `options` 控制匹配行为。
    ///
    /// 匹配流程：
    /// 1. 先按命令首 token 精确匹配前缀规则；
    /// 2. 若未命中且 `options.resolve_host_executables` 为真，则将首 token 视为
    ///    绝对路径，按 basename 匹配 host_executable 规则；
    /// 3. 仍未命中且提供了 `heuristics_fallback` 时，返回回退决策。
    pub fn matches_for_command_with_options(
        &self,
        cmd: &[String],
        heuristics_fallback: HeuristicsFallback<'_>,
        options: &MatchOptions,
    ) -> Vec<RuleMatch> {
        let matched_rules = self
            .match_exact_rules(cmd)
            .filter(|matched_rules| !matched_rules.is_empty())
            .or_else(|| {
                options
                    .resolve_host_executables
                    .then(|| self.match_host_executable_rules(cmd))
                    .filter(|matched_rules| !matched_rules.is_empty())
            })
            .unwrap_or_default();

        if matched_rules.is_empty()
            && let Some(heuristics_fallback) = heuristics_fallback
        {
            vec![RuleMatch::HeuristicsRuleMatch {
                command: cmd.to_vec(),
                decision: heuristics_fallback(cmd),
            }]
        } else {
            matched_rules
        }
    }

    /// 按命令首 token 精确匹配前缀规则。
    ///
    /// 返回 `None` 表示命令为空；返回空向量表示没有规则命中。
    fn match_exact_rules(&self, cmd: &[String]) -> Option<Vec<RuleMatch>> {
        let first = cmd.first()?;
        Some(
            self.rules_by_program
                .get_vec(first)
                .map(|rules| rules.iter().filter_map(|rule| rule.matches(cmd)).collect())
                .unwrap_or_default(),
        )
    }

    /// 按 host_executable basename 匹配前缀规则。
    ///
    /// 仅当首 token 为绝对路径、basename 命中规则索引，且路径出现在
    /// `host_executables_by_name` 允许列表中（若配置）时才匹配。命中后会把
    /// `RuleMatch` 的程序名改写为实际绝对路径，方便上层追溯。
    fn match_host_executable_rules(&self, cmd: &[String]) -> Vec<RuleMatch> {
        let Some(first) = cmd.first() else {
            return Vec::new();
        };
        let Ok(program) = AbsolutePathBuf::try_from(first.clone()) else {
            return Vec::new();
        };
        let Some(basename) = executable_path_lookup_key(program.as_path()) else {
            return Vec::new();
        };
        let Some(rules) = self.rules_by_program.get_vec(&basename) else {
            return Vec::new();
        };
        if let Some(paths) = self.host_executables_by_name.get(&basename)
            && !paths.iter().any(|path| path == &program)
        {
            return Vec::new();
        }

        let basename_command = std::iter::once(basename)
            .chain(cmd.iter().skip(1).cloned())
            .collect::<Vec<_>>();
        rules
            .iter()
            .filter_map(|rule| rule.matches(&basename_command))
            .map(|rule_match| rule_match.with_resolved_program(&program))
            .collect()
    }
}

/// 将 `host` 追加到 `entries` 末尾，并移除已有同值条目，保证最新决策生效。
fn upsert_domain(entries: &mut Vec<String>, host: &str) {
    entries.retain(|entry| entry != host);
    entries.push(host.to_string());
}

/// 把 [`PatternToken`] 渲染为人类可读字符串，供 shell 自动补全等场景使用。
fn render_pattern_token(token: &PatternToken) -> String {
    match token {
        PatternToken::Single(value) => value.clone(),
        PatternToken::Alts(alternatives) => format!("[{}]", alternatives.join("|")),
    }
}

/// 一次命令检查的聚合结果。
///
/// 包含最终决策与所有命中规则。最终决策取所有命中规则中优先级最高的一个
/// （`Deny` > `Allow` > `Prompt`）。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    /// 最终决策。
    pub decision: Decision,
    /// 命中的规则列表（按评估顺序保留）。
    #[serde(rename = "matchedRules")]
    pub matched_rules: Vec<RuleMatch>,
}

impl Evaluation {
    /// 是否至少有一条非启发式规则命中。
    ///
    /// 启发式回退产生的 `HeuristicsRuleMatch` 不计入“真实命中”，调用方可用此
    /// 方法判断结果是否来自显式策略。
    pub fn is_match(&self) -> bool {
        self.matched_rules
            .iter()
            .any(|rule_match| !matches!(rule_match, RuleMatch::HeuristicsRuleMatch { .. }))
    }

    /// 由命中规则列表构造 [`Evaluation`]。
    ///
    /// 调用方需保证 `matched_rules` 非空，否则会触发 panic。
    fn from_matches(matched_rules: Vec<RuleMatch>) -> Self {
        let decision = matched_rules.iter().map(RuleMatch::decision).max();
        #[expect(clippy::expect_used)]
        let decision = decision.expect("invariant failed: matched_rules must be non-empty");

        Self {
            decision,
            matched_rules,
        }
    }
}

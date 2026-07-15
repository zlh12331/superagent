//! requirements.toml 中的 `[rules]` 执行策略（execpolicy）解析。
//!
//! 本模块将 `requirements.toml` 中声明的 prefix rules 从 TOML 形式
//! 转换为 `codex-execpolicy` crate 使用的内部 `Policy` 表示。
//!
//! 与用户配置中的 execpolicy 不同，requirements 中的规则不允许
//! `allow` 决策（只能用 `prompt` 或 `forbidden`），因为 Codex 会将
//! 这些规则与其他配置合并并取最严格结果。

use codex_execpolicy::Decision;
use codex_execpolicy::Policy;
use codex_execpolicy::RuleRef;
use codex_execpolicy::rule::PatternToken;
use codex_execpolicy::rule::PrefixPattern;
use codex_execpolicy::rule::PrefixRule;
use multimap::MultiMap;
use serde::Deserialize;
use std::sync::Arc;
use thiserror::Error;

/// requirements exec policy 的运行时包装类型。
///
/// 通过指纹（fingerprint）实现 `PartialEq`，而非直接比较 `Policy` 内部结构，
/// 以避免 `Arc` 指针比较导致的语义错误。
#[derive(Debug, Clone)]
pub struct RequirementsExecPolicy {
    policy: Policy,
}

impl RequirementsExecPolicy {
    /// 从已有的 `Policy` 创建 `RequirementsExecPolicy`。
    pub fn new(policy: Policy) -> Self {
        Self { policy }
    }
}

impl PartialEq for RequirementsExecPolicy {
    fn eq(&self, other: &Self) -> bool {
        policy_fingerprint(&self.policy) == policy_fingerprint(&other.policy)
    }
}

impl Eq for RequirementsExecPolicy {}

impl AsRef<Policy> for RequirementsExecPolicy {
    fn as_ref(&self) -> &Policy {
        &self.policy
    }
}

/// 生成 `Policy` 的指纹（排序后的 `program:rule` 字符串列表）。
///
/// 用于 `PartialEq` 比较，确保两个语义相同但内部顺序不同的 `Policy`
/// 被视为相等。
fn policy_fingerprint(policy: &Policy) -> Vec<String> {
    let mut entries = Vec::new();
    for (program, rules) in policy.rules().iter_all() {
        for rule in rules {
            entries.push(format!("{program}:{rule:?}"));
        }
    }
    entries.sort();
    entries
}

/// `requirements.toml` 中 `[rules]` 的 TOML 表示。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RequirementsExecPolicyToml {
    /// prefix rule 列表，按声明顺序处理。
    pub prefix_rules: Vec<RequirementsExecPolicyPrefixRuleToml>,
}

/// `prefix_rule(...)` Starlark 内建函数的 TOML 表示。
///
/// 镜像 `execpolicy/src/parser.rs` 中定义的内建函数。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RequirementsExecPolicyPrefixRuleToml {
    /// 模式 token 列表，构成命令前缀匹配模式。
    pub pattern: Vec<RequirementsExecPolicyPatternTokenToml>,
    /// 决策（allow/prompt/forbidden）。requirements 中不允许 allow。
    pub decision: Option<RequirementsExecPolicyDecisionToml>,
    /// 规则的理由说明，不能为空。
    pub justification: Option<String>,
}

/// pattern token 的 TOML 友好表示。
///
/// Starlark 在每个位置支持字符串 token 或可选 token 列表，
/// 但 TOML 数组不能混合字符串与数组。使用 table 数组绕过此限制。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RequirementsExecPolicyPatternTokenToml {
    /// 单个 token 字符串。与 `any_of` 互斥。
    pub token: Option<String>,
    /// 可选 token 列表，匹配其中任一即可。与 `token` 互斥。
    pub any_of: Option<Vec<String>>,
}

/// exec policy 决策的 TOML 表示。
///
/// 序列化为 kebab-case（`allow`/`prompt`/`forbidden`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequirementsExecPolicyDecisionToml {
    Allow,
    Prompt,
    Forbidden,
}

impl RequirementsExecPolicyDecisionToml {
    /// 将 TOML 决策转换为 `codex-execpolicy` 的 `Decision` 枚举。
    fn as_decision(self) -> Decision {
        match self {
            Self::Allow => Decision::Allow,
            Self::Prompt => Decision::Prompt,
            Self::Forbidden => Decision::Forbidden,
        }
    }
}

/// requirements exec policy 解析错误。
///
/// 每个变体对应一种校验失败场景，携带 `rule_index` 和/或 `token_index`
/// 以便定位错误位置。
#[derive(Debug, Error)]
pub enum RequirementsExecPolicyParseError {
    /// `prefix_rules` 列表为空。
    #[error("rules prefix_rules cannot be empty")]
    EmptyPrefixRules,

    /// 指定索引的 rule 的 pattern 为空。
    #[error("rules prefix_rule at index {rule_index} has an empty pattern")]
    EmptyPattern { rule_index: usize },

    /// 指定索引的 rule 的 pattern token 无效。
    #[error(
        "rules prefix_rule at index {rule_index} has an invalid pattern token at index {token_index}: {reason}"
    )]
    InvalidPatternToken {
        rule_index: usize,
        token_index: usize,
        reason: String,
    },

    /// 指定索引的 rule 的 justification 为空。
    #[error("rules prefix_rule at index {rule_index} has an empty justification")]
    EmptyJustification { rule_index: usize },

    /// 指定索引的 rule 缺少 decision。
    #[error("rules prefix_rule at index {rule_index} is missing a decision")]
    MissingDecision { rule_index: usize },

    /// 指定索引的 rule 使用了 allow 决策，但 requirements 不允许 allow。
    /// Codex 会将这些规则与其他配置合并并取最严格结果，
    /// 应使用 prompt 或 forbidden。
    #[error(
        "rules prefix_rule at index {rule_index} has decision 'allow', which is not permitted in requirements.toml: Codex merges these rules with other config and uses the most restrictive result (use 'prompt' or 'forbidden')"
    )]
    AllowDecisionNotAllowed { rule_index: usize },
}

impl RequirementsExecPolicyToml {
    /// 将 requirements TOML 规则转换为 `codex-execpolicy` 使用的
    /// 内部 `.rules` 表示（`Policy`）。
    ///
    /// 校验流程：
    /// 1. `prefix_rules` 不能为空
    /// 2. 每条 rule 的 `justification`（若存在）不能为空白
    /// 3. 每条 rule 的 `pattern` 不能为空
    /// 4. 每个 pattern token 必须有效（`token` 或 `any_of` 二选一）
    /// 5. decision 不能是 `allow`（requirements 中禁止）
    /// 6. decision 不能缺失
    ///
    /// # Errors
    /// 当任一校验失败时返回对应的 `RequirementsExecPolicyParseError`。
    pub fn to_policy(&self) -> Result<Policy, RequirementsExecPolicyParseError> {
        if self.prefix_rules.is_empty() {
            return Err(RequirementsExecPolicyParseError::EmptyPrefixRules);
        }

        let mut rules_by_program: MultiMap<String, RuleRef> = MultiMap::new();

        for (rule_index, rule) in self.prefix_rules.iter().enumerate() {
            // justification 若存在则不能为空白字符串。
            if let Some(justification) = &rule.justification
                && justification.trim().is_empty()
            {
                return Err(RequirementsExecPolicyParseError::EmptyJustification { rule_index });
            }

            if rule.pattern.is_empty() {
                return Err(RequirementsExecPolicyParseError::EmptyPattern { rule_index });
            }

            let pattern_tokens = rule
                .pattern
                .iter()
                .enumerate()
                .map(|(token_index, token)| parse_pattern_token(token, rule_index, token_index))
                .collect::<Result<Vec<_>, _>>()?;

            // requirements 中禁止 allow 决策。
            let decision = match rule.decision {
                Some(RequirementsExecPolicyDecisionToml::Allow) => {
                    return Err(RequirementsExecPolicyParseError::AllowDecisionNotAllowed {
                        rule_index,
                    });
                }
                Some(decision) => decision.as_decision(),
                None => {
                    return Err(RequirementsExecPolicyParseError::MissingDecision { rule_index });
                }
            };
            let justification = rule.justification.clone();

            // 第一个 token 可能展开为多个 alternative（any_of），
            // 需要为每个 alternative 创建独立的 rule。
            let (first_token, remaining_tokens) = pattern_tokens
                .split_first()
                .ok_or(RequirementsExecPolicyParseError::EmptyPattern { rule_index })?;

            let rest: Arc<[PatternToken]> = remaining_tokens.to_vec().into();

            for head in first_token.alternatives() {
                let rule: RuleRef = Arc::new(PrefixRule {
                    pattern: PrefixPattern {
                        first: Arc::from(head.as_str()),
                        rest: rest.clone(),
                    },
                    decision,
                    justification: justification.clone(),
                });
                rules_by_program.insert(head.clone(), rule);
            }
        }

        Ok(Policy::new(rules_by_program))
    }

    /// 将 TOML 规则转换为 `RequirementsExecPolicy` 包装类型。
    pub(crate) fn to_requirements_policy(
        &self,
    ) -> Result<RequirementsExecPolicy, RequirementsExecPolicyParseError> {
        self.to_policy().map(RequirementsExecPolicy::new)
    }
}

/// 解析单个 pattern token，校验 `token` 与 `any_of` 的互斥性与非空性。
///
/// # 参数
/// - `token`: 待解析的 TOML pattern token
/// - `rule_index`: 所属 rule 的索引（用于错误定位）
/// - `token_index`: 该 token 在 pattern 中的索引（用于错误定位）
///
/// # Errors
/// - `token` 与 `any_of` 同时设置或都未设置
/// - `token` 为空白字符串
/// - `any_of` 为空列表或包含空白字符串
fn parse_pattern_token(
    token: &RequirementsExecPolicyPatternTokenToml,
    rule_index: usize,
    token_index: usize,
) -> Result<PatternToken, RequirementsExecPolicyParseError> {
    match (&token.token, &token.any_of) {
        (Some(single), None) => {
            if single.trim().is_empty() {
                return Err(RequirementsExecPolicyParseError::InvalidPatternToken {
                    rule_index,
                    token_index,
                    reason: "token cannot be empty".to_string(),
                });
            }
            Ok(PatternToken::Single(single.clone()))
        }
        (None, Some(alternatives)) => {
            if alternatives.is_empty() {
                return Err(RequirementsExecPolicyParseError::InvalidPatternToken {
                    rule_index,
                    token_index,
                    reason: "any_of cannot be empty".to_string(),
                });
            }
            if alternatives.iter().any(|alt| alt.trim().is_empty()) {
                return Err(RequirementsExecPolicyParseError::InvalidPatternToken {
                    rule_index,
                    token_index,
                    reason: "any_of cannot include empty tokens".to_string(),
                });
            }
            Ok(PatternToken::Alts(alternatives.clone()))
        }
        (Some(_), Some(_)) => Err(RequirementsExecPolicyParseError::InvalidPatternToken {
            rule_index,
            token_index,
            reason: "set either token or any_of, not both".to_string(),
        }),
        (None, None) => Err(RequirementsExecPolicyParseError::InvalidPatternToken {
            rule_index,
            token_index,
            reason: "set either token or any_of".to_string(),
        }),
    }
}

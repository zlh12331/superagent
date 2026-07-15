//! Starlark 策略文件解析器。
//!
//! 将以 Starlark DSL 编写的 execpolicy 文件解析为 [`crate::policy::Policy`]。
//! [`PolicyParser`] 负责调度 Starlark 解释器，并通过 `policy_builtins` 模块
//! 暴露 `prefix_rule` / `network_rule` / `host_executable` 等内建函数，供策略
//! 文件调用以注册规则。解析过程中会收集"待校验示例"（match / not_match），
//! 在每次 `parse` 末尾对最近一批规则进行示例验证，确保规则的预期行为与
//! 策略作者写下的示例一致。

use codex_utils_absolute_path::AbsolutePathBuf;
use multimap::MultiMap;
use starlark::any::ProvidesStaticType;
use starlark::codemap::FileSpan;
use starlark::environment::GlobalsBuilder;
use starlark::environment::Module;
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::syntax::AstModule;
use starlark::syntax::Dialect;
use starlark::values::Value;
use starlark::values::list::ListRef;
use starlark::values::list::UnpackList;
use starlark::values::none::NoneType;
use std::cell::RefCell;
use std::cell::RefMut;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::decision::Decision;
use crate::error::Error;
use crate::error::ErrorLocation;
use crate::error::Result;
use crate::error::TextPosition;
use crate::error::TextRange;
use crate::executable_name::executable_lookup_key;
use crate::executable_name::executable_path_lookup_key;
use crate::rule::NetworkRule;
use crate::rule::NetworkRuleProtocol;
use crate::rule::PatternToken;
use crate::rule::PrefixPattern;
use crate::rule::PrefixRule;
use crate::rule::RuleRef;
use crate::rule::validate_match_examples;
use crate::rule::validate_not_match_examples;

/// execpolicy 文件解析器，面向多次追加解析的场景。
///
/// 内部持有 [`PolicyBuilder`]（通过 [`RefCell`] 实现可变借用），允许连续
/// 调用 [`PolicyParser::parse`] 解析多个策略文件并累积规则；最终通过
/// [`PolicyParser::build`] 收尾生成不可变的 [`crate::policy::Policy`]。
pub struct PolicyParser {
    /// 解析过程中累积规则与待校验示例的构建器。
    builder: RefCell<PolicyBuilder>,
}

impl Default for PolicyParser {
    fn default() -> Self {
        Self::new()
    }
}

impl PolicyParser {
    /// 创建一个空解析器，内部规则集合为空。
    pub fn new() -> Self {
        Self {
            builder: RefCell::new(PolicyBuilder::new()),
        }
    }

    /// 解析单个策略文件内容，将其中通过 `prefix_rule` / `network_rule` /
    /// `host_executable` 注册的规则追加到当前解析器。
    ///
    /// `policy_identifier` 通常为文件路径，会作为错误上下文附带在解析失败
    /// 信息中，便于定位是哪个策略文件出问题。解析完成后，会对本次新增的
    /// 待校验示例进行验证，确保规则行为与示例一致。
    ///
    /// # Errors
    /// - Starlark 语法错误返回 [`Error::Starlark`]
    /// - 规则或示例校验失败返回对应的 [`Error::InvalidRule`] /
    ///   [`Error::InvalidPattern`] / [`Error::InvalidExample`]
    pub fn parse(&mut self, policy_identifier: &str, policy_file_contents: &str) -> Result<()> {
        let pending_validation_count = self.builder.borrow().pending_example_validations.len();
        let mut dialect = Dialect::Extended.clone();
        dialect.enable_f_strings = true;
        let ast = AstModule::parse(
            policy_identifier,
            policy_file_contents.to_string(),
            &dialect,
        )
        .map_err(Error::Starlark)?;
        let globals = GlobalsBuilder::standard().with(policy_builtins).build();
        Module::with_temp_heap(|module| {
            let mut eval = Evaluator::new(&module);
            eval.extra = Some(&self.builder);
            eval.eval_module(ast, &globals)
                .map(|_| ())
                .map_err(Error::Starlark)
        })?;
        self.builder
            .borrow()
            .validate_pending_examples_from(pending_validation_count)?;
        Ok(())
    }

    /// 消费解析器，将累积的规则构建为最终的 [`crate::policy::Policy`]。
    ///
    /// 调用后解析器不可再使用。
    pub fn build(self) -> crate::policy::Policy {
        self.builder.into_inner().build()
    }
}

/// 解析过程中的策略构建器，累积各类规则与待校验示例。
///
/// 通过 Starlark 内建函数（`prefix_rule` 等）填充，最终通过 [`build`]
/// 转换为 [`crate::policy::Policy`]。需实现 [`ProvidesStaticType`] 以便作为
/// Starlark `Evaluator.extra` 挂载的可变状态。
///
/// [`build`]: PolicyBuilder::build
#[derive(Debug, ProvidesStaticType)]
struct PolicyBuilder {
    /// 按程序名（命令首 token）索引的前缀规则集合。
    rules_by_program: MultiMap<String, RuleRef>,
    /// 网络访问规则列表，按定义顺序保留。
    network_rules: Vec<NetworkRule>,
    /// host_executable 名称到允许的绝对路径列表的映射。
    host_executables_by_name: HashMap<String, Arc<[AbsolutePathBuf]>>,
    /// 待校验的示例列表，每次 `parse` 末尾按批次校验。
    pending_example_validations: Vec<PendingExampleValidation>,
}

impl PolicyBuilder {
    fn new() -> Self {
        Self {
            rules_by_program: MultiMap::new(),
            network_rules: Vec::new(),
            host_executables_by_name: HashMap::new(),
            pending_example_validations: Vec::new(),
        }
    }

    /// 添加一条前缀规则，按程序名（首 token）插入索引。
    fn add_rule(&mut self, rule: RuleRef) {
        self.rules_by_program
            .insert(rule.program().to_string(), rule);
    }

    /// 追加一条网络规则到列表末尾。
    fn add_network_rule(&mut self, rule: NetworkRule) {
        self.network_rules.push(rule);
    }

    /// 注册一个 host_executable 名称到允许路径列表的映射，覆盖已有同名条目。
    fn add_host_executable(&mut self, name: String, paths: Vec<AbsolutePathBuf>) {
        self.host_executables_by_name.insert(name, paths.into());
    }

    /// 添加一批待校验示例，关联本次注册的规则及可选的错误位置。
    fn add_pending_example_validation(
        &mut self,
        rules: Vec<RuleRef>,
        matches: Vec<Vec<String>>,
        not_matches: Vec<Vec<String>>,
        location: Option<ErrorLocation>,
    ) {
        self.pending_example_validations
            .push(PendingExampleValidation {
                rules,
                matches,
                not_matches,
                location,
            });
    }

    /// 校验从索引 `start` 起的待校验示例。
    ///
    /// 对每批待校验项临时构造一个迷你策略，调用
    /// [`validate_not_match_examples`] 与 [`validate_match_examples`]
    /// 确保 `not_match` 示例确实不命中，`match` 示例确实命中。
    ///
    /// # Errors
    /// 任一示例校验失败时返回对应错误，并附带原位置信息（若存在）。
    fn validate_pending_examples_from(&self, start: usize) -> Result<()> {
        for validation in &self.pending_example_validations[start..] {
            let mut rules_by_program = MultiMap::new();
            for rule in &validation.rules {
                rules_by_program.insert(rule.program().to_string(), rule.clone());
            }

            let policy = crate::policy::Policy::from_parts(
                rules_by_program,
                Vec::new(),
                self.host_executables_by_name.clone(),
            );
            validate_not_match_examples(&policy, &validation.rules, &validation.not_matches)
                .map_err(|error| attach_validation_location(error, validation.location.clone()))?;
            validate_match_examples(&policy, &validation.rules, &validation.matches)
                .map_err(|error| attach_validation_location(error, validation.location.clone()))?;
        }

        Ok(())
    }

    /// 消费构建器，将累积的规则组装为最终的 [`crate::policy::Policy`]。
    fn build(self) -> crate::policy::Policy {
        crate::policy::Policy::from_parts(
            self.rules_by_program,
            self.network_rules,
            self.host_executables_by_name,
        )
    }
}

/// 一批待校验的示例，关联到注册时产生的规则集合。
///
/// 用于在 `parse` 结束时验证规则的预期行为：`matches` 中的示例必须命中
/// 这些规则，`not_matches` 中的示例必须不命中。`location` 提供错误上下文
/// 以便定位到策略文件的具体位置。
#[derive(Debug)]
struct PendingExampleValidation {
    /// 本批次关联的规则列表。
    rules: Vec<RuleRef>,
    /// 必须命中的示例（每个示例为命令 token 序列）。
    matches: Vec<Vec<String>>,
    /// 必须不命中的示例。
    not_matches: Vec<Vec<String>>,
    /// 注册时的位置信息（用于错误上下文），来自 Starlark 调用栈顶部。
    location: Option<ErrorLocation>,
}

/// 将 Starlark 列表解析为 pattern token 序列。
///
/// 每个元素可以是字符串（单选）或字符串列表（多选一），空列表返回
/// [`Error::InvalidPattern`]。
fn parse_pattern<'v>(pattern: UnpackList<Value<'v>>) -> Result<Vec<PatternToken>> {
    let tokens: Vec<PatternToken> = pattern
        .items
        .into_iter()
        .map(parse_pattern_token)
        .collect::<Result<_>>()?;
    if tokens.is_empty() {
        Err(Error::InvalidPattern("pattern cannot be empty".to_string()))
    } else {
        Ok(tokens)
    }
}

/// 将单个 Starlark 值解析为 [`PatternToken`]。
///
/// - 字符串 → [`PatternToken::Single`]
/// - 非空字符串列表 → [`PatternToken::Alts`]（仅 1 个元素时退化为 `Single`）
/// - 其他类型返回 [`Error::InvalidPattern`]
fn parse_pattern_token<'v>(value: Value<'v>) -> Result<PatternToken> {
    if let Some(s) = value.unpack_str() {
        Ok(PatternToken::Single(s.to_string()))
    } else if let Some(list) = ListRef::from_value(value) {
        let tokens: Vec<String> = list
            .content()
            .iter()
            .map(|value| {
                value
                    .unpack_str()
                    .ok_or_else(|| {
                        Error::InvalidPattern(format!(
                            "pattern alternative must be a string (got {})",
                            value.get_type()
                        ))
                    })
                    .map(str::to_string)
            })
            .collect::<Result<_>>()?;

        match tokens.as_slice() {
            [] => Err(Error::InvalidPattern(
                "pattern alternatives cannot be empty".to_string(),
            )),
            [single] => Ok(PatternToken::Single(single.clone())),
            _ => Ok(PatternToken::Alts(tokens)),
        }
    } else {
        Err(Error::InvalidPattern(format!(
            "pattern element must be a string or list of strings (got {})",
            value.get_type()
        )))
    }
}

/// 将 Starlark 示例列表解析为 token 序列列表。
///
/// 每个示例可以是字符串（按 shell 语法拆分）或字符串列表（直接作为 token 序列），
/// 任一示例解析失败即返回错误。
fn parse_examples<'v>(examples: UnpackList<Value<'v>>) -> Result<Vec<Vec<String>>> {
    examples.items.into_iter().map(parse_example).collect()
}

/// 将字符串解析为绝对路径 [`AbsolutePathBuf`]。
///
/// 非绝对路径会返回 [`Error::InvalidRule`]。
fn parse_literal_absolute_path(raw: &str) -> Result<AbsolutePathBuf> {
    if !Path::new(raw).is_absolute() {
        return Err(Error::InvalidRule(format!(
            "host_executable paths must be absolute (got {raw})"
        )));
    }

    AbsolutePathBuf::try_from(raw.to_string())
        .map_err(|error| Error::InvalidRule(format!("invalid absolute path `{raw}`: {error}")))
}

/// 校验 host_executable 名称必须是裸可执行文件名（不含路径分隔符）。
///
/// # Errors
/// 名称为空或包含路径组件时返回 [`Error::InvalidRule`]。
fn validate_host_executable_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::InvalidRule(
            "host_executable name cannot be empty".to_string(),
        ));
    }

    let path = Path::new(name);
    if path.components().count() != 1
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
    {
        return Err(Error::InvalidRule(format!(
            "host_executable name must be a bare executable name (got {name})"
        )));
    }

    Ok(())
}

/// 将网络规则的决策字符串解析为 [`Decision`]。
///
/// `"deny"` 作为 [`Decision::Forbidden`] 的别名，其他值委托给
/// [`Decision::parse`]。
fn parse_network_rule_decision(raw: &str) -> Result<Decision> {
    match raw {
        "deny" => Ok(Decision::Forbidden),
        other => Decision::parse(other),
    }
}

/// 将 Starlark 的 [`FileSpan`] 转换为 [`ErrorLocation`]。
///
/// 行列号从 0-based 转为 1-based，便于在错误信息中直接展示给用户。
fn error_location_from_file_span(span: FileSpan) -> ErrorLocation {
    let resolved = span.resolve_span();
    ErrorLocation {
        path: span.filename().to_string(),
        range: TextRange {
            start: TextPosition {
                line: resolved.begin.line + 1,
                column: resolved.begin.column + 1,
            },
            end: TextPosition {
                line: resolved.end.line + 1,
                column: resolved.end.column + 1,
            },
        },
    }
}

/// 为错误附加位置信息，若 `location` 为 `None` 则原样返回错误。
fn attach_validation_location(error: Error, location: Option<ErrorLocation>) -> Error {
    match location {
        Some(location) => error.with_location(location),
        None => error,
    }
}

/// 将单个 Starlark 值解析为示例 token 序列。
///
/// 字符串按 shell 语法拆分，列表直接作为 token 序列。其他类型返回
/// [`Error::InvalidExample`]。
fn parse_example<'v>(value: Value<'v>) -> Result<Vec<String>> {
    if let Some(raw) = value.unpack_str() {
        parse_string_example(raw)
    } else if let Some(list) = ListRef::from_value(value) {
        parse_list_example(list)
    } else {
        Err(Error::InvalidExample(format!(
            "example must be a string or list of strings (got {})",
            value.get_type()
        )))
    }
}

/// 将字符串示例按 shell 语法拆分为 token 序列。
///
/// # Errors
/// - 非法 shell 语法返回 [`Error::InvalidExample`]
/// - 空字符串（拆分后为空 token 序列）返回 [`Error::InvalidExample`]
fn parse_string_example(raw: &str) -> Result<Vec<String>> {
    let tokens = shlex::split(raw).ok_or_else(|| {
        Error::InvalidExample("example string has invalid shell syntax".to_string())
    })?;

    if tokens.is_empty() {
        Err(Error::InvalidExample(
            "example cannot be an empty string".to_string(),
        ))
    } else {
        Ok(tokens)
    }
}

/// 将列表示例转换为 token 序列，要求所有元素均为字符串。
///
/// # Errors
/// 元素非字符串或列表为空时返回 [`Error::InvalidExample`]。
fn parse_list_example(list: &ListRef) -> Result<Vec<String>> {
    let tokens: Vec<String> = list
        .content()
        .iter()
        .map(|value| {
            value
                .unpack_str()
                .ok_or_else(|| {
                    Error::InvalidExample(format!(
                        "example tokens must be strings (got {})",
                        value.get_type()
                    ))
                })
                .map(str::to_string)
        })
        .collect::<Result<_>>()?;

    if tokens.is_empty() {
        Err(Error::InvalidExample(
            "example cannot be an empty list".to_string(),
        ))
    } else {
        Ok(tokens)
    }
}

/// 从 Starlark `Evaluator.extra` 中借用 [`PolicyBuilder`] 的可变引用。
///
/// Starlark 内建函数通过此函数访问共享的构建器状态。
fn policy_builder<'v, 'a>(eval: &Evaluator<'v, 'a, '_>) -> RefMut<'a, PolicyBuilder> {
    #[expect(clippy::expect_used)]
    eval.extra
        .as_ref()
        .expect("policy_builder requires Evaluator.extra to be populated")
        .downcast_ref::<RefCell<PolicyBuilder>>()
        .expect("Evaluator.extra must contain a PolicyBuilder")
        .borrow_mut()
}

/// Starlark 内建函数集合，注册为策略文件可调用的全局函数。
///
/// 包含三个函数：
/// - `prefix_rule(pattern, decision=None, match=None, not_match=None, justification=None)`
/// - `network_rule(host, protocol, decision, justification=None)`
/// - `host_executable(name, paths)`
#[starlark_module]
fn policy_builtins(builder: &mut GlobalsBuilder) {
    /// Starlark 内建函数：注册一条前缀规则。
    ///
    /// `pattern` 为 token 序列，每个 token 可以是字符串或字符串列表（多选一），
    /// 第一个 token 的每个备选都会展开为独立的规则。`decision` 省略时默认
    /// `Allow`。`match` / `not_match` 用于在解析末尾校验规则行为是否符合预期。
    /// `justification` 为人类可读的规则说明，非空字符串。
    fn prefix_rule<'v>(
        pattern: UnpackList<Value<'v>>,
        decision: Option<&'v str>,
        r#match: Option<UnpackList<Value<'v>>>,
        not_match: Option<UnpackList<Value<'v>>>,
        justification: Option<&'v str>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        let decision = match decision {
            Some(raw) => Decision::parse(raw)?,
            None => Decision::Allow,
        };

        let justification = match justification {
            Some(raw) if raw.trim().is_empty() => {
                return Err(Error::InvalidRule("justification cannot be empty".to_string()).into());
            }
            Some(raw) => Some(raw.to_string()),
            None => None,
        };

        let pattern_tokens = parse_pattern(pattern)?;

        let matches: Vec<Vec<String>> =
            r#match.map(parse_examples).transpose()?.unwrap_or_default();
        let not_matches: Vec<Vec<String>> = not_match
            .map(parse_examples)
            .transpose()?
            .unwrap_or_default();
        let location = eval
            .call_stack_top_location()
            .map(error_location_from_file_span);

        let mut builder = policy_builder(eval);

        let (first_token, remaining_tokens) = pattern_tokens
            .split_first()
            .ok_or_else(|| Error::InvalidPattern("pattern cannot be empty".to_string()))?;

        let rest: Arc<[PatternToken]> = remaining_tokens.to_vec().into();

        // 第一个 token 的每个备选都会展开为一条独立的 PrefixRule，
        // 共享相同的剩余 token 序列与决策。
        let rules: Vec<RuleRef> = first_token
            .alternatives()
            .iter()
            .map(|head| {
                Arc::new(PrefixRule {
                    pattern: PrefixPattern {
                        first: Arc::from(head.as_str()),
                        rest: rest.clone(),
                    },
                    decision,
                    justification: justification.clone(),
                }) as RuleRef
            })
            .collect();

        builder.add_pending_example_validation(rules.clone(), matches, not_matches, location);
        rules.into_iter().for_each(|rule| builder.add_rule(rule));
        Ok(NoneType)
    }

    /// Starlark 内建函数：注册一条网络访问规则。
    ///
    /// `host` 为目标主机名，`protocol` 为协议（如 `tcp`、`udp`），`decision`
    /// 为 `allow` / `deny` / `ask` 等。`justification` 为可空说明，非空时
    /// 不能为空白字符串。
    fn network_rule<'v>(
        host: &'v str,
        protocol: &'v str,
        decision: &'v str,
        justification: Option<&'v str>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        let protocol = NetworkRuleProtocol::parse(protocol)?;
        let decision = parse_network_rule_decision(decision)?;
        let justification = match justification {
            Some(raw) if raw.trim().is_empty() => {
                return Err(Error::InvalidRule("justification cannot be empty".to_string()).into());
            }
            Some(raw) => Some(raw.to_string()),
            None => None,
        };

        let mut builder = policy_builder(eval);
        builder.add_network_rule(NetworkRule {
            host: crate::rule::normalize_network_rule_host(host)?,
            protocol,
            decision,
            justification,
        });
        Ok(NoneType)
    }

    /// Starlark 内建函数：注册一个 host_executable 名称到允许路径列表的映射。
    ///
    /// `name` 必须是裸可执行文件名（无路径分隔符），`paths` 中的每个路径
    /// 必须是绝对路径且 basename 与 `name` 一致（按规范化后的 lookup key 比较），
    /// 重复路径会被去重。
    fn host_executable<'v>(
        name: &'v str,
        paths: UnpackList<Value<'v>>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        validate_host_executable_name(name)?;

        let mut parsed_paths = Vec::new();
        for value in paths.items {
            let raw = value.unpack_str().ok_or_else(|| {
                Error::InvalidRule(format!(
                    "host_executable paths must be strings (got {})",
                    value.get_type()
                ))
            })?;
            let path = parse_literal_absolute_path(raw)?;
            let Some(path_name) = executable_path_lookup_key(path.as_path()) else {
                return Err(Error::InvalidRule(format!(
                    "host_executable path `{raw}` must have basename `{name}`"
                ))
                .into());
            };
            // basename 必须与声明的 name 一致，防止策略文件写入错误路径。
            if path_name != executable_lookup_key(name) {
                return Err(Error::InvalidRule(format!(
                    "host_executable path `{raw}` must have basename `{name}`"
                ))
                .into());
            }
            // 去重，保留首次出现的路径。
            if !parsed_paths.iter().any(|existing| existing == &path) {
                parsed_paths.push(path);
            }
        }

        policy_builder(eval).add_host_executable(executable_lookup_key(name), parsed_paths);
        Ok(NoneType)
    }
}

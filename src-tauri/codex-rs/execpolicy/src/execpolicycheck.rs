use std::fs;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use clap::Parser;
use serde::Serialize;

use crate::Decision;
use crate::MatchOptions;
use crate::Policy;
use crate::PolicyParser;
use crate::RuleMatch;

/// CLI `check` 子命令参数：依据一个或多个 execpolicy 文件评估给定命令。
#[derive(Debug, Parser, Clone)]
pub struct ExecPolicyCheckCommand {
    /// 待加载的 execpolicy 规则文件路径（可重复指定）。
    #[arg(short = 'r', long = "rules", value_name = "PATH", required = true)]
    pub rules: Vec<PathBuf>,

    /// 是否美化输出 JSON。
    #[arg(long)]
    pub pretty: bool,

    /// 是否按 basename 解析命令首 token 的绝对路径，并匹配策略中
    /// `host_executable()` 定义的规则。
    #[arg(long)]
    pub resolve_host_executables: bool,

    /// 待检查的命令 token 列表。
    #[arg(
        value_name = "COMMAND",
        required = true,
        trailing_var_arg = true,
        allow_hyphen_values = true
    )]
    pub command: Vec<String>,
}

impl ExecPolicyCheckCommand {
    /// 加载策略文件、评估命令并打印 JSON 结果。
    pub fn run(&self) -> Result<()> {
        let policy = load_policies(&self.rules)?;
        let matched_rules = policy.matches_for_command_with_options(
            &self.command,
            /*heuristics_fallback*/ None,
            &MatchOptions {
                resolve_host_executables: self.resolve_host_executables,
            },
        );

        let json = format_matches_json(&matched_rules, self.pretty)?;
        println!("{json}");

        Ok(())
    }
}

/// 将命中规则序列化为 JSON 字符串。
///
/// `pretty` 为真时使用美化输出格式。返回的 JSON 包含 `matchedRules` 与
/// 顶层 `decision`（取所有命中决策中的最大值，无命中时为 `None`）。
pub fn format_matches_json(matched_rules: &[RuleMatch], pretty: bool) -> Result<String> {
    let output = ExecPolicyCheckOutput {
        matched_rules,
        decision: matched_rules.iter().map(RuleMatch::decision).max(),
    };

    if pretty {
        serde_json::to_string_pretty(&output).map_err(Into::into)
    } else {
        serde_json::to_string(&output).map_err(Into::into)
    }
}

/// 顺序加载多个策略文件并合并为一个 [`Policy`]。
///
/// 后加载的文件通过 [`PolicyParser::parse`] 解析后追加到当前策略；
/// 任一文件读取或解析失败都会返回带文件路径上下文的错误。
pub fn load_policies(policy_paths: &[PathBuf]) -> Result<Policy> {
    let mut parser = PolicyParser::new();

    for policy_path in policy_paths {
        let policy_file_contents = fs::read_to_string(policy_path)
            .with_context(|| format!("failed to read policy at {}", policy_path.display()))?;
        let policy_identifier = policy_path.to_string_lossy().to_string();
        parser
            .parse(&policy_identifier, &policy_file_contents)
            .with_context(|| format!("failed to parse policy at {}", policy_path.display()))?;
    }

    Ok(parser.build())
}

/// `execpolicy check` 命令的 JSON 输出结构。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecPolicyCheckOutput<'a> {
    /// 命中的规则列表。
    #[serde(rename = "matchedRules")]
    matched_rules: &'a [RuleMatch],
    /// 命中规则中的最高决策；无命中时省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<Decision>,
}

use anyhow::Result;
use clap::Parser;
use codex_execpolicy::ExecPolicyCheckCommand;

/// codex-execpolicy CLI 入口。
///
/// 当前仅提供 `check` 子命令，用于按一组策略文件评估一条命令。
#[derive(Parser)]
#[command(name = "codex-execpolicy")]
enum Cli {
    /// 按策略文件评估一条命令。
    Check(ExecPolicyCheckCommand),
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli {
        Cli::Check(cmd) => cmd.run(),
    }
}

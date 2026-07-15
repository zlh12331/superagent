//! 与 `--sandbox`（`-s`）CLI 选项配合使用的标准类型。
//!
//! 该类型 mirrors 了 [`codex_protocol::protocol::SandboxPolicy`] 的各个
//! variants，但不携带任何关联数据，因此可以在命令行上以简单的 flag 形式
//! 表达。需要微调 `workspace-write` 高级选项的用户，仍可通过 `-c` overrides
//! 或其 `config.toml` 进行配置。

use clap::ValueEnum;
use codex_protocol::config_types::SandboxMode;

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum SandboxModeCliArg {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl From<SandboxModeCliArg> for SandboxMode {
    fn from(value: SandboxModeCliArg) -> Self {
        match value {
            SandboxModeCliArg::ReadOnly => SandboxMode::ReadOnly,
            SandboxModeCliArg::WorkspaceWrite => SandboxMode::WorkspaceWrite,
            SandboxModeCliArg::DangerFullAccess => SandboxMode::DangerFullAccess,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn maps_cli_args_to_protocol_modes() {
        assert_eq!(SandboxMode::ReadOnly, SandboxModeCliArg::ReadOnly.into());
        assert_eq!(
            SandboxMode::WorkspaceWrite,
            SandboxModeCliArg::WorkspaceWrite.into()
        );
        assert_eq!(
            SandboxMode::DangerFullAccess,
            SandboxModeCliArg::DangerFullAccess.into()
        );
    }
}

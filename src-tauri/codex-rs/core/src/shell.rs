//! Shell 管理模块。
//!
//! 封装当前环境的 shell 信息(类型与可执行文件路径),并提供将命令字符串
//! 转换为 `exec()` 调用所需参数列表的能力。
//!
//! # 与其他模块的关系
//! - [`crate::exec`] 与 [`crate::spawn`] 通过本模块确定 shell 调用参数;
//! - 上层通过 [`Shell`] 在 UI 中展示当前 shell 类型;
//! - 支持从 [`DetectedShell`](codex_shell_command::shell_detect::DetectedShell)
//!   或 [`ShellInfo`] 构造实例。

use codex_exec_server::ShellInfo;
use codex_shell_command::shell_detect::DetectedShell;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

pub use codex_shell_command::shell_detect::ShellType;

/// 当前环境的 shell 描述信息。
///
/// 持有 shell 类型与对应的可执行文件路径,用于在执行命令时构造正确的调用参数。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Shell {
    pub(crate) shell_type: ShellType,
    pub(crate) shell_path: PathBuf,
}

impl Shell {
    /// 返回 shell 的可读名称(如 `zsh`、`bash`、`powershell`)。
    pub fn name(&self) -> &'static str {
        self.shell_type.name()
    }

    /// 根据命令字符串与登录 shell 偏好,返回可直接传给 `exec()` 的参数列表。
    ///
    /// # 参数
    /// - `command`:要在 shell 中执行的命令字符串。
    /// - `use_login_shell`:是否以登录 shell 方式执行(影响是否加载 profile / 是否使用 `-lc`)。
    ///
    /// # 返回
    /// 返回的 `Vec<String>` 第一个元素为 shell 可执行文件路径,后续元素为该 shell
    /// 特定的参数(zsh/bash/sh 使用 `-c` 或 `-lc`;PowerShell 使用 `-Command` 且可加 `-NoProfile`;
    /// cmd 使用 `/c`)。
    pub fn derive_exec_args(&self, command: &str, use_login_shell: bool) -> Vec<String> {
        match self.shell_type {
            ShellType::Zsh | ShellType::Bash | ShellType::Sh => {
                let arg = if use_login_shell { "-lc" } else { "-c" };
                vec![
                    self.shell_path.to_string_lossy().to_string(),
                    arg.to_string(),
                    command.to_string(),
                ]
            }
            ShellType::PowerShell => {
                let mut args = vec![self.shell_path.to_string_lossy().to_string()];
                // 非登录 shell 模式下显式跳过 profile 加载,确保执行环境一致。
                if !use_login_shell {
                    args.push("-NoProfile".to_string());
                }

                args.push("-Command".to_string());
                args.push(command.to_string());
                args
            }
            ShellType::Cmd => {
                let mut args = vec![self.shell_path.to_string_lossy().to_string()];
                args.push("/c".to_string());
                args.push(command.to_string());
                args
            }
        }
    }
}

impl From<DetectedShell> for Shell {
    fn from(detected: DetectedShell) -> Self {
        Self {
            shell_type: detected.shell_type,
            shell_path: detected.shell_path,
        }
    }
}

impl Shell {
    /// 根据来自 exec server 的 [`ShellInfo`] 构造 [`Shell`]。
    ///
    /// # 错误
    /// 若 `shell_info.name` 不是已知 shell 类型(zsh / bash / powershell / sh / cmd),
    /// 返回 `Err`。
    pub(crate) fn from_environment_shell_info(shell_info: ShellInfo) -> anyhow::Result<Self> {
        let shell_type = match shell_info.name.as_str() {
            "zsh" => ShellType::Zsh,
            "bash" => ShellType::Bash,
            "powershell" => ShellType::PowerShell,
            "sh" => ShellType::Sh,
            "cmd" => ShellType::Cmd,
            name => anyhow::bail!("unknown environment shell `{name}`"),
        };

        Ok(Self {
            shell_type,
            shell_path: PathBuf::from(shell_info.path),
        })
    }
}

#[cfg(all(test, unix))]
fn ultimate_fallback_shell() -> Shell {
    codex_shell_command::shell_detect::ultimate_fallback_shell().into()
}

pub fn get_shell_by_model_provided_path(shell_path: &PathBuf) -> Shell {
    codex_shell_command::shell_detect::get_shell_by_model_provided_path(shell_path).into()
}

pub fn get_shell(shell_type: ShellType, path: Option<&PathBuf>) -> Option<Shell> {
    codex_shell_command::shell_detect::get_shell(shell_type, path).map(Into::into)
}

pub fn default_user_shell() -> Shell {
    codex_shell_command::shell_detect::default_user_shell().into()
}

#[cfg(all(test, target_os = "macos"))]
fn default_user_shell_from_path(user_shell_path: Option<PathBuf>) -> Shell {
    codex_shell_command::shell_detect::default_user_shell_from_path(user_shell_path).into()
}

#[cfg(test)]
#[cfg(unix)]
#[path = "shell_tests.rs"]
mod tests;

//! 用户 shell 命令记录模块。
//!
//! 将用户执行的 shell 命令及其输出格式化为 `ResponseItem`，
//! 以便将其作为上下文片段纳入会话历史。

use codex_protocol::exec_output::ExecToolCallOutput;
use codex_protocol::models::ResponseItem;

use crate::context::ContextualUserFragment;
use crate::context::UserShellCommand;
use crate::session::turn_context::TurnContext;
use crate::tools::format_exec_output_str;

/// 根据命令和执行输出构建用户 shell 命令片段。
fn user_shell_command_fragment(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> UserShellCommand {
    let output = format_exec_output_str(
        exec_output,
        turn_context.model_info.truncation_policy.into(),
    );
    UserShellCommand::new(command, exec_output.exit_code, exec_output.duration, output)
}

/// 将用户 shell 命令记录格式化为字符串（仅测试用）。
#[cfg(test)]
pub fn format_user_shell_command_record(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> String {
    user_shell_command_fragment(command, exec_output, turn_context).render()
}

/// 将用户 shell 命令记录转换为 `ResponseItem`，用于纳入会话历史。
pub fn user_shell_command_record_item(
    command: &str,
    exec_output: &ExecToolCallOutput,
    turn_context: &TurnContext,
) -> ResponseItem {
    ContextualUserFragment::into(user_shell_command_fragment(
        command,
        exec_output,
        turn_context,
    ))
}

#[cfg(test)]
#[path = "user_shell_command_tests.rs"]
mod tests;

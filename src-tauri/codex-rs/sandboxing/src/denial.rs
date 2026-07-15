//! 沙箱拒绝行为判定模块。
//!
//! 当外部命令在沙箱内执行失败时，根据退出码与输出关键字推断
//! 失败是否由沙箱策略拒绝导致（而非命令本身逻辑错误）。

use codex_protocol::exec_output::ExecToolCallOutput;

use crate::SandboxType;

/// 判定命令失败是否可能由所选沙箱的拒绝策略导致。
///
/// 判定逻辑：
/// 1. 未启用沙箱（[`SandboxType::None`]）或退出码为 0 时直接返回 false
/// 2. 在 stderr / stdout / aggregated_output 中匹配任一沙箱拒绝关键字时返回 true
/// 3. 命中快速拒绝退出码（2 / 126 / 127，通常为参数错误或命令未找到）时返回 false
/// 4. Unix 下 LinuxSeccomp 沙箱收到 `SIGSYS` 信号（退出码 128 + `SIGSYS`）表示
///    触发 seccomp 过滤规则，返回 true
pub fn is_likely_sandbox_denied(
    sandbox_type: SandboxType,
    exec_output: &ExecToolCallOutput,
) -> bool {
    if sandbox_type == SandboxType::None || exec_output.exit_code == 0 {
        return false;
    }

    // 沙箱拒绝相关的关键字集合，匹配 stderr / stdout / 聚合输出中的任一段。
    const SANDBOX_DENIED_KEYWORDS: [&str; 7] = [
        "operation not permitted",
        "permission denied",
        "read-only file system",
        "seccomp",
        "sandbox",
        "landlock",
        "failed to write file",
    ];

    let has_sandbox_keyword = [
        &exec_output.stderr.text,
        &exec_output.stdout.text,
        &exec_output.aggregated_output.text,
    ]
    .into_iter()
    .any(|section| {
        let lower = section.to_lowercase();
        SANDBOX_DENIED_KEYWORDS
            .iter()
            .any(|needle| lower.contains(needle))
    });

    if has_sandbox_keyword {
        return true;
    }

    // 快速拒绝退出码：2（参数错误）、126（不可执行）、127（未找到命令），
    // 这些通常与沙箱拒绝无关，避免误判。
    const QUICK_REJECT_EXIT_CODES: [i32; 3] = [2, 126, 127];
    if QUICK_REJECT_EXIT_CODES.contains(&exec_output.exit_code) {
        return false;
    }

    #[cfg(unix)]
    {
        // Unix 信号退出码基数为 128，触发 SIGSYS 表示命中 seccomp 过滤规则。
        const EXIT_CODE_SIGNAL_BASE: i32 = 128;
        if sandbox_type == SandboxType::LinuxSeccomp
            && exec_output.exit_code == EXIT_CODE_SIGNAL_BASE + libc::SIGSYS
        {
            return true;
        }
    }

    false
}

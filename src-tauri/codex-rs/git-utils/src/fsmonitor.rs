//! 保留 Git 内置 fsmonitor 的策略模块。
//!
//! Codex 会覆盖 `core.fsmonitor`，使仓库配置无法指定外部 helper 可执行文件。
//! 仅当有效值为布尔 true 且 Git 声明支持内置 daemon 时才保留内置 daemon。
//!
//! 内置 daemon 可以避免扫描所有受跟踪文件与未跟踪目录：
//! https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/git-fsmonitor--daemon.adoc#L49-L57
//! https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/git-update-index.adoc#L545-L550

use std::future::Future;

/// 内部 Git 命令使用的安全 `core.fsmonitor` 覆盖策略。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FsmonitorOverride {
    /// 禁用仓库配置的 fsmonitor helper。
    Disabled,
    /// 保留 Git 内置 fsmonitor daemon。
    BuiltIn,
}

impl FsmonitorOverride {
    /// 返回完整的 Git 配置覆盖参数字符串（用于 `git -c`）。
    pub const fn git_config_arg(self) -> &'static str {
        match self {
            Self::Disabled => "core.fsmonitor=false",
            Self::BuiltIn => "core.fsmonitor=true",
        }
    }
}

/// 执行 [`detect_fsmonitor_override`] 所需 Git 命令的运行器 trait。
///
/// 实现方需保证：仅当 Git 成功退出时返回 stdout；超时、进程启动失败、传输错误、
/// 被信号终止或非零退出状态均应返回 `None`。
pub trait FsmonitorProbeRunner: Send {
    /// 在目标仓库中执行一次有界探测命令，返回 stdout 字节。
    fn run_probe(&mut self, args: &[&str]) -> impl Future<Output = Option<Vec<u8>>> + Send;
}

/// 返回目标仓库的安全 fsmonitor 覆盖策略。
///
/// 此处每次都主动探测，因为 Git 的有效配置是分层的，可能使用 conditional includes，
/// 且在 Codex 运行期间也可能变化：
/// https://git-scm.com/docs/git-config#SCOPES
/// https://git-scm.com/docs/git-config#_conditional_includes
pub async fn detect_fsmonitor_override(
    runner: &mut impl FsmonitorProbeRunner,
) -> FsmonitorOverride {
    // 先查询原始有效值（--null --get），避免被 typed 查询中的类型转换干扰：
    // 若仓库本地配置了一个被覆盖的 helper 路径，typed 查询会先把匹配值转换类型，
    // 可能导致仓库本地 true 转换失败。
    // https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/builtin/config.c#L482-L514
    // https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/builtin/config.c#L611-L614
    let Some(config) = runner
        .run_probe(&["config", "--null", "--get", "core.fsmonitor"])
        .await
    else {
        return FsmonitorOverride::Disabled;
    };
    // 去掉末尾的 NUL 结束符
    let Some(config) = config.strip_suffix(b"\0") else {
        return FsmonitorOverride::Disabled;
    };
    if config.contains(&0) {
        return FsmonitorOverride::Disabled;
    }
    let Ok(config) = str::from_utf8(config) else {
        return FsmonitorOverride::Disabled;
    };

    // Git 直接接受这些大小写不敏感的写法，以及无值的 key 与非零整数。
    // 对于不常见的写法，先按原始有效值过滤再让 Git 归一化，避免被覆盖的
    // helper 路径名使查询失败。
    // https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/parse.c#L158-L181
    // https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/builtin/config.c#L264-L279
    // https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/builtin/config.c#L496-L507
    let configured = if ["true", "yes", "on"]
        .iter()
        .any(|value| config.eq_ignore_ascii_case(value))
    {
        true
    } else if ["false", "no", "off"]
        .iter()
        .any(|value| config.eq_ignore_ascii_case(value))
    {
        false
    } else {
        // 对非常见写法使用 --type=bool 归一化，并按原始值过滤
        let typed_args = [
            "config",
            "--null",
            "--type=bool",
            "--fixed-value",
            "--get",
            "core.fsmonitor",
            config,
        ];
        matches!(
            runner.run_probe(&typed_args).await.as_deref(),
            Some(b"true\0")
        )
    };
    if !configured {
        return FsmonitorOverride::Disabled;
    }

    // Git 2.35.1 及更早版本会把 "true" 当作 hook 路径名；Git 2.26 之前，
    // 成功但为空的 hook 响应可能隐藏受跟踪文件的变更。
    // 因此要求 Git 专门为能力检查添加的 feature 行。
    // https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/config/core.adoc#L90-L99
    // https://github.com/git/git/commit/dd77cf61a1a2fbf52c94d0cd986d555ad2ba8a4b
    let Some(build_options) = runner.run_probe(&["version", "--build-options"]).await else {
        return FsmonitorOverride::Disabled;
    };
    if build_options
        .split(|byte| *byte == b'\n')
        .any(|line| line.trim_ascii() == b"feature: fsmonitor--daemon")
    {
        FsmonitorOverride::BuiltIn
    } else {
        FsmonitorOverride::Disabled
    }
}

#[cfg(test)]
#[path = "fsmonitor_tests.rs"]
mod tests;

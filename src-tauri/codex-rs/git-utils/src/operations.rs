//! Git 命令执行底层操作模块。
//!
//! 提供同步执行 git 命令的辅助函数，封装了进程启动、参数构造、错误处理等通用逻辑。
//! 所有内部 git 命令都会注入 `-c core.hooksPath=<空设备>` 以禁用用户配置的 hooks 目录，
//! 避免仓库本地 hooks 影响 Codex 行为。

use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use crate::GitToolingError;

/// 禁用用户配置 hooks 目录的路径（Windows 用 NUL，其它平台用 /dev/null）
const DISABLED_HOOKS_PATH: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// 确认给定路径位于 git 工作树内。
///
/// 通过 `git rev-parse --is-inside-work-tree` 判断；返回 [`GitToolingError::NotAGitRepository`]
/// 表示不在 git 仓库内。
pub(crate) fn ensure_git_repository(path: &Path) -> Result<(), GitToolingError> {
    match run_git_for_stdout(
        path,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--is-inside-work-tree"),
        ],
        /*env*/ None,
    ) {
        Ok(output) if output.trim() == "true" => Ok(()),
        Ok(_) => Err(GitToolingError::NotAGitRepository {
            path: path.to_path_buf(),
        }),
        Err(GitToolingError::GitCommand { status, .. }) if status.code() == Some(128) => {
            Err(GitToolingError::NotAGitRepository {
                path: path.to_path_buf(),
            })
        }
        Err(err) => Err(err),
    }
}

/// 解析 `HEAD` 的 commit SHA。
///
/// 若仓库尚无提交（unborn HEAD），返回 `Ok(None)`。
pub(crate) fn resolve_head(path: &Path) -> Result<Option<String>, GitToolingError> {
    match run_git_for_stdout(
        path,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("HEAD"),
        ],
        /*env*/ None,
    ) {
        Ok(sha) => Ok(Some(sha)),
        Err(GitToolingError::GitCommand { status, .. }) if status.code() == Some(128) => Ok(None),
        Err(other) => Err(other),
    }
}

/// 通过 `git rev-parse --show-toplevel` 解析仓库根目录。
pub(crate) fn resolve_repository_root(path: &Path) -> Result<PathBuf, GitToolingError> {
    let root = run_git_for_stdout(
        path,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--show-toplevel"),
        ],
        /*env*/ None,
    )?;
    Ok(PathBuf::from(root))
}

/// 执行 git 命令并仅关心退出状态，忽略 stdout。
///
/// 失败时返回 [`GitToolingError::GitCommand`]。
pub(crate) fn run_git_for_status<I, S>(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<(), GitToolingError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git(dir, args, env)?;
    Ok(())
}

/// 执行 git 命令并返回去除首尾空白后的 stdout 字符串。
///
/// 若 stdout 不是合法 UTF-8，返回 [`GitToolingError::GitOutputUtf8`]。
pub(crate) fn run_git_for_stdout<I, S>(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<String, GitToolingError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let run = run_git(dir, args, env)?;
    String::from_utf8(run.output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|source| GitToolingError::GitOutputUtf8 {
            command: run.command,
            source,
        })
}

// 实际执行 git 进程的内部函数：注入禁用 hooks 配置，构造可读命令字符串并捕获输出
fn run_git<I, S>(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<GitRun, GitToolingError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let iterator = args.into_iter();
    let (lower, upper) = iterator.size_hint();
    let mut args_vec = Vec::with_capacity(upper.unwrap_or(lower) + 2);
    // 让内部 Git helper 命令独立于用户配置的 hook 目录
    args_vec.push(OsString::from("-c"));
    args_vec.push(OsString::from(format!(
        "core.hooksPath={DISABLED_HOOKS_PATH}"
    )));
    for arg in iterator {
        args_vec.push(OsString::from(arg.as_ref()));
    }
    let command_string = build_command_string(&args_vec);
    let mut command = Command::new("git");
    command.current_dir(dir);
    if let Some(envs) = env {
        for (key, value) in envs {
            command.env(key, value);
        }
    }
    command.args(&args_vec);
    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(GitToolingError::GitCommand {
            command: command_string,
            status: output.status,
            stderr,
        });
    }
    Ok(GitRun {
        command: command_string,
        output,
    })
}

// 将参数列表拼接为可读的 `git <args>` 字符串，用于错误信息与日志
fn build_command_string(args: &[OsString]) -> String {
    if args.is_empty() {
        return "git".to_string();
    }
    let joined = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    format!("git {joined}")
}

// git 进程执行结果：可读命令字符串 + 原始输出
struct GitRun {
    command: String,
    output: std::process::Output,
}

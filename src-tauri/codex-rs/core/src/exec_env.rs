//! 执行环境(exec_env)模块。
//!
//! 负责为沙箱内执行的子进程构造环境变量集合,确保子进程仅继承到允许的环境变量,
//! 并注入 Codex 所需的元信息(如 `CODEX_THREAD_ID`、`CODEX_PERMISSION_PROFILE`)。
//!
//! # 与其他模块的关系
//! - 依赖 [`codex_protocol::shell_environment`] 完成实际的变量筛选与合并;
//! - [`crate::exec`] 在 spawn 子进程前调用本模块构造 env map。

use codex_protocol::ThreadId;
#[cfg(test)]
use codex_protocol::config_types::EnvironmentVariablePattern;
use codex_protocol::config_types::ShellEnvironmentPolicy;
use codex_protocol::models::ActivePermissionProfile;
use codex_protocol::shell_environment;
use std::collections::HashMap;

pub use codex_protocol::shell_environment::CODEX_THREAD_ID_ENV_VAR;

/// 当前生效 permission profile 的名称环境变量。
///
/// 仅作信息性用途:子进程可以覆盖该值,因此不能据此判定沙箱策略已被强制执行。
pub const CODEX_PERMISSION_PROFILE_ENV_VAR: &str = "CODEX_PERMISSION_PROFILE";

/// 根据指定 policy 构造子进程的环境变量 map。
///
/// 该结果可在调用 `Command::envs()` 之前先执行 `env_clear()` 直接传入,
/// 以确保不会向子进程泄露任何非预期变量。
///
/// # 算法
/// 派生过程遵循 [`ShellEnvironmentPolicy`] 结构级文档中描述的算法。
///
/// # 特殊变量
/// 当提供 `thread_id` 时,即使 policy 设置了 `include_only`,
/// `CODEX_THREAD_ID` 也会被强制注入。
pub fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String> {
    let thread_id = thread_id.map(|thread_id| thread_id.to_string());
    shell_environment::create_env(policy, thread_id.as_deref())
}

/// 向 shell 工具的环境变量集合注入当前选中的 permission profile 名称。
///
/// 在 shell environment policy 应用之后调用,以确保运行时选中的 profile
/// 优先级高于继承或配置的值。
pub(crate) fn inject_permission_profile_env(
    env: &mut HashMap<String, String>,
    active_permission_profile: Option<&ActivePermissionProfile>,
) {
    // Windows 环境变量名大小写不敏感,需要按 case-insensitive 比较移除。
    if cfg!(windows) {
        env.retain(|key, _| !key.eq_ignore_ascii_case(CODEX_PERMISSION_PROFILE_ENV_VAR));
    } else {
        env.remove(CODEX_PERMISSION_PROFILE_ENV_VAR);
    }
    if let Some(active_permission_profile) = active_permission_profile {
        env.insert(
            CODEX_PERMISSION_PROFILE_ENV_VAR.to_string(),
            active_permission_profile.id.clone(),
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
fn create_env_from_vars<I>(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let thread_id = thread_id.map(|thread_id| thread_id.to_string());
    shell_environment::create_env_from_vars(vars, policy, thread_id.as_deref())
}

#[cfg(test)]
fn populate_env<I>(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let thread_id = thread_id.map(|thread_id| thread_id.to_string());
    shell_environment::populate_env(vars, policy, thread_id.as_deref())
}

#[cfg(test)]
#[path = "exec_env_tests.rs"]
mod tests;

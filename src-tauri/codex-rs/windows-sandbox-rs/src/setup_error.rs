use anyhow::Context;
use anyhow::Result;
use codex_utils_string::sanitize_metric_tag_value;
use serde::Deserialize;
use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::path::PathBuf;

/// 这些枚举值表示 elevated sandbox setup 过程中最常见的失败类型。
///
/// 这些 code 会作为 metric tag 使用，便于在 analytics 中按失败原因分类统计。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupErrorCode {
    // Orchestrator（在 CLI 中运行）的失败类型。
    /// 在 orchestrator 中创建 `codex_home/.sandbox` 目录失败。
    OrchestratorSandboxDirCreateFailed,
    /// 无法判断当前进程是否已提权（elevated）。
    OrchestratorElevationCheckFailed,
    /// setup 命令要求进程已经是 elevated process，否则无法执行提权操作。
    OrchestratorElevationRequired,
    /// 在启动 helper 之前序列化 elevation payload 失败。
    OrchestratorPayloadSerializeFailed,
    /// 启动 setup helper 进程失败（spawn 或 ShellExecuteExW 调用失败）。
    OrchestratorHelperLaunchFailed,
    /// 用户在启动 helper 时取消了 UAC 提示。
    OrchestratorHelperLaunchCanceled,
    /// helper 以非零码退出，且没有可用的结构化报告。
    OrchestratorHelperExitNonzero,
    /// helper 以非零码退出，且读取 `setup_error.json` 失败。
    OrchestratorHelperReportReadFailed,
    /// helper 在 setup 完成之前就成功退出了（异常提前退出）。
    OrchestratorHelperIncomplete,
    // Helper（elevated process）的失败类型。
    /// helper 在验证或解码 request payload 时失败。
    HelperRequestArgsFailed,
    /// helper 创建 `codex_home/.sandbox` 目录失败。
    HelperSandboxDirCreateFailed,
    /// helper 打开或写入 setup 日志文件失败。
    HelperLogFailed,
    /// helper 在用户 provisioning 阶段失败（兜底分类）。
    HelperUserProvisionFailed,
    /// helper 创建 sandbox users 本地组失败。
    HelperUsersGroupCreateFailed,
    /// helper 创建或更新 sandbox user 账户失败。
    HelperUserCreateOrUpdateFailed,
    /// helper 使用 DPAPI 保护用户密码失败。
    HelperDpapiProtectFailed,
    /// helper 写入 sandbox users secrets 文件失败。
    HelperUsersFileWriteFailed,
    /// helper 写入或保护 setup marker 文件失败。
    HelperSetupMarkerWriteFailed,
    /// helper 解析 SID 或将其转换为 PSID 失败。
    HelperSidResolveFailed,
    /// helper 加载或转换 capability SIDs 失败。
    HelperCapabilitySidFailed,
    /// helper 为防火墙配置初始化 COM 失败。
    HelperFirewallComInitFailed,
    /// helper 访问防火墙策略或规则集合失败。
    HelperFirewallPolicyAccessFailed,
    /// helper 检测到本地防火墙策略变更无法完全生效。
    HelperFirewallPolicyIneffective,
    /// helper 创建、更新或添加防火墙规则失败。
    HelperFirewallRuleCreateOrAddFailed,
    /// helper 验证已配置的防火墙规则范围失败。
    HelperFirewallRuleVerifyFailed,
    /// helper 启动 read-ACL helper 进程失败。
    HelperReadAclHelperSpawnFailed,
    /// helper 通过 ACLs 锁定 sandbox 目录失败。
    HelperSandboxLockFailed,
    /// helper 因未映射或意外的原因失败。
    HelperUnknownError,
}

impl SetupErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OrchestratorSandboxDirCreateFailed => "orchestrator_sandbox_dir_create_failed",
            Self::OrchestratorElevationCheckFailed => "orchestrator_elevation_check_failed",
            Self::OrchestratorElevationRequired => "orchestrator_elevation_required",
            Self::OrchestratorPayloadSerializeFailed => "orchestrator_payload_serialize_failed",
            Self::OrchestratorHelperLaunchFailed => "orchestrator_helper_launch_failed",
            Self::OrchestratorHelperLaunchCanceled => "orchestrator_helper_launch_canceled",
            Self::OrchestratorHelperExitNonzero => "orchestrator_helper_exit_nonzero",
            Self::OrchestratorHelperReportReadFailed => "orchestrator_helper_report_read_failed",
            Self::OrchestratorHelperIncomplete => "orchestrator_helper_incomplete",
            Self::HelperRequestArgsFailed => "helper_request_args_failed",
            Self::HelperSandboxDirCreateFailed => "helper_sandbox_dir_create_failed",
            Self::HelperLogFailed => "helper_log_failed",
            Self::HelperUserProvisionFailed => "helper_user_provision_failed",
            Self::HelperUsersGroupCreateFailed => "helper_users_group_create_failed",
            Self::HelperUserCreateOrUpdateFailed => "helper_user_create_or_update_failed",
            Self::HelperDpapiProtectFailed => "helper_dpapi_protect_failed",
            Self::HelperUsersFileWriteFailed => "helper_users_file_write_failed",
            Self::HelperSetupMarkerWriteFailed => "helper_setup_marker_write_failed",
            Self::HelperSidResolveFailed => "helper_sid_resolve_failed",
            Self::HelperCapabilitySidFailed => "helper_capability_sid_failed",
            Self::HelperFirewallComInitFailed => "helper_firewall_com_init_failed",
            Self::HelperFirewallPolicyAccessFailed => "helper_firewall_policy_access_failed",
            Self::HelperFirewallPolicyIneffective => "helper_firewall_policy_ineffective",
            Self::HelperFirewallRuleCreateOrAddFailed => {
                "helper_firewall_rule_create_or_add_failed"
            }
            Self::HelperFirewallRuleVerifyFailed => "helper_firewall_rule_verify_failed",
            Self::HelperReadAclHelperSpawnFailed => "helper_read_acl_helper_spawn_failed",
            Self::HelperSandboxLockFailed => "helper_sandbox_lock_failed",
            Self::HelperUnknownError => "helper_unknown_error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupErrorReport {
    pub code: SetupErrorCode,
    pub message: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SetupFailure {
    pub code: SetupErrorCode,
    pub message: String,
}

impl SetupFailure {
    pub fn new(code: SetupErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn from_report(report: SetupErrorReport) -> Self {
        Self::new(report.code, report.message)
    }

    pub fn metric_message(&self) -> String {
        sanitize_setup_metric_tag_value(&self.message)
    }
}

impl std::fmt::Display for SetupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SetupFailure {}

pub fn failure(code: SetupErrorCode, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(SetupFailure::new(code, message))
}

pub fn extract_failure(err: &anyhow::Error) -> Option<&SetupFailure> {
    err.downcast_ref::<SetupFailure>()
}

pub fn setup_error_path(codex_home: &Path) -> PathBuf {
    codex_home.join(".sandbox").join("setup_error.json")
}

pub fn clear_setup_error_report(codex_home: &Path) -> Result<()> {
    let path = setup_error_path(codex_home);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("remove {}", path.display())),
    }
}

pub fn write_setup_error_report(codex_home: &Path, report: &SetupErrorReport) -> Result<()> {
    let sandbox_dir = codex_home.join(".sandbox");
    fs::create_dir_all(&sandbox_dir)
        .with_context(|| format!("create sandbox dir {}", sandbox_dir.display()))?;
    let path = setup_error_path(codex_home);
    let json = serde_json::to_vec_pretty(report)?;
    fs::write(&path, json).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn read_setup_error_report(codex_home: &Path) -> Result<Option<SetupErrorReport>> {
    let path = setup_error_path(codex_home);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("read {}", path.display())),
    };
    let report = serde_json::from_slice::<SetupErrorReport>(&bytes)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(report))
}

/// 对 setup error message 进行清洗，使其适合作为 metric tag 使用。
/// 会移除路径中的用户名等敏感信息，避免将 PII 数据写入 metrics。
pub fn sanitize_setup_metric_tag_value(value: &str) -> String {
    sanitize_metric_tag_value(redact_home_paths(value).as_str())
}

fn redact_home_paths(value: &str) -> String {
    let mut usernames: Vec<String> = Vec::new();
    if let Ok(username) = std::env::var("USERNAME")
        && !username.trim().is_empty()
    {
        usernames.push(username);
    }
    if let Ok(user) = std::env::var("USER")
        && !user.trim().is_empty()
        && !usernames.iter().any(|v| v.eq_ignore_ascii_case(&user))
    {
        usernames.push(user);
    }

    redact_username_segments(value, &usernames)
}

fn redact_username_segments(value: &str, usernames: &[String]) -> String {
    if usernames.is_empty() {
        return value.to_string();
    }

    let mut segments: Vec<String> = Vec::new();
    let mut separators: Vec<char> = Vec::new();
    let mut current = String::new();

    for ch in value.chars() {
        if ch == '\\' || ch == '/' {
            segments.push(std::mem::take(&mut current));
            separators.push(ch);
        } else {
            current.push(ch);
        }
    }
    segments.push(current);

    for segment in &mut segments {
        let matches = if cfg!(windows) {
            usernames
                .iter()
                .any(|name| segment.eq_ignore_ascii_case(name))
        } else {
            usernames.iter().any(|name| segment == name)
        };
        if matches {
            *segment = "<user>".to_string();
        }
    }

    let mut out = String::new();
    for (idx, segment) in segments.iter().enumerate() {
        out.push_str(segment);
        if let Some(sep) = separators.get(idx) {
            out.push(*sep);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact_username_segments;
    use pretty_assertions::assert_eq;

    #[test]
    fn sanitize_tag_value_redacts_username_segments() {
        let usernames = vec!["Alice".to_string(), "Bob".to_string()];
        let msg = "failed to write C:\\Users\\Alice\\file.txt; fallback D:\\Profiles\\Bob\\x";
        let redacted = redact_username_segments(msg, &usernames);
        assert_eq!(
            redacted,
            "failed to write C:\\Users\\<user>\\file.txt; fallback D:\\Profiles\\<user>\\x"
        );
    }

    #[test]
    fn sanitize_tag_value_leaves_unknown_segments() {
        let usernames = vec!["Alice".to_string()];
        let msg = "failed to write E:\\data\\file.txt";
        let redacted = redact_username_segments(msg, &usernames);
        assert_eq!(redacted, msg);
    }

    #[test]
    fn sanitize_tag_value_redacts_multiple_occurrences() {
        let usernames = vec!["Alice".to_string()];
        let msg = "C:\\Users\\Alice\\a and C:\\Users\\Alice\\b";
        let redacted = redact_username_segments(msg, &usernames);
        assert_eq!(redacted, "C:\\Users\\<user>\\a and C:\\Users\\<user>\\b");
    }
}

//! Git 工具库（git-utils）
//!
//! 本 crate 封装了 Codex 内部使用的 Git 操作工具集，提供以下能力：
//! - 通过系统 `git` 二进制应用 unified diff（[`apply::apply_git_patch`]）
//! - 维护仅含一次提交的 git baseline 仓库并计算差异（[`baseline`]）
//! - 解析分支 merge-base（[`branch`]）
//! - 采集仓库元信息：分支、远端、提交日志（[`info`]）
//! - 探测并覆盖 `core.fsmonitor` 配置（[`fsmonitor`]）
//! - 在 Unix/Windows 上创建符号链接（[`platform`]）
//!
//! 所有内部 Git 命令都会禁用用户配置的 hooks 与 fsmonitor helper，
//! 避免仓库本地配置影响 Codex 行为。

mod apply;
mod baseline;
mod branch;
mod errors;
mod fsmonitor;
mod info;
mod operations;
mod platform;

pub use apply::ApplyGitRequest;
pub use apply::ApplyGitResult;
pub use apply::apply_git_patch;
pub use apply::extract_paths_from_patch;
pub use apply::parse_git_apply_output;
pub use apply::stage_paths;
pub use baseline::GitBaselineChange;
pub use baseline::GitBaselineChangeStatus;
pub use baseline::GitBaselineDiff;
pub use baseline::diff_since_latest_init;
pub use baseline::ensure_git_baseline_repository;
pub use baseline::reset_git_repository;
pub use branch::merge_base_with_head;
pub use codex_protocol::protocol::GitSha;
pub use errors::GitToolingError;
pub use fsmonitor::FsmonitorOverride;
pub use fsmonitor::FsmonitorProbeRunner;
pub use fsmonitor::detect_fsmonitor_override;
pub use info::CommitLogEntry;
pub use info::GitDiffToRemote;
pub use info::GitInfo;
pub use info::canonicalize_git_remote_url;
pub use info::collect_git_info;
pub use info::current_branch_name;
pub use info::default_branch_name;
pub use info::get_git_remote_urls;
pub use info::get_git_remote_urls_assume_git_repo;
pub use info::get_git_repo_root;
pub use info::get_git_repo_root_with_fs;
pub use info::get_has_changes;
pub use info::get_head_commit_hash;
pub use info::git_diff_to_remote;
pub use info::local_git_branches;
pub use info::recent_commits;
pub use info::resolve_root_git_project_for_trust;
pub use platform::create_symlink;

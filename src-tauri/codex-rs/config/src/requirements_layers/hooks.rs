//! requirements 层的 hook 合并。
//!
//! hook events 在多层之间是可叠加的（append-only）：每一层新增的事件会
//! 追加到结果列表。但 managed hook directory 字段不同：每个平台只允许
//! 一个目录，因此对当前活跃平台的目录冲突会以"失败关闭"（fail closed）
//! 方式报错；非活跃平台的目录则采用"先到先得"（first-filled）策略，
//! 以便同一份层栈可以同时携带不同操作系统的目录配置。

use crate::HookEventsToml;
use crate::ManagedHooksRequirementsToml;
use crate::RequirementSource;
use crate::Sourced;
use std::collections::BTreeMap;
use std::path::PathBuf;

use super::stack::composition_conflict;
use super::stack::merge_output_source;

/// managed hooks 的目录字段标识。
///
/// 区分当前平台的活跃目录字段与非活跃平台的目录字段，用于在合并时
/// 对活跃字段施加冲突检测、对非活跃字段施加 first-filled 策略。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum HookDirectoryField {
    /// Unix/macOS 平台的 `hooks.managed_dir` 字段。
    #[default]
    ManagedDir,
    /// Windows 平台的 `hooks.windows_managed_dir` 字段。
    WindowsManagedDir,
}

impl HookDirectoryField {
    /// 返回当前平台对应的目录字段。
    pub(super) fn current_platform() -> Self {
        if cfg!(windows) {
            Self::WindowsManagedDir
        } else {
            Self::ManagedDir
        }
    }

    /// 返回该字段在 TOML 中的完整路径表示，用于错误消息。
    fn field_name(self) -> &'static str {
        match self {
            Self::ManagedDir => "hooks.managed_dir",
            Self::WindowsManagedDir => "hooks.windows_managed_dir",
        }
    }

    /// 返回该字段对应的另一平台字段（即"非活跃"字段）。
    fn inactive(self) -> Self {
        match self {
            Self::ManagedDir => Self::WindowsManagedDir,
            Self::WindowsManagedDir => Self::ManagedDir,
        }
    }
}

/// hook 跨层合并的累积状态。
///
/// 跟踪活跃平台目录字段的来源，以便在冲突时给出有意义的错误消息。
/// 非活跃平台目录字段的来源也一并跟踪，以支持 first-filled 语义。
pub(super) struct HookMergeState {
    /// 当前平台的活跃目录字段。
    directory_field: HookDirectoryField,
    /// 每个目录字段首次贡献者的来源记录（用于冲突诊断）。
    dir_sources: BTreeMap<HookDirectoryField, RequirementSource>,
}

impl HookMergeState {
    /// 构造一个针对给定活跃字段的合并状态。
    pub(super) fn new(directory_field: HookDirectoryField) -> Self {
        Self {
            directory_field,
            dir_sources: BTreeMap::new(),
        }
    }

    /// 将 `incoming` 合并到 `target`。
    ///
    /// - `incoming` 为空或 `None` 时直接返回。
    /// - `target` 为 `None` 时直接占用 `incoming`，并记录目录字段的来源。
    /// - `target` 为 `Some(_)` 时：
    ///   - 活跃平台目录字段走 `merge_active_singleton`（冲突 fail closed）。
    ///   - 非活跃平台目录字段走 `fill_singleton`（first-filled）。
    ///   - hook events 通过 `append_hook_events` 追加。
    /// - 任何字段被改动时合成来源标记。
    ///
    /// # Errors
    /// 当活跃平台目录字段与既有值不同时返回 `RequirementsCompositionError::Conflict`。
    pub(super) fn merge(
        &mut self,
        target: &mut Option<Sourced<ManagedHooksRequirementsToml>>,
        incoming: Option<ManagedHooksRequirementsToml>,
        source: &RequirementSource,
    ) -> Result<(), super::stack::RequirementsCompositionError> {
        let Some(mut incoming) = incoming.filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let Some(existing) = target.as_mut() else {
            self.track_singleton_source(
                HookDirectoryField::ManagedDir,
                &incoming.managed_dir,
                source,
            );
            self.track_singleton_source(
                HookDirectoryField::WindowsManagedDir,
                &incoming.windows_managed_dir,
                source,
            );
            *target = Some(Sourced::new(incoming, source.clone()));
            return Ok(());
        };

        let active_field = self.directory_field;
        let inactive_field = active_field.inactive();
        let incoming_active_dir = take_hook_dir(&mut incoming, active_field);
        let incoming_inactive_dir = take_hook_dir(&mut incoming, inactive_field);
        let mut changed = false;
        changed |= self.merge_active_singleton(
            active_field,
            hook_dir_mut(&mut existing.value, active_field),
            incoming_active_dir,
            source,
        )?;
        changed |= self.fill_singleton(
            inactive_field,
            hook_dir_mut(&mut existing.value, inactive_field),
            incoming_inactive_dir,
            source,
        );
        changed |= append_hook_events(&mut existing.value.hooks, incoming.hooks);
        if changed {
            merge_output_source(&mut existing.source, source);
        }
        Ok(())
    }

    /// 记录某个目录字段首次贡献者的来源，仅在该字段尚无来源记录时写入。
    fn track_singleton_source(
        &mut self,
        field: HookDirectoryField,
        value: &Option<PathBuf>,
        source: &RequirementSource,
    ) {
        if value.is_some() {
            self.dir_sources
                .entry(field)
                .or_insert_with(|| source.clone());
        }
    }

    /// 合并活跃平台目录字段：对冲突 fail closed。
    ///
    /// - `incoming` 为 `None` 时无改动。
    /// - `existing` 与 `incoming` 值不同时返回 `Conflict` 错误，错误消息中
    ///   优先使用 `dir_sources` 记录的来源，便于定位首次贡献者。
    /// - `existing` 与 `incoming` 值相同时无改动。
    /// - `existing` 为 `None` 时占用 `incoming` 并记录来源。
    ///
    /// # Errors
    /// 当 `existing` 与 `incoming` 值不同时返回 `RequirementsCompositionError::Conflict`。
    fn merge_active_singleton(
        &mut self,
        field: HookDirectoryField,
        existing: &mut Option<PathBuf>,
        incoming: Option<PathBuf>,
        incoming_source: &RequirementSource,
    ) -> Result<bool, super::stack::RequirementsCompositionError> {
        let Some(incoming) = incoming else {
            return Ok(false);
        };

        match existing {
            Some(existing_value) if existing_value != &incoming => {
                let existing_source = self
                    .dir_sources
                    .get(&field)
                    .cloned()
                    .unwrap_or_else(|| incoming_source.clone());
                Err(composition_conflict(
                    field.field_name().to_string(),
                    existing_source,
                    incoming_source.clone(),
                    format!(
                        "`{}` conflicts with `{}`",
                        existing_value.display(),
                        incoming.display()
                    ),
                ))
            }
            Some(_) => Ok(false),
            None => {
                *existing = Some(incoming);
                self.dir_sources
                    .entry(field)
                    .or_insert_with(|| incoming_source.clone());
                Ok(true)
            }
        }
    }

    /// 合并非活跃平台目录字段：first-filled 语义，不报错。
    ///
    /// 仅当 `existing` 为 `None` 且 `incoming` 为 `Some(_)` 时占用并记录来源，
    /// 否则无改动。返回是否发生了变化。
    fn fill_singleton(
        &mut self,
        field: HookDirectoryField,
        existing: &mut Option<PathBuf>,
        incoming: Option<PathBuf>,
        incoming_source: &RequirementSource,
    ) -> bool {
        if existing.is_none()
            && let Some(incoming) = incoming
        {
            *existing = Some(incoming);
            self.dir_sources
                .entry(field)
                .or_insert_with(|| incoming_source.clone());
            true
        } else {
            false
        }
    }
}

/// 从 `hooks` 中按字段取出对应平台目录的 `PathBuf`（take 语义）。
fn take_hook_dir(
    hooks: &mut ManagedHooksRequirementsToml,
    field: HookDirectoryField,
) -> Option<PathBuf> {
    match field {
        HookDirectoryField::ManagedDir => hooks.managed_dir.take(),
        HookDirectoryField::WindowsManagedDir => hooks.windows_managed_dir.take(),
    }
}

/// 获取 `hooks` 中对应平台目录字段的可变引用（borrow 语义）。
fn hook_dir_mut(
    hooks: &mut ManagedHooksRequirementsToml,
    field: HookDirectoryField,
) -> &mut Option<PathBuf> {
    match field {
        HookDirectoryField::ManagedDir => &mut hooks.managed_dir,
        HookDirectoryField::WindowsManagedDir => &mut hooks.windows_managed_dir,
    }
}

/// 把 `incoming` 的所有 hook events 追加到 `existing` 上。
///
/// 返回是否发生了变化。显式 destructure 而不用 `..`，以便新增 hook 事件
/// 字段时编译器强制开发者决定是否需要纳入跨层追加语义。
fn append_hook_events(existing: &mut HookEventsToml, incoming: HookEventsToml) -> bool {
    // 显式 destructure 而不用 `..`，以便新增 hook 事件字段时强制开发者
    // 决定是否在 requirements 层合并时也追加该字段。
    let HookEventsToml {
        pre_tool_use,
        permission_request,
        post_tool_use,
        pre_compact,
        post_compact,
        session_start,
        user_prompt_submit,
        subagent_start,
        subagent_stop,
        stop,
    } = incoming;

    let mut changed = false;
    changed |= append_vec(&mut existing.pre_tool_use, pre_tool_use);
    changed |= append_vec(&mut existing.permission_request, permission_request);
    changed |= append_vec(&mut existing.post_tool_use, post_tool_use);
    changed |= append_vec(&mut existing.pre_compact, pre_compact);
    changed |= append_vec(&mut existing.post_compact, post_compact);
    changed |= append_vec(&mut existing.session_start, session_start);
    changed |= append_vec(&mut existing.user_prompt_submit, user_prompt_submit);
    changed |= append_vec(&mut existing.subagent_start, subagent_start);
    changed |= append_vec(&mut existing.subagent_stop, subagent_stop);
    changed |= append_vec(&mut existing.stop, stop);
    changed
}

/// 把 `incoming` 追加到 `existing` 末尾，返回是否发生了变化。
///
/// 空的 `incoming` 不视为变化。
fn append_vec<T>(existing: &mut Vec<T>, mut incoming: Vec<T>) -> bool {
    let changed = !incoming.is_empty();
    existing.append(&mut incoming);
    changed
}

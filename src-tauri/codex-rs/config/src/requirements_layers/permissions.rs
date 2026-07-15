//! requirements 层中 `permissions.filesystem.deny_read` 的可叠加合并。
//!
//! `permissions.filesystem.deny_read` 在 requirements 层之间被刻意设计为
//! 可叠加的（additive）：每一层新增的拒绝读取模式都会并入最终结果，
//! 形成跨层的并集。其它 `[permissions]` 子表仍走常规 TOML 合并路径，
//! 以便权限 profile 表能沿用 config 风格的覆盖优先级。

use crate::FilesystemDenyReadPattern;
use crate::RequirementSource;
use crate::Sourced;
use crate::config_requirements::FilesystemRequirementsToml;
use crate::config_requirements::PermissionsRequirementsToml;

use super::stack::merge_output_source;

/// `deny_read` 跨层合并的累积状态。
///
/// 维护跨层收集到的去重 `FilesystemDenyReadPattern` 列表以及合成后的
/// `RequirementSource`，用于在 `apply_to` 阶段写回到最终输出。
#[derive(Default)]
pub(super) struct DenyReadMergeState {
    /// 已收集的去重拒绝读取模式列表。
    deny_read: Vec<FilesystemDenyReadPattern>,
    /// 已收集模式来源的合成 `RequirementSource`，`None` 表示尚未收到任何模式。
    source: Option<RequirementSource>,
}

impl DenyReadMergeState {
    /// 从 `incoming` 的 `permissions.filesystem.deny_read` 字段提取模式并入。
    ///
    /// 当 `incoming` 不含 `deny_read` 或为空时直接返回。新增模式会去重后追加，
    /// 并通过 `merge_source` 合成来源标记。
    pub(super) fn merge(
        &mut self,
        incoming: Option<PermissionsRequirementsToml>,
        source: &RequirementSource,
    ) {
        let Some(incoming_deny_read) = incoming
            .and_then(|permissions| permissions.filesystem)
            .and_then(|filesystem| filesystem.deny_read)
            .filter(|deny_read| !deny_read.is_empty())
        else {
            return;
        };

        for pattern in incoming_deny_read {
            if !self.deny_read.contains(&pattern) {
                self.deny_read.push(pattern);
                self.merge_source(source);
            }
        }
    }

    /// 将累积的 `deny_read` 模式写回到最终输出的 `permissions.filesystem.deny_read`。
    ///
    /// - 累积列表为空时直接返回。
    /// - `target` 为 `None` 时构造一个新的 `Sourced<PermissionsRequirementsToml>`，
    ///   仅填充 `filesystem.deny_read` 字段。
    /// - `target` 为 `Some(_)` 时把模式去重后追加到既有列表，并在来源不同时
    ///   合成 `RequirementSource::composite`。
    pub(super) fn apply_to(self, target: &mut Option<Sourced<PermissionsRequirementsToml>>) {
        if self.deny_read.is_empty() {
            return;
        }

        let source = self.source.unwrap_or(RequirementSource::Unknown);
        let Some(existing) = target.as_mut() else {
            *target = Some(Sourced::new(
                PermissionsRequirementsToml {
                    filesystem: Some(FilesystemRequirementsToml {
                        deny_read: Some(self.deny_read),
                    }),
                    profiles: Default::default(),
                },
                source,
            ));
            return;
        };

        let filesystem = existing
            .value
            .filesystem
            .get_or_insert_with(Default::default);
        let deny_read = filesystem.deny_read.get_or_insert_with(Vec::new);
        for pattern in self.deny_read {
            if !deny_read.contains(&pattern) {
                deny_read.push(pattern);
            }
        }
        if existing.source != source {
            existing.source = RequirementSource::composite([existing.source.clone(), source]);
        }
    }

    /// 合成 `source` 到当前累积的来源标记。
    ///
    /// `self.source` 为 `None` 时直接占用 `source`；为 `Some(_)` 且与 `source`
    /// 不同时调用 `merge_output_source` 进行 composite 合成。
    fn merge_source(&mut self, source: &RequirementSource) {
        let Some(existing) = self.source.as_mut() else {
            self.source = Some(source.clone());
            return;
        };
        merge_output_source(existing, source);
    }
}

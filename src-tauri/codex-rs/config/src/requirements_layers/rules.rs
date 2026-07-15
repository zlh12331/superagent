//! 跨 requirements 层的规则合并。
//!
//! requirements rules 在多层之间是可叠加的（additive）。高优先级层的规则
//! 会先追加到结果中，从而在最终规则顺序里保持优先级可见——这与
//! `prefix_rules` 在执行策略评估时按定义顺序匹配的语义一致。

use crate::RequirementSource;
use crate::RequirementsExecPolicyToml;
use crate::Sourced;

use super::stack::merge_output_source;

/// 将 `incoming` 规则合并到 `target`。
///
/// - `target` 为 `None` 时直接占用为新的 `Sourced` 值。
/// - `target` 为 `Some(_)` 时将 `incoming.prefix_rules` 追加到既有值末尾，
///   并通过 `merge_output_source` 把 `source` 合并到来源标记里，保证
///   `Sourced` 的来源信息能反映所有贡献过该字段的层。
///
/// `incoming` 为 `None` 时本函数不做任何改动。
pub(super) fn merge(
    target: &mut Option<Sourced<RequirementsExecPolicyToml>>,
    incoming: Option<RequirementsExecPolicyToml>,
    source: &RequirementSource,
) {
    let Some(incoming) = incoming else {
        return;
    };
    let Some(existing) = target.as_mut() else {
        *target = Some(Sourced::new(incoming, source.clone()));
        return;
    };

    let RequirementsExecPolicyToml { prefix_rules } = incoming;
    existing.value.prefix_rules.extend(prefix_rules);
    merge_output_source(&mut existing.source, source);
}

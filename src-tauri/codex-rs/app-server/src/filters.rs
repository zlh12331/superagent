use codex_app_server_protocol::ThreadSourceKind;
use codex_core::INTERACTIVE_SESSION_SOURCES;
use codex_protocol::protocol::SessionSource as CoreSessionSource;
use codex_protocol::protocol::SubAgentSource as CoreSubAgentSource;

/// 根据客户端提供的 `ThreadSourceKind` 过滤列表，计算用于 DB 查询的 session source
/// 允许列表与可选的后置过滤列表。
///
/// 返回值 `(allowed_sources, post_filter)`：
/// - 当 `source_kinds` 为 `None` 或空时，返回默认的交互式 session sources
///   （`INTERACTIVE_SESSION_SOURCES`）且不做后置过滤（`None`）。
/// - 当 `source_kinds` 仅包含可枚举的交互式类型（`Cli` / `VsCode`）时，将其映射为
///   `CoreSessionSource` 列表，同时保留原始 `source_kinds` 用于后置过滤。
/// - 当 `source_kinds` 包含需要后置过滤的类型（`Exec` / `AppServer` / `SubAgent*` /
///   `Unknown`）时，`allowed_sources` 返回空 Vec（DB 查询不过滤），后置过滤列表
///   保留原始 `source_kinds`，由 [`source_kind_matches`] 在内存中精确匹配。
///
/// # 参数
///
/// - `source_kinds`: 客户端请求的来源种类过滤列表（可能为 `None`）
///
/// # 返回值
///
/// `(allowed_sources, post_filter)`：
/// - `allowed_sources`: 传给 DB 查询的 `CoreSessionSource` 允许列表
/// - `post_filter`: 可选的 `ThreadSourceKind` 后置过滤列表，`None` 表示无需后置过滤
pub(crate) fn compute_source_filters(
    source_kinds: Option<Vec<ThreadSourceKind>>,
) -> (Vec<CoreSessionSource>, Option<Vec<ThreadSourceKind>>) {
    let Some(source_kinds) = source_kinds else {
        return (INTERACTIVE_SESSION_SOURCES.to_vec(), None);
    };

    if source_kinds.is_empty() {
        return (INTERACTIVE_SESSION_SOURCES.to_vec(), None);
    }

    // 若包含任何需要后置过滤的类型（非 Cli/VsCode），则 DB 查询阶段不过滤，
    // 全部交给后置过滤阶段处理。
    let requires_post_filter = source_kinds.iter().any(|kind| {
        matches!(
            kind,
            ThreadSourceKind::Exec
                | ThreadSourceKind::AppServer
                | ThreadSourceKind::SubAgent
                | ThreadSourceKind::SubAgentReview
                | ThreadSourceKind::SubAgentCompact
                | ThreadSourceKind::SubAgentThreadSpawn
                | ThreadSourceKind::SubAgentOther
                | ThreadSourceKind::Unknown
        )
    });

    if requires_post_filter {
        (Vec::new(), Some(source_kinds))
    } else {
        // 仅包含交互式类型，直接映射为 CoreSessionSource。
        let interactive_sources = source_kinds
            .iter()
            .filter_map(|kind| match kind {
                ThreadSourceKind::Cli => Some(CoreSessionSource::Cli),
                ThreadSourceKind::VsCode => Some(CoreSessionSource::VSCode),
                ThreadSourceKind::Exec
                | ThreadSourceKind::AppServer
                | ThreadSourceKind::SubAgent
                | ThreadSourceKind::SubAgentReview
                | ThreadSourceKind::SubAgentCompact
                | ThreadSourceKind::SubAgentThreadSpawn
                | ThreadSourceKind::SubAgentOther
                | ThreadSourceKind::Unknown => None,
            })
            .collect::<Vec<_>>();
        (interactive_sources, Some(source_kinds))
    }
}

/// 判断给定的 `CoreSessionSource` 是否匹配 `ThreadSourceKind` 过滤列表中的任一项。
///
/// 该函数用于 [`compute_source_filters`] 返回的后置过滤阶段，精确区分 SubAgent 的
/// 子类型（`Review` / `Compact` / `ThreadSpawn` / `Other`），因为 DB 查询无法表达
/// 这些细粒度匹配。
///
/// # 参数
///
/// - `source`: 待匹配的 session source
/// - `filter`: `ThreadSourceKind` 过滤列表，命中任一项即返回 `true`
///
/// # 返回值
///
/// 命中任一过滤项返回 `true`，否则返回 `false`。
pub(crate) fn source_kind_matches(source: &CoreSessionSource, filter: &[ThreadSourceKind]) -> bool {
    filter.iter().any(|kind| match kind {
        ThreadSourceKind::Cli => matches!(source, CoreSessionSource::Cli),
        ThreadSourceKind::VsCode => matches!(source, CoreSessionSource::VSCode),
        ThreadSourceKind::Exec => matches!(source, CoreSessionSource::Exec),
        ThreadSourceKind::AppServer => matches!(source, CoreSessionSource::Mcp),
        ThreadSourceKind::SubAgent => matches!(source, CoreSessionSource::SubAgent(_)),
        ThreadSourceKind::SubAgentReview => {
            matches!(
                source,
                CoreSessionSource::SubAgent(CoreSubAgentSource::Review)
            )
        }
        ThreadSourceKind::SubAgentCompact => {
            matches!(
                source,
                CoreSessionSource::SubAgent(CoreSubAgentSource::Compact)
            )
        }
        ThreadSourceKind::SubAgentThreadSpawn => matches!(
            source,
            CoreSessionSource::SubAgent(CoreSubAgentSource::ThreadSpawn { .. })
        ),
        ThreadSourceKind::SubAgentOther => matches!(
            source,
            CoreSessionSource::SubAgent(CoreSubAgentSource::Other(_))
        ),
        ThreadSourceKind::Unknown => matches!(source, CoreSessionSource::Unknown),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::ThreadId;
    use pretty_assertions::assert_eq;
    use uuid::Uuid;

    #[test]
    fn compute_source_filters_defaults_to_interactive_sources() {
        let (allowed_sources, filter) = compute_source_filters(/*source_kinds*/ None);

        assert_eq!(allowed_sources, INTERACTIVE_SESSION_SOURCES.to_vec());
        assert_eq!(filter, None);
    }

    #[test]
    fn compute_source_filters_empty_means_interactive_sources() {
        let (allowed_sources, filter) = compute_source_filters(Some(Vec::new()));

        assert_eq!(allowed_sources, INTERACTIVE_SESSION_SOURCES.to_vec());
        assert_eq!(filter, None);
    }

    #[test]
    fn compute_source_filters_interactive_only_skips_post_filtering() {
        let source_kinds = vec![ThreadSourceKind::Cli, ThreadSourceKind::VsCode];
        let (allowed_sources, filter) = compute_source_filters(Some(source_kinds.clone()));

        assert_eq!(
            allowed_sources,
            vec![CoreSessionSource::Cli, CoreSessionSource::VSCode]
        );
        assert_eq!(filter, Some(source_kinds));
    }

    #[test]
    fn compute_source_filters_subagent_variant_requires_post_filtering() {
        let source_kinds = vec![ThreadSourceKind::SubAgentReview];
        let (allowed_sources, filter) = compute_source_filters(Some(source_kinds.clone()));

        assert_eq!(allowed_sources, Vec::new());
        assert_eq!(filter, Some(source_kinds));
    }

    #[test]
    fn source_kind_matches_distinguishes_subagent_variants() {
        let parent_thread_id =
            ThreadId::from_string(&Uuid::new_v4().to_string()).expect("valid thread id");
        let review = CoreSessionSource::SubAgent(CoreSubAgentSource::Review);
        let spawn = CoreSessionSource::SubAgent(CoreSubAgentSource::ThreadSpawn {
            parent_thread_id,
            depth: 1,
            agent_path: None,
            agent_nickname: None,
            agent_role: None,
        });

        assert!(source_kind_matches(
            &review,
            &[ThreadSourceKind::SubAgentReview]
        ));
        assert!(!source_kind_matches(
            &review,
            &[ThreadSourceKind::SubAgentThreadSpawn]
        ));
        assert!(source_kind_matches(
            &spawn,
            &[ThreadSourceKind::SubAgentThreadSpawn]
        ));
        assert!(!source_kind_matches(
            &spawn,
            &[ThreadSourceKind::SubAgentReview]
        ));
    }
}

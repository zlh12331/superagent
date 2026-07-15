use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;

use codex_config::McpServerConfig;

/// 随 MCP registration 保留的 Plugin identity，用于 tool attribution。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpPluginAttribution {
    plugin_id: String,
    display_name: String,
}

impl McpPluginAttribution {
    pub fn new(plugin_id: String, display_name: String) -> Self {
        Self {
            plugin_id,
            display_name,
        }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

/// 声明 MCP server registration 的 component。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpServerSource {
    /// 通过 process-wide legacy plugin manager 发现的 plugin。
    Plugin(McpPluginAttribution),
    /// 通过 capability root 为此 thread 显式选择的 plugin。
    SelectedPlugin(McpPluginAttribution),
    Config,
    Compatibility {
        id: String,
    },
    Extension {
        id: String,
    },
}

impl McpServerSource {
    fn disabled_registration_is_name_veto(&self) -> bool {
        // selected package 的策略仅适用于其自身的 registration，
        // 不适用于碰巧使用相同逻辑 server name 的更高层级 runtime source。
        !matches!(self, Self::SelectedPlugin(_))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum RegistrationPrecedence {
    Plugin(Reverse<usize>),
    SelectedPlugin(Reverse<usize>),
    Config,
    Compatibility,
    Extension(usize),
}

impl RegistrationPrecedence {
    fn tier(self) -> u8 {
        match self {
            Self::Plugin(_) => 0,
            Self::SelectedPlugin(_) => 1,
            Self::Config => 2,
            Self::Compatibility => 3,
            Self::Extension(_) => 4,
        }
    }
}

/// source resolution 之前的一个命名 MCP server declaration。
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerRegistration {
    name: String,
    source: McpServerSource,
    config: McpServerConfig,
    precedence: RegistrationPrecedence,
}

impl McpServerRegistration {
    pub fn from_config(name: String, config: McpServerConfig) -> Self {
        Self::new(
            name,
            McpServerSource::Config,
            config,
            RegistrationPrecedence::Config,
        )
    }

    pub fn from_plugin(
        name: String,
        attribution: McpPluginAttribution,
        plugin_order: usize,
        config: McpServerConfig,
    ) -> Self {
        Self::new(
            name,
            McpServerSource::Plugin(attribution),
            config,
            RegistrationPrecedence::Plugin(Reverse(plugin_order)),
        )
    }

    /// 注册一个 thread-selected plugin，优先级高于 discovered plugins，低于 config。
    pub fn from_selected_plugin(
        name: String,
        attribution: McpPluginAttribution,
        selection_order: usize,
        config: McpServerConfig,
    ) -> Self {
        Self::new(
            name,
            McpServerSource::SelectedPlugin(attribution),
            config,
            RegistrationPrecedence::SelectedPlugin(Reverse(selection_order)),
        )
    }

    pub fn from_compatibility(
        name: String,
        id: impl Into<String>,
        config: McpServerConfig,
    ) -> Self {
        Self::new(
            name,
            McpServerSource::Compatibility { id: id.into() },
            config,
            RegistrationPrecedence::Compatibility,
        )
    }

    pub fn from_extension(
        name: String,
        id: impl Into<String>,
        contribution_order: usize,
        config: McpServerConfig,
    ) -> Self {
        Self::new(
            name,
            McpServerSource::Extension { id: id.into() },
            config,
            RegistrationPrecedence::Extension(contribution_order),
        )
    }

    fn new(
        name: String,
        source: McpServerSource,
        config: McpServerConfig,
        precedence: RegistrationPrecedence,
    ) -> Self {
        Self {
            name,
            source,
            config,
            precedence,
        }
    }
}

/// MCP server conflict 的一方，包括它是注册还是移除该 server。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum McpServerConflictAction {
    Register(McpServerSource),
    Remove(McpServerSource),
}

/// 同一层级的 name collision，以及在应用所有 precedence 之后的最终结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerConflict {
    pub name: String,
    pub outcome: McpServerConflictAction,
    pub contenders: Vec<McpServerConflictAction>,
}

#[derive(Clone, Debug)]
enum CatalogAction {
    Register(Box<McpServerRegistration>),
    Remove {
        name: String,
        source: McpServerSource,
        precedence: RegistrationPrecedence,
    },
}

impl CatalogAction {
    fn name(&self) -> &str {
        match self {
            Self::Register(registration) => &registration.name,
            Self::Remove { name, .. } => name,
        }
    }

    fn precedence(&self) -> RegistrationPrecedence {
        match self {
            Self::Register(registration) => registration.precedence,
            Self::Remove { precedence, .. } => *precedence,
        }
    }

    fn conflict_action(&self) -> McpServerConflictAction {
        match self {
            Self::Register(registration) => {
                McpServerConflictAction::Register(registration.source.clone())
            }
            Self::Remove { source, .. } => McpServerConflictAction::Remove(source.clone()),
        }
    }
}

/// 用于生成不可变 resolved catalog 的 Mutable inputs。
#[derive(Clone, Debug, Default)]
pub struct McpCatalogBuilder {
    actions: Vec<CatalogAction>,
    disabled_server_names: BTreeSet<String>,
}

impl McpCatalogBuilder {
    pub fn register(&mut self, registration: McpServerRegistration) {
        self.actions
            .push(CatalogAction::Register(Box::new(registration)));
    }

    /// 在 source resolution 之后应用 legacy 的 name-scoped disabled veto。
    pub fn disable(&mut self, name: String) {
        self.disabled_server_names.insert(name);
    }

    pub fn remove_compatibility(&mut self, name: String, id: impl Into<String>) {
        self.actions.push(CatalogAction::Remove {
            name,
            source: McpServerSource::Compatibility { id: id.into() },
            precedence: RegistrationPrecedence::Compatibility,
        });
    }

    pub fn remove_extension(
        &mut self,
        name: String,
        id: impl Into<String>,
        contribution_order: usize,
    ) {
        self.actions.push(CatalogAction::Remove {
            name,
            source: McpServerSource::Extension { id: id.into() },
            precedence: RegistrationPrecedence::Extension(contribution_order),
        });
    }

    pub fn build(mut self) -> ResolvedMcpCatalog {
        // 稳定排序使得当 precedence 相等时，action 顺序成为 tie-breaker。
        self.actions.sort_by_key(CatalogAction::precedence);

        let mut winners = BTreeMap::<String, CatalogAction>::new();
        let mut actions_by_name_and_tier = BTreeMap::<(String, u8), Vec<&CatalogAction>>::new();
        for action in &self.actions {
            winners.insert(action.name().to_string(), action.clone());
            actions_by_name_and_tier
                .entry((action.name().to_string(), action.precedence().tier()))
                .or_default()
                .push(action);
        }

        let mut conflicts = Vec::new();
        for ((name, _), actions) in actions_by_name_and_tier {
            if actions.len() < 2 {
                continue;
            }
            let Some(outcome) = winners.get(&name).map(CatalogAction::conflict_action) else {
                continue;
            };
            conflicts.push(McpServerConflict {
                name,
                outcome,
                contenders: actions
                    .into_iter()
                    .map(CatalogAction::conflict_action)
                    .collect(),
            });
        }

        let mut disabled_server_names = self.disabled_server_names;
        let servers = winners
            .into_iter()
            .filter_map(|(name, action)| match action {
                CatalogAction::Register(registration) => {
                    let mut registration = *registration;
                    let persist_disabled_name =
                        registration.source.disabled_registration_is_name_veto();
                    if !registration.config.enabled || disabled_server_names.contains(&name) {
                        registration.config.enabled = false;
                        if persist_disabled_name {
                            // 在后续的 runtime overlays 中保留 legacy 的 disabled winners。
                            disabled_server_names.insert(name.clone());
                        }
                    }
                    Some((
                        name,
                        ResolvedMcpServer {
                            source: registration.source,
                            config: registration.config,
                        },
                    ))
                }
                CatalogAction::Remove { .. } => None,
            })
            .collect();

        ResolvedMcpCatalog {
            actions: self.actions,
            disabled_server_names,
            servers,
            conflicts,
        }
    }
}

/// 单个胜出的 MCP registration。
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMcpServer {
    source: McpServerSource,
    config: McpServerConfig,
}

impl ResolvedMcpServer {
    pub fn source(&self) -> &McpServerSource {
        &self.source
    }

    pub fn config(&self) -> &McpServerConfig {
        &self.config
    }
}

/// MCP registration resolution 的不可变结果。
#[derive(Clone, Debug, Default)]
pub struct ResolvedMcpCatalog {
    actions: Vec<CatalogAction>,
    disabled_server_names: BTreeSet<String>,
    servers: BTreeMap<String, ResolvedMcpServer>,
    conflicts: Vec<McpServerConflict>,
}

impl ResolvedMcpCatalog {
    pub fn builder() -> McpCatalogBuilder {
        McpCatalogBuilder::default()
    }

    pub fn to_builder(&self) -> McpCatalogBuilder {
        McpCatalogBuilder {
            actions: self.actions.clone(),
            disabled_server_names: self.disabled_server_names.clone(),
        }
    }

    pub fn server(&self, name: &str) -> Option<&ResolvedMcpServer> {
        self.servers.get(name)
    }

    pub fn configured_servers(&self) -> HashMap<String, McpServerConfig> {
        self.servers
            .iter()
            .map(|(name, server)| (name.clone(), server.config.clone()))
            .collect()
    }

    /// 返回两个 catalog 是否解析出相同的 winning servers 和 sources。
    pub fn has_same_servers(&self, other: &Self) -> bool {
        self.servers == other.servers
    }

    /// 替换 resolved server set，同时保留已知的 server sources。
    ///
    /// 不在现有 catalog 中的 Names 将被视为 config-owned。
    pub fn with_materialized_servers(&self, servers: HashMap<String, McpServerConfig>) -> Self {
        let mut builder = Self::builder();
        for (name, config) in servers {
            let source = self
                .server(&name)
                .map(|server| server.source.clone())
                .unwrap_or(McpServerSource::Config);
            let precedence = match &source {
                McpServerSource::Plugin(_) => RegistrationPrecedence::Plugin(Reverse(0)),
                McpServerSource::SelectedPlugin(_) => {
                    RegistrationPrecedence::SelectedPlugin(Reverse(0))
                }
                McpServerSource::Config => RegistrationPrecedence::Config,
                McpServerSource::Compatibility { .. } => RegistrationPrecedence::Compatibility,
                McpServerSource::Extension { .. } => RegistrationPrecedence::Extension(0),
            };
            builder.register(McpServerRegistration::new(name, source, config, precedence));
        }
        builder.build()
    }

    /// 返回每个胜出的 plugin-owned server 的 package attribution。
    pub fn plugin_attributions_by_server_name(&self) -> HashMap<String, McpPluginAttribution> {
        self.servers
            .iter()
            .filter_map(|(name, server)| match server.source() {
                McpServerSource::Plugin(attribution)
                | McpServerSource::SelectedPlugin(attribution) => {
                    Some((name.clone(), attribution.clone()))
                }
                McpServerSource::Config
                | McpServerSource::Compatibility { .. }
                | McpServerSource::Extension { .. } => None,
            })
            .collect()
    }

    /// 返回由 thread-selected plugins 提供的 winning servers 的名称。
    pub(crate) fn selected_plugin_server_names(&self) -> impl Iterator<Item = &str> {
        self.servers.iter().filter_map(|(name, server)| {
            matches!(server.source(), McpServerSource::SelectedPlugin(_)).then_some(name.as_str())
        })
    }

    pub fn conflicts(&self) -> &[McpServerConflict] {
        &self.conflicts
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

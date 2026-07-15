//! Skills 目录与资源类型定义模块。
//!
//! 该模块定义了 skills 扩展中所有核心数据类型，包括：
//! - 来源分类（`SkillSourceKind`）与权威标识（`SkillAuthority`）
//! - 包标识（`SkillPackageId`）与资源标识（`SkillResourceId`）
//! - 目录条目（`SkillCatalogEntry`）与合并目录（`SkillCatalog`）
//! - 读取结果（`SkillReadResult`）与搜索结果（`SkillSearchResult`）
//! - Provider 错误类型（`SkillProviderError`）
//!
//! 这些类型构成了 skills 扩展的数据契约，所有 provider 实现均围绕这些类型展开。

use codex_core_skills::model::SkillDependencies;
use codex_utils_path_uri::PathUri;

/// Skill 来源分类，标识 skill 包的归属权威。
///
/// 该枚举用于路由 list/read 请求到正确的 provider，并保证 authority 边界不被跨越。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SkillSourceKind {
    /// Codex 宿主 skills，包括内置、用户、仓库、插件安装以及下载/物化的远程 skills。
    Host,
    /// 由执行环境拥有的 skills。
    Executor,
    /// 由 orchestrator 而非执行环境拥有的 skills。
    Orchestrator,
    /// 扩展私有来源类型，用于未来不符合现有传输类别的 provider。
    Custom(String),
}

impl SkillSourceKind {
    /// 创建一个自定义来源类型。
    ///
    /// # 参数
    /// - `kind`：自定义来源类型标识字符串
    pub fn custom(kind: impl Into<String>) -> Self {
        Self::Custom(kind.into())
    }

    /// 返回来源类型的字符串表示，用于序列化和日志输出。
    fn as_str(&self) -> &str {
        match self {
            Self::Host => "host",
            Self::Executor => "executor",
            Self::Orchestrator => "orchestrator",
            Self::Custom(kind) => kind,
        }
    }
}

impl std::fmt::Display for SkillSourceKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_str().fmt(formatter)
    }
}

/// Authority 身份标识，用于 list/read 路由。
///
/// 由来源类型（`SkillSourceKind`）和具体 id 组合而成，确保每个 skill 包都有
/// 唯一可定位的权威标识。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SkillAuthority {
    /// 来源类型
    pub kind: SkillSourceKind,
    /// 在该来源类型下的唯一 id
    pub id: String,
}

impl SkillAuthority {
    /// 创建一个新的 authority 标识。
    ///
    /// # 参数
    /// - `kind`：来源类型
    /// - `id`：来源类型下的唯一 id
    pub fn new(kind: SkillSourceKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
        }
    }
}

/// 不透明的 package id。
///
/// 调用方不应从该值中解析本地路径，应将其视为纯标识符使用。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SkillPackageId(pub String);

/// Skill 包内的不透明 resource id，可选绑定到拥有其内容的环境路径。
///
/// 对于 executor 来源的 skill，resource 可能绑定到具体的环境路径以便后续读取；
/// 对于其他来源，该绑定为 `None`。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SkillResourceId {
    /// resource 的唯一标识
    id: String,
    /// 可选的环境路径绑定，仅用于 executor 来源
    environment_path: Option<EnvironmentSkillResource>,
}

impl SkillResourceId {
    /// 创建一个不带环境绑定的 resource id。
    ///
    /// # 参数
    /// - `id`：resource 的唯一标识
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            environment_path: None,
        }
    }

    /// 创建一个带环境绑定的 resource id，用于 executor 来源的 skill。
    ///
    /// # 参数
    /// - `id`：resource 的唯一标识
    /// - `environment_id`：所属环境的 id
    /// - `path`：该 resource 在环境文件系统中的路径
    pub fn environment(
        id: impl Into<String>,
        environment_id: impl Into<String>,
        path: PathUri,
    ) -> Self {
        Self {
            id: id.into(),
            environment_path: Some(EnvironmentSkillResource {
                environment_id: environment_id.into(),
                path,
            }),
        }
    }

    /// 返回 resource id 的字符串切片。
    pub fn as_str(&self) -> &str {
        &self.id
    }

    /// 返回环境路径绑定（如果存在），用于 executor 来源的 resource 读取。
    ///
    /// # 返回
    /// 返回一个元组：`(environment_id, path)`，若不存在绑定则返回 `None`。
    pub(crate) fn environment_path(&self) -> Option<(&str, &PathUri)> {
        self.environment_path
            .as_ref()
            .map(|resource| (resource.environment_id.as_str(), &resource.path))
    }
}

/// 环境路径绑定信息，将 resource 关联到具体执行环境的文件系统路径。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct EnvironmentSkillResource {
    /// 所属环境 id
    environment_id: String,
    /// 在环境文件系统中的路径
    path: PathUri,
}

/// 在始终可见的 skills 目录中展示的元数据。
///
/// 每个 `SkillCatalogEntry` 描述一个 skill 包的基本信息和展示属性，
/// 包括名称、描述、主 prompt resource、依赖关系以及启用/可见状态。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCatalogEntry {
    /// skill 包的不透明 id
    pub id: SkillPackageId,
    /// skill 所属的 authority
    pub authority: SkillAuthority,
    /// skill 的显示名称
    pub name: String,
    /// skill 的详细描述
    pub description: String,
    /// skill 的简短描述（可选），优先于 `description` 用于目录展示
    pub short_description: Option<String>,
    /// skill 的主 prompt resource id
    pub main_prompt: SkillResourceId,
    /// 用于展示的路径（可选），若未设置则使用 `main_prompt`
    pub display_path: Option<String>,
    /// skill 的依赖关系（可选）
    pub dependencies: Option<SkillDependencies>,
    /// 是否启用，禁用的 skill 不会出现在目录和工具响应中
    pub enabled: bool,
    /// 是否在 prompt 中可见，不可见的 skill 只能通过显式 mention 调用
    pub prompt_visible: bool,
}

impl SkillCatalogEntry {
    /// 创建一个新的目录条目，默认启用且 prompt 可见。
    ///
    /// # 参数
    /// - `id`：skill 包 id
    /// - `authority`：所属 authority
    /// - `name`：显示名称
    /// - `description`：详细描述
    /// - `main_prompt`：主 prompt resource id
    pub fn new(
        id: SkillPackageId,
        authority: SkillAuthority,
        name: impl Into<String>,
        description: impl Into<String>,
        main_prompt: SkillResourceId,
    ) -> Self {
        Self {
            id,
            authority,
            name: name.into(),
            description: description.into(),
            short_description: None,
            main_prompt,
            display_path: None,
            dependencies: None,
            enabled: true,
            prompt_visible: true,
        }
    }

    /// 链式设置简短描述。
    pub fn with_short_description(mut self, short_description: Option<String>) -> Self {
        self.short_description = short_description;
        self
    }

    /// 链式设置展示路径。
    pub fn with_display_path(mut self, display_path: impl Into<String>) -> Self {
        self.display_path = Some(display_path.into());
        self
    }

    /// 链式设置依赖关系。
    pub fn with_dependencies(mut self, dependencies: Option<SkillDependencies>) -> Self {
        self.dependencies = dependencies;
        self
    }

    /// 链式标记为禁用状态。
    pub fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    /// 链式标记为 prompt 不可见，即只能通过显式 mention 调用。
    pub fn hidden_from_prompt(mut self) -> Self {
        self.prompt_visible = false;
        self
    }

    /// 返回用于渲染的路径，优先使用 `display_path`，否则使用 `main_prompt`。
    pub(crate) fn rendered_path(&self) -> &str {
        self.display_path
            .as_deref()
            .unwrap_or_else(|| self.main_prompt.as_str())
    }
}

/// 单个 turn 的合并目录。
///
/// 包含多个 provider 来源的所有 skill 条目以及合并过程中产生的警告信息。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillCatalog {
    /// 合并后的 skill 条目列表
    pub entries: Vec<SkillCatalogEntry>,
    /// 合并过程中产生的警告信息
    pub warnings: Vec<String>,
}

impl SkillCatalog {
    /// 合并另一个目录到当前目录，自动去重并合并警告。
    pub fn extend(&mut self, other: SkillCatalog) {
        for entry in other.entries {
            self.push_entry(entry);
        }
        self.warnings.extend(other.warnings);
    }

    /// 添加一个 skill 条目，若已存在相同 authority 和 id 的条目则跳过（去重）。
    pub fn push_entry(&mut self, entry: SkillCatalogEntry) {
        if self
            .entries
            .iter()
            .any(|existing| existing.authority == entry.authority && existing.id == entry.id)
        {
            return;
        }

        self.entries.push(entry);
    }
}

/// 通过其 owner 解析 skill resource 后返回的内容。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillReadResult {
    /// 读取的 resource id
    pub resource: SkillResourceId,
    /// resource 的文本内容
    pub contents: String,
}

/// 搜索结果，用于无法通过普通 executor 文件系统访问读取文件的包。
///
/// 当前实现中所有 provider 的 `search` 方法均返回空结果，该结构为未来扩展预留。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillSearchResult {
    /// 搜索匹配项列表
    pub matches: Vec<SkillSearchMatch>,
}

/// 单个搜索匹配项。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillSearchMatch {
    /// 匹配的 resource id
    pub resource: SkillResourceId,
    /// 匹配条目的标题
    pub title: String,
    /// 匹配条目的内容摘要
    pub snippet: String,
}

/// Skill provider 错误类型，封装 provider 操作中产生的错误消息。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillProviderError {
    /// 错误消息
    pub message: String,
}

impl SkillProviderError {
    /// 创建一个新的 provider 错误。
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SkillProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

impl std::error::Error for SkillProviderError {}

/// Provider 操作的统一 Result 类型别名。
pub type SkillProviderResult<T> = Result<T, SkillProviderError>;

//! 密钥（secrets）管理模块。
//!
//! 该模块负责对用户密钥进行加密存储、读取、删除与枚举，并提供基于正则表达式的
//! 密钥脱敏（redaction）能力。核心抽象为 [`SecretsBackend`] trait，目前唯一实现是
//! 基于本地加密文件的 [`LocalSecretsBackend`]。上层通过 [`SecretsManager`] 统一访问，
//! 屏蔽具体后端差异。

use std::fmt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use codex_git_utils::get_git_repo_root;
use codex_keyring_store::DefaultKeyringStore;
use codex_keyring_store::KeyringStore;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

mod local;
mod sanitizer;

pub use local::LocalSecretsBackend;
pub use local::LocalSecretsNamespace;
pub use sanitizer::redact_secrets;

/// OS keyring 中用于标识 codex 密钥条目的 service 名称。
const KEYRING_SERVICE: &str = "codex";

/// 密钥名称，仅允许 `A-Z`、`0-9`、`_` 组成的非空字符串。
///
/// 包装类型确保所有密钥名称都经过校验，避免在磁盘映射 key 中出现非法字符。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretName(String);

impl SecretName {
    /// 根据原始字符串构造 [`SecretName`]。
    ///
    /// - `raw`：原始密钥名称，会自动去除首尾空白。
    ///
    /// # 错误
    /// - 名称为空时返回错误。
    /// - 名称包含非法字符（非 `A-Z`、`0-9`、`_`）时返回错误。
    pub fn new(raw: &str) -> Result<Self> {
        let trimmed = raw.trim();
        anyhow::ensure!(!trimmed.is_empty(), "secret name must not be empty");
        anyhow::ensure!(
            trimmed
                .chars()
                .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_'),
            "secret name must contain only A-Z, 0-9 or _"
        );
        Ok(Self(trimmed.to_string()))
    }

    /// 以字符串切片形式返回密钥名称。
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Display for SecretName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 密钥作用域，区分全局密钥与按环境隔离的密钥。
///
/// - [`SecretScope::Global`]：所有环境共享的密钥。
/// - [`SecretScope::Environment`]：仅对特定 environment 生效的密钥。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SecretScope {
    /// 全局作用域，所有 environment 共享。
    Global,
    /// 绑定到特定 environment 的作用域，内部存放 environment id。
    Environment(String),
}

impl SecretScope {
    /// 构造一个绑定到指定 environment 的作用域。
    ///
    /// - `environment_id`：environment 标识符，会自动去除首尾空白。
    ///
    /// # 错误
    /// - environment id 为空时返回错误。
    pub fn environment(environment_id: impl Into<String>) -> Result<Self> {
        let env_id = environment_id.into();
        let trimmed = env_id.trim();
        anyhow::ensure!(!trimmed.is_empty(), "environment id must not be empty");
        Ok(Self::Environment(trimmed.to_string()))
    }

    /// 计算该作用域与指定密钥名称对应的规范化磁盘 key。
    ///
    /// 返回值会作为加密文件内部映射的稳定 key，确保同一密钥在不同环境下互不冲突。
    pub fn canonical_key(&self, name: &SecretName) -> String {
        // 稳定且对环境安全的标识符，用作磁盘映射的 key。
        match self {
            Self::Global => format!("global/{}", name.as_str()),
            Self::Environment(environment_id) => {
                format!("env/{environment_id}/{}", name.as_str())
            }
        }
    }
}

/// 密钥列表条目，描述一条密钥的作用域与名称。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretListEntry {
    /// 密钥所属作用域。
    pub scope: SecretScope,
    /// 密钥名称。
    pub name: SecretName,
}

/// 密钥后端类型枚举。
///
/// 目前仅支持本地加密文件后端 [`SecretsBackendKind::Local`]，保留枚举以便后续扩展。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum SecretsBackendKind {
    /// 本地加密文件后端。
    #[default]
    Local,
}

/// 密钥后端 trait，定义密钥存储所需的最小接口。
///
/// 实现者负责将密钥持久化到具体存储（如本地加密文件、远程密钥库等），
/// 并保证线程安全（`Send + Sync`）。
pub trait SecretsBackend: Send + Sync {
    /// 写入或更新一条密钥。
    fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()>;
    /// 读取一条密钥，返回 `None` 表示不存在。
    fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>>;
    /// 删除一条密钥，返回是否实际删除了（`true` 表示存在并删除）。
    fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool>;
    /// 列出密钥，可通过 `scope_filter` 限定作用域；`None` 表示列出全部。
    fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>>;
}

/// 密钥管理器，对外暴露统一 API，内部委托给具体的 [`SecretsBackend`]。
///
/// 使用 `Arc<dyn SecretsBackend>` 持有后端，因此可低成本克隆并在多个线程间共享。
#[derive(Clone)]
pub struct SecretsManager {
    backend: Arc<dyn SecretsBackend>,
}

impl SecretsManager {
    /// 使用默认 OS keyring 创建 [`SecretsManager`]。
    ///
    /// - `codex_home`：codex 数据目录，用于定位加密文件。
    /// - `backend_kind`：指定后端类型。
    pub fn new(codex_home: PathBuf, backend_kind: SecretsBackendKind) -> Self {
        let backend: Arc<dyn SecretsBackend> = match backend_kind {
            SecretsBackendKind::Local => {
                let keyring_store: Arc<dyn KeyringStore> = Arc::new(DefaultKeyringStore);
                Arc::new(LocalSecretsBackend::new(codex_home, keyring_store))
            }
        };
        Self { backend }
    }

    /// 使用自定义 keyring store 创建 [`SecretsManager`]，便于测试或注入自定义实现。
    pub fn new_with_keyring_store(
        codex_home: PathBuf,
        backend_kind: SecretsBackendKind,
        keyring_store: Arc<dyn KeyringStore>,
    ) -> Self {
        let backend: Arc<dyn SecretsBackend> = match backend_kind {
            SecretsBackendKind::Local => {
                Arc::new(LocalSecretsBackend::new(codex_home, keyring_store))
            }
        };
        Self { backend }
    }

    /// 创建 [`SecretsManager`]，同时指定 keyring store 与本地密钥命名空间。
    ///
    /// 命名空间用于将不同用途的密钥（如 codex 认证、MCP OAuth）隔离到不同加密文件。
    pub fn new_with_keyring_store_and_namespace(
        codex_home: PathBuf,
        backend_kind: SecretsBackendKind,
        keyring_store: Arc<dyn KeyringStore>,
        namespace: LocalSecretsNamespace,
    ) -> Self {
        let backend: Arc<dyn SecretsBackend> = match backend_kind {
            SecretsBackendKind::Local => Arc::new(LocalSecretsBackend::new_with_namespace(
                codex_home,
                keyring_store,
                namespace,
            )),
        };
        Self { backend }
    }

    /// 写入或更新一条密钥，委托给后端实现。
    pub fn set(&self, scope: &SecretScope, name: &SecretName, value: &str) -> Result<()> {
        self.backend.set(scope, name, value)
    }

    /// 读取一条密钥，返回 `None` 表示不存在。
    pub fn get(&self, scope: &SecretScope, name: &SecretName) -> Result<Option<String>> {
        self.backend.get(scope, name)
    }

    /// 删除一条密钥，返回是否实际删除了。
    pub fn delete(&self, scope: &SecretScope, name: &SecretName) -> Result<bool> {
        self.backend.delete(scope, name)
    }

    /// 列出密钥，可通过 `scope_filter` 限定作用域；`None` 表示列出全部。
    pub fn list(&self, scope_filter: Option<&SecretScope>) -> Result<Vec<SecretListEntry>> {
        self.backend.list(scope_filter)
    }
}

/// 根据当前工作目录推导 environment id。
///
/// 优先使用 git 仓库根目录的目录名作为 environment id；若不在 git 仓库内，
/// 则对规范化路径做 SHA-256 哈希并取前 12 位，加上 `cwd-` 前缀作为 fallback。
///
/// - `cwd`：当前工作目录。
pub fn environment_id_from_cwd(cwd: &Path) -> String {
    // 优先尝试取 git 仓库根目录的目录名，便于同一仓库跨机器共享 environment。
    if let Some(repo_root) = get_git_repo_root(cwd)
        && let Some(name) = repo_root.file_name()
    {
        let name = name.to_string_lossy().trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }

    // fallback：对规范化路径做 SHA-256，取前 12 位 hex，避免明文路径暴露。
    let canonical = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{digest:x}");
    let short = hex.get(..12).unwrap_or(hex.as_str());
    format!("cwd-{short}")
}

/// 计算 OS keyring 中用于存储本地密钥 passphrase 的 account 名称。
///
/// 对 `codex_home` 的规范路径做 SHA-256 并取前 16 位 hex，加上 `secrets|` 前缀，
/// 保证同一台机器上不同 codex_home 对应不同 passphrase。
pub fn compute_keyring_account(codex_home: &Path) -> String {
    let canonical = codex_home
        .canonicalize()
        .unwrap_or_else(|_| codex_home.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{digest:x}");
    let short = hex.get(..16).unwrap_or(hex.as_str());
    format!("secrets|{short}")
}

/// 返回 OS keyring 中用于 codex 密钥的 service 名称，仅供 crate 内部使用。
pub(crate) fn keyring_service() -> &'static str {
    KEYRING_SERVICE
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_keyring_store::tests::MockKeyringStore;
    use pretty_assertions::assert_eq;

    #[test]
    fn environment_id_fallback_has_cwd_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let env_id = environment_id_from_cwd(dir.path());
        let canonical = dir
            .path()
            .canonicalize()
            .expect("tempdir canonical path should exist")
            .to_string_lossy()
            .into_owned();
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        let digest = hasher.finalize();
        let hex = format!("{digest:x}");
        let short = hex.get(..12).expect("digest has at least 12 chars");
        assert_eq!(env_id, format!("cwd-{short}"));
    }

    #[test]
    fn manager_round_trips_local_backend() -> Result<()> {
        let codex_home = tempfile::tempdir().expect("tempdir");
        let keyring = Arc::new(MockKeyringStore::default());
        let manager = SecretsManager::new_with_keyring_store(
            codex_home.path().to_path_buf(),
            SecretsBackendKind::Local,
            keyring,
        );
        let scope = SecretScope::Global;
        let name = SecretName::new("GITHUB_TOKEN")?;

        manager.set(&scope, &name, "token-1")?;
        assert_eq!(manager.get(&scope, &name)?, Some("token-1".to_string()));

        let listed = manager.list(/*scope_filter*/ None)?;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, name);

        assert!(manager.delete(&scope, &name)?);
        assert_eq!(manager.get(&scope, &name)?, None);
        Ok(())
    }
}

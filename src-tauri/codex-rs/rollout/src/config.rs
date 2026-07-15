use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

/// Rollout 配置的只读视图 trait，供依赖注入与解耦使用。
pub trait RolloutConfigView {
    /// 返回 Codex 主目录路径。
    fn codex_home(&self) -> &Path;
    /// 返回 SQLite 数据库所在目录路径。
    fn sqlite_home(&self) -> &Path;
    /// 返回当前工作目录路径。
    fn cwd(&self) -> &Path;
    /// 返回模型 provider ID。
    fn model_provider_id(&self) -> &str;
    /// 返回是否启用 memory 生成。
    fn generate_memories(&self) -> bool;
}

/// Rollout 配置的具体实现，存储所有相关路径与开关。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RolloutConfig {
    /// Codex 主目录路径。
    pub codex_home: PathBuf,
    /// SQLite 数据库所在目录路径。
    pub sqlite_home: PathBuf,
    /// 当前工作目录路径。
    pub cwd: PathBuf,
    /// 模型 provider ID。
    pub model_provider_id: String,
    /// 是否启用 memory 生成。
    pub generate_memories: bool,
}

/// 配置的别名类型，便于上层引用。
pub type Config = RolloutConfig;

impl RolloutConfig {
    /// 从任意实现了 [`RolloutConfigView`] 的对象构造配置。
    ///
    /// # 参数
    /// - `view`: 配置视图引用
    ///
    /// # 返回值
    /// 返回克隆得到的 [`RolloutConfig`]。
    pub fn from_view(view: &impl RolloutConfigView) -> Self {
        Self {
            codex_home: view.codex_home().to_path_buf(),
            sqlite_home: view.sqlite_home().to_path_buf(),
            cwd: view.cwd().to_path_buf(),
            model_provider_id: view.model_provider_id().to_string(),
            generate_memories: view.generate_memories(),
        }
    }
}

impl RolloutConfigView for RolloutConfig {
    fn codex_home(&self) -> &Path {
        self.codex_home.as_path()
    }

    fn sqlite_home(&self) -> &Path {
        self.sqlite_home.as_path()
    }

    fn cwd(&self) -> &Path {
        self.cwd.as_path()
    }

    fn model_provider_id(&self) -> &str {
        self.model_provider_id.as_str()
    }

    fn generate_memories(&self) -> bool {
        self.generate_memories
    }
}

impl<T: RolloutConfigView + ?Sized> RolloutConfigView for &T {
    fn codex_home(&self) -> &Path {
        (*self).codex_home()
    }

    fn sqlite_home(&self) -> &Path {
        (*self).sqlite_home()
    }

    fn cwd(&self) -> &Path {
        (*self).cwd()
    }

    fn model_provider_id(&self) -> &str {
        (*self).model_provider_id()
    }

    fn generate_memories(&self) -> bool {
        (*self).generate_memories()
    }
}

impl<T: RolloutConfigView + ?Sized> RolloutConfigView for Arc<T> {
    fn codex_home(&self) -> &Path {
        self.as_ref().codex_home()
    }

    fn sqlite_home(&self) -> &Path {
        self.as_ref().sqlite_home()
    }

    fn cwd(&self) -> &Path {
        self.as_ref().cwd()
    }

    fn model_provider_id(&self) -> &str {
        self.as_ref().model_provider_id()
    }

    fn generate_memories(&self) -> bool {
        self.as_ref().generate_memories()
    }
}

//! 本地文件系统 memories 后端模块。
//!
//! 该模块实现 [`LocalMemoriesBackend`]，基于文件系统提供 memories 的
//! 增删查改操作。所有路径操作均限制在 memories 根目录内，
//! 拒绝符号链接以防止路径逃逸。
//!
//! ## 子模块
//!
//! - [`ad_hoc_note`](ad_hoc_note)：临时笔记创建
//! - [`list`](list)：目录列表
//! - [`path`](path)：路径安全工具
//! - [`read`](read)：文件读取
//! - [`search`](search)：文件搜索

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use codex_utils_absolute_path::AbsolutePathBuf;

use crate::backend::AddAdHocMemoryNoteRequest;
use crate::backend::AddAdHocMemoryNoteResponse;
use crate::backend::ListMemoriesRequest;
use crate::backend::ListMemoriesResponse;
use crate::backend::MemoriesBackend;
use crate::backend::MemoriesBackendError;
use crate::backend::ReadMemoryRequest;
use crate::backend::ReadMemoryResponse;
use crate::backend::SearchMemoriesRequest;
use crate::backend::SearchMemoriesResponse;

// 本地实现子模块
mod ad_hoc_note;
mod list;
mod path;
mod read;
mod search;

/// 基于本地文件系统的 memories 后端实现。
///
/// 所有路径操作均限制在 `root` 目录内，拒绝符号链接和路径穿越。
#[derive(Debug, Clone)]
pub(crate) struct LocalMemoriesBackend {
    /// memories 根目录路径
    root: PathBuf,
}

impl LocalMemoriesBackend {
    /// 从 Codex 主目录创建 backend，memories 根目录为 `<codex_home>/memories`。
    pub(crate) fn from_codex_home(codex_home: &AbsolutePathBuf) -> Self {
        Self::from_memory_root(codex_home.join("memories").to_path_buf())
    }

    /// 从指定的 memories 根目录创建 backend。
    pub(crate) fn from_memory_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 将相对路径解析为 memories 根目录内的绝对路径。
    ///
    /// # 参数
    /// - `relative_path`：相对路径（`None` 表示根目录）
    ///
    /// # 安全检查
    /// 1. 拒绝 `..`、根目录、前缀组件（防止路径穿越）
    /// 2. 拒绝隐藏文件组件（以 `.` 开头）
    /// 3. 拒绝符号链接
    /// 4. 拒绝穿越非目录组件
    ///
    /// # 返回
    /// 成功时返回解析后的绝对路径；失败时返回对应的错误。
    async fn resolve_scoped_path(
        &self,
        relative_path: Option<&str>,
    ) -> Result<PathBuf, MemoriesBackendError> {
        let Some(relative_path) = relative_path else {
            return Ok(self.root.clone());
        };
        let relative = Path::new(relative_path);
        // 拒绝路径穿越组件
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(MemoriesBackendError::invalid_path(
                relative_path,
                "must stay within the memories root",
            ));
        }
        // 拒绝隐藏文件组件
        if relative.components().any(path::is_hidden_component) {
            return Err(MemoriesBackendError::NotFound {
                path: relative_path.to_string(),
            });
        }

        let components = relative.components().collect::<Vec<_>>();
        let mut scoped_path = self.root.clone();
        for (idx, component) in components.iter().enumerate() {
            scoped_path.push(component.as_os_str());

            let Some(metadata) = Self::metadata_or_none(&scoped_path).await? else {
                // 路径不存在时，补全剩余组件后返回（供写入操作使用）
                for remaining_component in components.iter().skip(idx + 1) {
                    scoped_path.push(remaining_component.as_os_str());
                }
                return Ok(scoped_path);
            };

            // 拒绝符号链接
            path::reject_symlink(
                &path::display_relative_path(&self.root, &scoped_path),
                &metadata,
            )?;
            // 中间组件必须是目录
            if idx + 1 < components.len() && !metadata.is_dir() {
                return Err(MemoriesBackendError::invalid_path(
                    relative_path,
                    "traverses through a non-directory path component",
                ));
            }
        }

        Ok(scoped_path)
    }

    /// 读取路径的符号链接元数据，路径不存在时返回 `None`。
    async fn metadata_or_none(
        path: &Path,
    ) -> Result<Option<std::fs::Metadata>, MemoriesBackendError> {
        match tokio::fs::symlink_metadata(path).await {
            Ok(metadata) => Ok(Some(metadata)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }
}

impl MemoriesBackend for LocalMemoriesBackend {
    async fn add_ad_hoc_note(
        &self,
        request: AddAdHocMemoryNoteRequest,
    ) -> Result<AddAdHocMemoryNoteResponse, MemoriesBackendError> {
        ad_hoc_note::add_ad_hoc_note(self, request).await
    }

    async fn list(
        &self,
        request: ListMemoriesRequest,
    ) -> Result<ListMemoriesResponse, MemoriesBackendError> {
        list::list(self, request).await
    }

    async fn read(
        &self,
        request: ReadMemoryRequest,
    ) -> Result<ReadMemoryResponse, MemoriesBackendError> {
        read::read(self, request).await
    }

    async fn search(
        &self,
        request: SearchMemoriesRequest,
    ) -> Result<SearchMemoriesResponse, MemoriesBackendError> {
        search::search(self, request).await
    }
}

//! Memories 存储后端接口模块。
//!
//! 该模块定义 [`MemoriesBackend`] trait，抽象 memories 工具的存储操作。
//! 实现方应返回相对于 memory store 的路径，并自行强制存储特定的访问规则。
//!
//! 当前实现 [`LocalMemoriesBackend`](crate::local::LocalMemoriesBackend) 基于文件系统；
//! 未来可通过实现同一 trait 从远程后端满足相同契约。

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::future::Future;

/// Memories 存储后端接口。
///
/// 实现方应返回相对于 memory store 的路径，并自行强制存储特定的访问规则。
/// 当前本地实现使用文件系统；未来可通过实现同一 trait 从远程后端满足相同契约。
pub trait MemoriesBackend: Clone + Send + Sync + 'static {
    /// 创建一条临时记忆笔记。
    fn add_ad_hoc_note(
        &self,
        request: AddAdHocMemoryNoteRequest,
    ) -> impl Future<Output = Result<AddAdHocMemoryNoteResponse, MemoriesBackendError>> + Send;

    /// 列出指定路径下的文件和目录。
    fn list(
        &self,
        request: ListMemoriesRequest,
    ) -> impl Future<Output = Result<ListMemoriesResponse, MemoriesBackendError>> + Send;

    /// 按路径读取 memory 文件内容。
    fn read(
        &self,
        request: ReadMemoryRequest,
    ) -> impl Future<Output = Result<ReadMemoryResponse, MemoriesBackendError>> + Send;

    /// 在 memory 文件中搜索子串匹配。
    fn search(
        &self,
        request: SearchMemoriesRequest,
    ) -> impl Future<Output = Result<SearchMemoriesResponse, MemoriesBackendError>> + Send;
}

/// 创建临时记忆笔记的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddAdHocMemoryNoteRequest {
    /// 笔记文件名（格式：`YYYY-MM-DDTHH-MM-SS-<slug>.md`）
    pub filename: String,
    /// 笔记内容
    pub note: String,
}

/// 创建临时记忆笔记的响应（空对象）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AddAdHocMemoryNoteResponse {}

/// 列出 memories 的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListMemoriesRequest {
    /// 相对路径（`None` 表示从根目录开始）
    pub path: Option<String>,
    /// 分页游标
    pub cursor: Option<String>,
    /// 最大返回结果数
    pub max_results: usize,
}

/// 列出 memories 的响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ListMemoriesResponse {
    /// 请求的路径
    pub path: Option<String>,
    /// 目录条目列表
    pub entries: Vec<MemoryEntry>,
    /// 下一页游标（`None` 表示无更多数据）
    pub next_cursor: Option<String>,
    /// 结果是否被截断
    pub truncated: bool,
}

/// 读取 memory 文件的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadMemoryRequest {
    /// 相对路径
    pub path: String,
    /// 起始行号（1-indexed）
    pub line_offset: usize,
    /// 最大读取行数
    pub max_lines: Option<usize>,
    /// 最大 token 数
    pub max_tokens: usize,
}

/// 读取 memory 文件的响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ReadMemoryResponse {
    /// 读取的文件路径
    pub path: String,
    /// 内容起始行号（1-indexed）
    pub start_line_number: usize,
    /// 文件内容
    pub content: String,
    /// 内容是否被截断
    pub truncated: bool,
}

/// 搜索 memories 的请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMemoriesRequest {
    /// 搜索查询列表
    pub queries: Vec<String>,
    /// 匹配模式
    pub match_mode: SearchMatchMode,
    /// 搜索范围路径（`None` 表示全部）
    pub path: Option<String>,
    /// 分页游标
    pub cursor: Option<String>,
    /// 上下文行数
    pub context_lines: usize,
    /// 是否区分大小写
    pub case_sensitive: bool,
    /// 是否归一化（仅保留字母数字）
    pub normalized: bool,
    /// 最大返回结果数
    pub max_results: usize,
}

/// 搜索 memories 的响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SearchMemoriesResponse {
    /// 搜索查询列表
    pub queries: Vec<String>,
    /// 匹配模式
    pub match_mode: SearchMatchMode,
    /// 搜索范围路径
    pub path: Option<String>,
    /// 匹配结果列表
    pub matches: Vec<MemorySearchMatch>,
    /// 下一页游标
    pub next_cursor: Option<String>,
    /// 结果是否被截断
    pub truncated: bool,
}

/// 搜索匹配模式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SearchMatchMode {
    /// 任意查询匹配即命中
    Any,
    /// 所有查询在同一行匹配才命中
    AllOnSameLine,
    /// 所有查询在指定行数窗口内匹配才命中
    AllWithinLines {
        /// 窗口行数（最小为 1）
        #[schemars(range(min = 1))]
        line_count: usize,
    },
}

/// memory 目录条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct MemoryEntry {
    /// 相对路径
    pub path: String,
    /// 条目类型（文件/目录）
    pub entry_type: MemoryEntryType,
}

/// memory 条目类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEntryType {
    /// 文件
    File,
    /// 目录
    Directory,
}

/// 单条搜索匹配结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct MemorySearchMatch {
    /// 匹配文件路径
    pub path: String,
    /// 匹配行号（1-indexed）
    pub match_line_number: usize,
    /// 内容起始行号（1-indexed）
    pub content_start_line_number: usize,
    /// 匹配上下文内容
    pub content: String,
    /// 命中的查询列表
    pub matched_queries: Vec<String>,
}

/// memories 后端操作错误。
#[derive(Debug, thiserror::Error)]
pub enum MemoriesBackendError {
    /// 文件名无效
    #[error("filename '{filename}' {reason}")]
    InvalidFilename { filename: String, reason: String },
    /// 临时笔记内容为空
    #[error("ad-hoc note must not be empty")]
    EmptyAdHocNote,
    /// 临时笔记已存在
    #[error("ad-hoc note '{filename}' already exists")]
    AdHocNoteAlreadyExists { filename: String },
    /// 路径无效
    #[error("path '{path}' {reason}")]
    InvalidPath { path: String, reason: String },
    /// 游标无效
    #[error("cursor '{cursor}' {reason}")]
    InvalidCursor { cursor: String, reason: String },
    /// 路径未找到
    #[error("path '{path}' was not found")]
    NotFound { path: String },
    /// 行偏移无效（必须为 1-indexed）
    #[error("line_offset must be a 1-indexed line number")]
    InvalidLineOffset,
    /// 最大行数无效
    #[error("max_lines must be a positive integer")]
    InvalidMaxLines,
    /// 行偏移超出文件长度
    #[error("line_offset exceeds file length")]
    LineOffsetExceedsFileLength,
    /// 路径不是文件
    #[error("path '{path}' is not a file")]
    NotFile { path: String },
    /// 查询为空或包含空字符串
    #[error("queries must not be empty or contain empty strings")]
    EmptyQuery,
    /// 匹配窗口行数无效
    #[error("all_within_lines.line_count must be a positive integer")]
    InvalidMatchWindow,
    /// IO 错误
    #[error("I/O error while reading memories: {0}")]
    Io(#[from] std::io::Error),
}

impl MemoriesBackendError {
    /// 创建文件名无效错误。
    pub fn invalid_filename(filename: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidFilename {
            filename: filename.into(),
            reason: reason.into(),
        }
    }

    /// 创建路径无效错误。
    pub fn invalid_path(path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidPath {
            path: path.into(),
            reason: reason.into(),
        }
    }

    /// 创建游标无效错误。
    pub fn invalid_cursor(cursor: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidCursor {
            cursor: cursor.into(),
            reason: reason.into(),
        }
    }
}

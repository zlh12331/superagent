use serde::Serialize;
use sqlx::FromRow;

/// 待写入 logs DB 的单条日志条目。
#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    /// 秒级时间戳。
    pub ts: i64,
    /// 纳秒部分（不足 1s 的偏移）。
    pub ts_nanos: i64,
    /// 日志级别字符串（如 "INFO"、"DEBUG"）。
    pub level: String,
    /// tracing target。
    pub target: String,
    /// 日志正文消息。
    pub message: Option<String>,
    /// 反馈日志正文（包含 span 上下文与格式化字段）。
    pub feedback_log_body: Option<String>,
    /// 关联的 thread ID（可能为空）。
    pub thread_id: Option<String>,
    /// 进程级 UUID 标识。
    pub process_uuid: Option<String>,
    /// 模块路径。
    pub module_path: Option<String>,
    /// 源文件路径。
    pub file: Option<String>,
    /// 源文件行号。
    pub line: Option<i64>,
}

/// 从 logs DB 读取出的单行记录。
#[derive(Clone, Debug, FromRow)]
pub struct LogRow {
    /// 自增主键 ID。
    pub id: i64,
    /// 秒级时间戳。
    pub ts: i64,
    /// 纳秒部分（不足 1s 的偏移）。
    pub ts_nanos: i64,
    /// 日志级别字符串。
    pub level: String,
    /// tracing target。
    pub target: String,
    /// 日志正文消息。
    pub message: Option<String>,
    /// 关联的 thread ID。
    pub thread_id: Option<String>,
    /// 进程级 UUID 标识。
    pub process_uuid: Option<String>,
    /// 源文件路径。
    pub file: Option<String>,
    /// 源文件行号。
    pub line: Option<i64>,
}

/// 日志查询过滤条件。
#[derive(Clone, Debug, Default)]
pub struct LogQuery {
    /// 仅返回级别大于等于这些值之一的日志。
    pub levels_upper: Vec<String>,
    /// 起始时间戳（含）。
    pub from_ts: Option<i64>,
    /// 截止时间戳（含）。
    pub to_ts: Option<i64>,
    /// 模块路径模糊匹配模式列表。
    pub module_like: Vec<String>,
    /// 文件路径模糊匹配模式列表。
    pub file_like: Vec<String>,
    /// 限定的 thread ID 列表。
    pub thread_ids: Vec<String>,
    /// 全文搜索关键词。
    pub search: Option<String>,
    /// 是否包含 threadless 日志（thread_id 为 NULL）。
    pub include_threadless: bool,
    /// 分页起始 ID（不含）。
    pub after_id: Option<i64>,
    /// 返回条数上限。
    pub limit: Option<usize>,
    /// 是否按时间倒序返回。
    pub descending: bool,
}

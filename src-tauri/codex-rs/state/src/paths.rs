//! 路径与文件系统辅助函数。

use chrono::DateTime;
use chrono::Utc;
use std::path::Path;

/// 读取文件最近修改时间（UTC）。
///
/// # 参数
/// - `path`: 文件路径
///
/// # 返回值
/// 返回文件的最近修改时间；若读取元数据或修改时间失败则返回 `None`。
pub(crate) async fn file_modified_time_utc(path: &Path) -> Option<DateTime<Utc>> {
    let modified = tokio::fs::metadata(path).await.ok()?.modified().ok()?;
    let updated_at: DateTime<Utc> = modified.into();
    Some(updated_at)
}

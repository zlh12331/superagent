//! Codex memories 读路径辅助工具。
//!
//! 该 crate 负责 memory 注入、memory citation 解析以及 memory 目录读取访问的
//! 遥测分类。刻意不依赖 memory 写入流水线，保持读路径与写路径解耦。

pub mod citations;
mod metrics;
pub mod usage;

use codex_utils_absolute_path::AbsolutePathBuf;

/// 返回指定 codex_home 下的 memories 目录路径。
///
/// - `codex_home`：codex 数据根目录。
pub fn memory_root(codex_home: &AbsolutePathBuf) -> AbsolutePathBuf {
    codex_home.join("memories")
}

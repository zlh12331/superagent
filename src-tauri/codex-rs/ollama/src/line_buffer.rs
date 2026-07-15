//! 行缓冲区模块。
//!
//! 提供增量式按行切分的字节缓冲区，用于解析流式 HTTP 响应中的 NDJSON。
//! 通过记录已扫描前缀避免重复搜索换行符，提升流式解析性能。

use bytes::BytesMut;
use memchr::memchr;

/// 增量式行缓冲区：内部维护字节缓冲与已扫描前缀长度。
#[derive(Default)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(crate) struct LineBuffer {
    bytes: BytesMut,
    /// 已扫描且确认不含换行符的前缀长度
    scanned_len: usize,
}

impl LineBuffer {
    /// 追加字节到缓冲区末尾。
    pub(crate) fn extend_from_slice(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    /// 取出下一行（不含换行符后的内容，但保留尾部换行符）。
    ///
    /// 若缓冲区中暂无完整行则返回 `None`，并更新已扫描前缀以便下次从该位置继续搜索。
    pub(crate) fn take_line(&mut self) -> Option<BytesMut> {
        let Some(relative_index) = memchr(b'\n', &self.bytes[self.scanned_len..]) else {
            self.scanned_len = self.bytes.len();
            return None;
        };

        let newline_index = self.scanned_len + relative_index;
        let line = self.bytes.split_to(newline_index + 1);
        self.scanned_len = 0;
        Some(line)
    }
}

#[cfg(test)]
#[path = "line_buffer_tests.rs"]
mod tests;

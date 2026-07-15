//! Shell 输出的文本编码检测与转换工具集。
//!
//! Windows 用户在通过 VS Code 调用命令时经常会遇到 CP1251、CP866 等代码页。
//! 这些字节流并非合法 UTF-8，过去会被替换为 Unicode 替换字符。现在我们借助
//! `chardetng` 和 `encoding_rs`，在退回到 lossy UTF-8 解码前，自动检测并解码
//! 绝大多数 legacy 编码，从而保留用户可读的文本。

use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use encoding_rs::IBM866;
use encoding_rs::WINDOWS_1252;
use std::time::Duration;

/// 命令执行产生的单路流输出（stdout / stderr / 聚合输出）。
///
/// `text` 既可以是原始字节序列（`Vec<u8>`），也可以是已解码的字符串；
/// `truncated_after_lines` 在输出被按行截断时记录原始行数上限，便于 UI 提示。
#[derive(Debug, Clone)]
pub struct StreamOutput<T: Clone> {
    /// 流文本内容（字节或字符串）。
    pub text: T,
    /// 截断前的原始行数；`None` 表示未发生行级截断。
    pub truncated_after_lines: Option<u32>,
}

impl StreamOutput<String> {
    /// 以字符串构造未截断的 `StreamOutput`。
    pub fn new(text: String) -> Self {
        Self {
            text,
            truncated_after_lines: None,
        }
    }
}

impl StreamOutput<Vec<u8>> {
    /// 将字节流按启发式编码检测解码为字符串流，保留截断信息。
    pub fn from_utf8_lossy(&self) -> StreamOutput<String> {
        StreamOutput {
            text: bytes_to_string_smart(&self.text),
            truncated_after_lines: self.truncated_after_lines,
        }
    }
}

/// 一次工具调用（命令执行）的完整输出快照。
///
/// 同时包含 stdout、stderr 与聚合输出，便于上层 UI 分别呈现并保留时序信息。
#[derive(Clone, Debug)]
pub struct ExecToolCallOutput {
    /// 进程退出码；超时情况下由调用方决定如何呈现。
    pub exit_code: i32,
    /// 标准输出流。
    pub stdout: StreamOutput<String>,
    /// 标准错误流。
    pub stderr: StreamOutput<String>,
    /// stdout 与 stderr 按到达顺序合并后的聚合输出。
    pub aggregated_output: StreamOutput<String>,
    /// 进程实际运行时长。
    pub duration: Duration,
    /// 是否因超时被强制终止。
    pub timed_out: bool,
}

impl Default for ExecToolCallOutput {
    fn default() -> Self {
        Self {
            exit_code: 0,
            stdout: StreamOutput::new(String::new()),
            stderr: StreamOutput::new(String::new()),
            aggregated_output: StreamOutput::new(String::new()),
            duration: Duration::ZERO,
            timed_out: false,
        }
    }
}

/// 尽力将任意字节序列转换为 UTF-8 字符串，附带编码检测。
///
/// 解码顺序：
/// 1. 若字节本身就是合法 UTF-8，直接返回；
/// 2. 否则通过 `chardetng` 检测可能的编码，并用 `encoding_rs` 解码；
/// 3. 检测解码失败时退回到 `String::from_utf8_lossy` 的替换字符方案。
pub fn bytes_to_string_smart(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(utf8_str) = std::str::from_utf8(bytes) {
        return utf8_str.to_owned();
    }

    let encoding = detect_encoding(bytes);
    decode_bytes(bytes, encoding)
}

// Windows-1252 把 0x80-0x9F 中的一部分槽位重新分配给“智能标点”（弯引号、破折号、™）。
// CP866 把这些**相同的字节值**用于大写西里尔字母。当 chardetng 在混合这些字节与 ASCII 的
// shell 片段上识别时，偶尔会猜测为 IBM866，导致“智能引号”渲染成乱码西里尔字符
// （“УФЦ”）。但 CP866 大写 token 也是完全合法的输出（例如 `ПРИ test`），所以我们不能把
// 0x80-0x9F 字节一律改判为 Windows-1252。折中方案：仅当 (a) 高位字节仅由下方列举的标点
// 值组成，且 (b) 我们观察到相邻 ASCII 时，才把 IBM866 改判为 Windows-1252。这精准命中
// 真实失败场景，又不会破坏合法的西里尔文本。若其它代码页存在类似冲突，请引入一个独立的
// allowlist（类似下方这个）并补充覆盖真实 shell 输出的单元测试。
// Windows-1252 智能标点字节表。
const WINDOWS_1252_PUNCT_BYTES: [u8; 8] = [
    0x91, // ‘（左单引号）
    0x92, // ’（右单引号）
    0x93, // “（左双引号）
    0x94, // ”（右双引号）
    0x95, // •（项目符号）
    0x96, // –（en 破折号）
    0x97, // —（em 破折号）
    0x99, // ™（商标符号）
];

/// 检测字节流最可能的编码，并对 IBM866 误判做 Windows-1252 修正。
fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let (encoding, _is_confident) = detector.guess_assess(None, true);

    // chardetng 偶尔会对仅包含 Windows-1252 “智能标点”字节（0x80-0x9F）的短字符串报告
    // IBM866，因为该范围在 IBM866 中映射到西里尔字母。当这些字节旁边出现 ASCII 单词
    // （典型 shell 输出：`"“`test`）时，可推断用户意图很可能是 CP1252 引号/破折号。
    // 此时优先使用 WINDOWS_1252，渲染出用户期望的字符而非西里尔乱码。参考：
    // - Windows-1252 在 0x80-0x9F 区间保留弯引号/破折号：
    //   https://en.wikipedia.org/wiki/Windows-1252
    // - CP866 把 0x93/0x94/0x96 映射到西里尔字母，因此同样的字节被误解码为
    //   “УФЦ”：https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP866.TXT
    if encoding == IBM866 && looks_like_windows_1252_punctuation(bytes) {
        return WINDOWS_1252;
    }

    encoding
}

/// 用指定编码解码字节流，解码出错时退回到 lossy UTF-8。
fn decode_bytes(bytes: &[u8], encoding: &'static Encoding) -> String {
    let (decoded, _, had_errors) = encoding.decode(bytes);

    if had_errors {
        return String::from_utf8_lossy(bytes).into_owned();
    }

    decoded.into_owned()
}

/// 判断字节流是否像“Windows-1252 智能标点包裹 ASCII 文本”的形态。
///
/// 背景说明：IBM866 与 Windows-1252 共享 0x80-0x9F 槽位。在 IBM866 中这些字节解码为
/// 西里尔字母，而 Windows-1252 把它们映射为弯引号与破折号。chardetng 对仅含这些字节
/// 的短片段可能猜测 IBM866，从而把 shell 输出 `“test”` 变成不可读的西里尔文。为避免这
/// 一情况，我们把由少量问题区间字节加 ASCII 字母组成的输入视为 CP1252 标点。我们刻意
/// 不限制可接受的标点字节数量：VS Code 经常输出多个被引号包裹的短语（例如
/// `"foo" - "bar"`），如果限制数量，这些片段又会被误解码为西里尔文。若未来发现其它编
/// 码也存在字节区间重叠，应优先添加编码专属的字节 allowlist（类似
/// `WINDOWS_1252_PUNCT_BYTES`）并补充覆盖真实 shell 片段的测试。
fn looks_like_windows_1252_punctuation(bytes: &[u8]) -> bool {
    let mut saw_extended_punctuation = false;
    let mut saw_ascii_word = false;

    for &byte in bytes {
        if byte >= 0xA0 {
            return false;
        }
        if (0x80..=0x9F).contains(&byte) {
            if !is_windows_1252_punct(byte) {
                return false;
            }
            saw_extended_punctuation = true;
        }
        if byte.is_ascii_alphabetic() {
            saw_ascii_word = true;
        }
    }

    saw_extended_punctuation && saw_ascii_word
}

/// 判断单字节是否属于 Windows-1252 智能标点。
fn is_windows_1252_punct(byte: u8) -> bool {
    WINDOWS_1252_PUNCT_BYTES.contains(&byte)
}

#[cfg(test)]
#[path = "exec_output_tests.rs"]
mod tests;

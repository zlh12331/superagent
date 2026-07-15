use std::path::Path;

/// Windows 平台下需要剥离的可执行文件后缀列表。
#[cfg(windows)]
const WINDOWS_EXECUTABLE_SUFFIXES: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];

/// 把原始可执行文件名转换为查询键。
///
/// 在 Windows 上会去除 `.exe`/`.cmd`/`.bat`/`.com` 后缀并转小写，
/// 以便与策略中的规则名做大小写不敏感比较；其他平台原样返回。
pub(crate) fn executable_lookup_key(raw: &str) -> String {
    #[cfg(windows)]
    {
        let raw = raw.to_ascii_lowercase();
        for suffix in WINDOWS_EXECUTABLE_SUFFIXES {
            if raw.ends_with(suffix) {
                let stripped_len = raw.len() - suffix.len();
                return raw[..stripped_len].to_string();
            }
        }
        raw
    }

    #[cfg(not(windows))]
    {
        raw.to_string()
    }
}

/// 从路径中提取文件名并转换为查询键。
///
/// 返回 `None` 当路径没有文件名部分（如根目录 `/`）。
pub(crate) fn executable_path_lookup_key(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(executable_lookup_key)
}

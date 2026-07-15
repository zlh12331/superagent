//! Analytics 事件本地文件捕获（仅 debug 构建）。
//!
//! 当环境变量 `CODEX_ANALYTICS_EVENTS_CAPTURE_FILE` 设置时，
//! analytics 事件会被写入指定的本地文件（NDJSON 格式），
//! 而不会发送到后端网络。用于本地调试与测试。

use crate::events::TrackEventsRequest;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::Path;

pub(crate) const ANALYTICS_EVENTS_CAPTURE_FILE_ENV_VAR: &str =
    "CODEX_ANALYTICS_EVENTS_CAPTURE_FILE";

pub(crate) fn initialize(path: &Path) -> io::Result<()> {
    open_capture_file(path).map(drop)
}

pub(crate) fn append_payload(path: &Path, payload: &TrackEventsRequest) -> io::Result<()> {
    let mut line = serde_json::to_vec(payload)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    line.push(b'\n');

    let mut file = open_capture_file(path)?;
    file.write_all(&line)?;
    file.flush()
}

fn open_capture_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

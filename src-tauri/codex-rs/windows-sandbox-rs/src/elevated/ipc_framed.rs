//! 用于 parent (CLI) 与 elevated command runner 之间的 framed IPC 协议。
//!
//! 本模块定义了 JSON message schema（spawn request/ready、output、stdin、
//! exit、error、terminate）以及用于字节流的 length-prefixed framing 辅助函数。
//! 该模块仅用于 **elevated-path only**：parent 使用它来 bootstrap runner 并
//! 通过 named pipes 流式传输 unified-exec I/O。legacy restricted-token 路径不
//! 使用此协议，非 unified exec capture 仅在通过 elevated runner 运行时才使用它。

use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use codex_protocol::models::PermissionProfile;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;

/// 单个 framed message payload 的安全上限。
///
/// 这不是 protocol requirement；它只是限制 memory use 并拒绝
/// 明显无效的 frames。
const MAX_FRAME_LEN: usize = 8 * 1024 * 1024;

/// parent process 与 elevated command runner 共享的 Protocol version。
pub const IPC_PROTOCOL_VERSION: u8 = 4;

/// Length-prefixed、JSON 编码的 frame。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FramedMessage {
    pub version: u8,
    #[serde(flatten)]
    pub message: Message,
}

/// parent 与 runner 之间交换的 IPC message 变体。
///
/// `SpawnRequest`、`Stdin`、`CloseStdin`、`Resize` 和 `Terminate` 是 parent->runner 命令。
/// `SpawnReady`、`Output`、`Exit` 和 `Error` 是 runner->parent 事件/结果。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    SpawnRequest { payload: Box<SpawnRequest> },
    SpawnReady { payload: SpawnReady },
    Output { payload: OutputPayload },
    Stdin { payload: StdinPayload },
    CloseStdin { payload: EmptyPayload },
    Resize { payload: ResizePayload },
    Exit { payload: ExitPayload },
    Error { payload: ErrorPayload },
    Terminate { payload: EmptyPayload },
}

/// 从 parent 发送给 runner 的 Spawn 参数。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpawnRequest {
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub permission_profile: PermissionProfile,
    pub workspace_roots: Vec<AbsolutePathBuf>,
    pub codex_home: PathBuf,
    pub real_codex_home: PathBuf,
    pub cap_sids: Vec<String>,
    pub timeout_ms: Option<u64>,
    pub tty: bool,
    #[serde(default)]
    pub stdin_open: bool,
    #[serde(default)]
    pub use_private_desktop: bool,
}

/// runner 在 spawns child process 后发送的 Ack 确认消息。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpawnReady {
    pub process_id: u32,
}

/// 从 runner 发送给 parent 的 Output 数据。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OutputPayload {
    pub data_b64: String,
    pub stream: OutputStream,
}

/// `OutputPayload` 的 Output stream 标识符。
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// 从 parent 发送给 runner 的 Stdin 字节数据。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StdinPayload {
    pub data_b64: String,
}

/// 从 parent 发送给 runner 的 PTY resize 请求。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResizePayload {
    pub rows: u16,
    pub cols: u16,
}

/// 从 runner 发送给 parent 的 Exit 状态。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExitPayload {
    pub exit_code: i32,
    pub timed_out: bool,
}

/// 当 runner 无法 spawn 或 stream 时发送的 Error payload。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ErrorPayload {
    pub message: String,
    pub stage: ErrorStage,
    pub windows_error_code: Option<u32>,
}

/// 产生错误的 Runner startup stage。
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorStage {
    ReadSpawnRequest,
    SpawnChild,
    WriteSpawnReady,
}

/// 用于控制消息的 Empty payload。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct EmptyPayload {}

/// 将原始字节进行 Base64 编码，用于 IPC payloads。
pub fn encode_bytes(data: &[u8]) -> String {
    STANDARD.encode(data)
}

/// 将 base64 编码的 payload data 解码为原始字节。
pub fn decode_bytes(data: &str) -> Result<Vec<u8>> {
    Ok(STANDARD.decode(data.as_bytes())?)
}

/// 写入一个 length-prefixed JSON frame。
pub fn write_frame<W: Write>(mut writer: W, msg: &FramedMessage) -> Result<()> {
    let payload = serde_json::to_vec(msg)?;
    if payload.len() > MAX_FRAME_LEN {
        anyhow::bail!("frame too large: {}", payload.len());
    }
    let len = payload.len() as u32;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

/// 读取一个 length-prefixed JSON frame；在 EOF 时返回 `Ok(None)`。
pub fn read_frame<R: Read>(mut reader: R) -> Result<Option<FramedMessage>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err.into()),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_LEN {
        anyhow::bail!("frame too large: {len}");
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    let msg: FramedMessage = serde_json::from_slice(&payload)?;
    Ok(Some(msg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn framed_round_trip() {
        let msg = FramedMessage {
            version: IPC_PROTOCOL_VERSION,
            message: Message::Output {
                payload: OutputPayload {
                    data_b64: encode_bytes(b"hello"),
                    stream: OutputStream::Stdout,
                },
            },
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &msg).expect("write");
        let decoded = read_frame(buf.as_slice()).expect("read").expect("some");
        assert_eq!(decoded.version, IPC_PROTOCOL_VERSION);
        match decoded.message {
            Message::Output { payload } => {
                assert_eq!(payload.stream, OutputStream::Stdout);
                let data = decode_bytes(&payload.data_b64).expect("decode");
                assert_eq!(data, b"hello");
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn spawn_request_serializes_permission_profile() {
        let workspace_roots = vec![
            AbsolutePathBuf::from_absolute_path(PathBuf::from(r"C:\workspace"))
                .expect("absolute workspace root"),
        ];
        let msg = FramedMessage {
            version: IPC_PROTOCOL_VERSION,
            message: Message::SpawnRequest {
                payload: Box::new(SpawnRequest {
                    command: vec!["cmd.exe".to_string(), "/c".to_string(), "ver".to_string()],
                    cwd: PathBuf::from(r"C:\workspace"),
                    env: HashMap::new(),
                    permission_profile: PermissionProfile::read_only(),
                    workspace_roots: workspace_roots.clone(),
                    codex_home: PathBuf::from(r"C:\codex"),
                    real_codex_home: PathBuf::from(r"C:\Users\codex"),
                    cap_sids: vec!["S-1-15-3-1024-1".to_string()],
                    timeout_ms: Some(1000),
                    tty: false,
                    stdin_open: false,
                    use_private_desktop: false,
                }),
            },
        };

        let encoded = serde_json::to_value(&msg).expect("serialize");
        assert_eq!("spawn_request", encoded["type"]);
        assert_eq!("managed", encoded["payload"]["permission_profile"]["type"]);
        assert_eq!(None, encoded["payload"].get("policy_json_or_preset"));
        assert_eq!(None, encoded["payload"].get("sandbox_policy_cwd"));
        assert_eq!(None, encoded["payload"].get("permission_profile_cwd"));

        let decoded: FramedMessage = serde_json::from_value(encoded).expect("deserialize");
        let Message::SpawnRequest { payload } = decoded.message else {
            panic!("unexpected message");
        };
        assert_eq!(PermissionProfile::read_only(), payload.permission_profile);
        assert_eq!(workspace_roots, payload.workspace_roots);
    }

    #[test]
    fn error_payload_serializes_stage_and_windows_error_code() {
        let msg = FramedMessage {
            version: IPC_PROTOCOL_VERSION,
            message: Message::Error {
                payload: ErrorPayload {
                    message: "CreateProcessAsUserW failed".to_string(),
                    stage: ErrorStage::SpawnChild,
                    windows_error_code: Some(1312),
                },
            },
        };

        let encoded = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(
            serde_json::json!({
                "version": IPC_PROTOCOL_VERSION,
                "type": "error",
                "payload": {
                    "message": "CreateProcessAsUserW failed",
                    "stage": "spawn_child",
                    "windows_error_code": 1312,
                }
            }),
            encoded
        );
    }
}

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use codex_file_system::FileSystemSandboxContext;
pub use codex_file_system::WalkOptions;
pub use codex_file_system::WalkOutcome;
use codex_network_proxy::ManagedNetworkSandboxContext;
use codex_protocol::config_types::ShellEnvironmentPolicyInherit;
use codex_shell_command::shell_detect::DetectedShell;
use codex_utils_path_uri::PathUri;
use serde::Deserialize;
use serde::Serialize;

use crate::ProcessId;

pub const INITIALIZE_METHOD: &str = "initialize";
pub const INITIALIZED_METHOD: &str = "initialized";
pub const EXEC_METHOD: &str = "process/start";
pub const EXEC_READ_METHOD: &str = "process/read";
pub const EXEC_WRITE_METHOD: &str = "process/write";
pub const EXEC_SIGNAL_METHOD: &str = "process/signal";
pub const EXEC_TERMINATE_METHOD: &str = "process/terminate";
pub const EXEC_OUTPUT_DELTA_METHOD: &str = "process/output";
pub const EXEC_EXITED_METHOD: &str = "process/exited";
pub const EXEC_CLOSED_METHOD: &str = "process/closed";
pub const ENVIRONMENT_INFO_METHOD: &str = "environment/info";
pub const FS_READ_FILE_METHOD: &str = "fs/readFile";
pub const FS_OPEN_METHOD: &str = "fs/open";
pub const FS_READ_BLOCK_METHOD: &str = "fs/readBlock";
pub const FS_CLOSE_METHOD: &str = "fs/close";
pub const FS_WRITE_FILE_METHOD: &str = "fs/writeFile";
pub const FS_CREATE_DIRECTORY_METHOD: &str = "fs/createDirectory";
pub const FS_GET_METADATA_METHOD: &str = "fs/getMetadata";
pub const FS_CANONICALIZE_METHOD: &str = "fs/canonicalize";
pub const FS_READ_DIRECTORY_METHOD: &str = "fs/readDirectory";
pub const FS_WALK_METHOD: &str = "fs/walk";
pub const FS_REMOVE_METHOD: &str = "fs/remove";
pub const FS_COPY_METHOD: &str = "fs/copy";
/// JSON-RPC request method for executor-side HTTP requests.
pub const HTTP_REQUEST_METHOD: &str = "http/request";
/// JSON-RPC notification method for streamed executor HTTP response bodies.
pub const HTTP_REQUEST_BODY_DELTA_METHOD: &str = "http/request/bodyDelta";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ByteChunk(#[serde(with = "base64_bytes")] pub Vec<u8>);

impl ByteChunk {
    pub fn into_inner(self) -> Vec<u8> {
        self.0
    }
}

impl From<Vec<u8>> for ByteChunk {
    fn from(value: Vec<u8>) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_name: String,
    #[serde(default)]
    pub resume_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub session_id: String,
}

/// 关于执行/文件系统环境的信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub shell: ShellInfo,
    /// exec-server 进程继承的工作目录。
    #[serde(default)]
    pub cwd: Option<PathUri>,
}

impl EnvironmentInfo {
    /// 返回当前本地 exec-server 进程的信息。
    pub fn local() -> Self {
        Self {
            shell: codex_shell_command::shell_detect::default_user_shell().into(),
            cwd: std::env::current_dir()
                .ok()
                .and_then(|cwd| PathUri::from_host_native_path(cwd).ok()),
        }
    }
}

/// 为执行/文件系统环境检测到的 shell。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// 稳定的 shell 名称，例如 `zsh`、`bash`、`powershell`、`sh` 或 `cmd`。
    pub name: String,
    /// 目标平台原生的 shell 可执行路径或命令名。诸如 `cmd.exe` 等回退值不必是绝对路径，
    /// 因此这不是 [`PathUri`]。
    pub path: String,
}

impl From<DetectedShell> for ShellInfo {
    fn from(shell: DetectedShell) -> Self {
        Self {
            name: shell.name().to_string(),
            path: shell.shell_path.to_string_lossy().into_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecParams {
    /// 客户端选择的逻辑进程 handle，作用域限定于本次 connection/session。
    /// 这是一个 protocol key，而非 OS pid。
    pub process_id: ProcessId,
    pub argv: Vec<String>,
    /// 工作目录 URI，在启动时按 exec-server 主机的路径规则进行解释。
    pub cwd: PathUri,
    #[serde(default)]
    pub env_policy: Option<ExecEnvPolicy>,
    pub env: HashMap<String, String>,
    pub tty: bool,
    /// 使非 tty stdin 可通过 `process/write` 写入。
    #[serde(default)]
    pub pipe_stdin: bool,
    /// 可选的进程可见 argv0 override。诸如 `codex-linux-sandbox` 等值是命令名而非路径，
    /// 因此这不是 [`PathUri`]。
    pub arg0: Option<String>,
    /// 可移植的 sandbox 意图。具体的 wrapper argv 由 exec-server 解析。
    #[serde(default)]
    pub sandbox: Option<FileSystemSandboxContext>,
    /// 最终 executor 侧 sandbox 是否必须强制托管网络。
    #[serde(default)]
    pub enforce_managed_network: bool,
    /// 在没有活动 proxy object 时用于强制托管网络的可选细节。
    ///
    /// 当 `enforce_managed_network` 为 true 且这些细节缺失时，executor 必须继续保持 fail closed
    /// （拒绝放行）。这保留了对旧客户端的兼容性。
    #[serde(default)]
    pub managed_network: Option<ManagedNetworkSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecEnvPolicy {
    pub inherit: ShellEnvironmentPolicyInherit,
    pub ignore_default_excludes: bool,
    pub exclude: Vec<String>,
    pub r#set: HashMap<String, String>,
    pub include_only: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResponse {
    pub process_id: ProcessId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadParams {
    pub process_id: ProcessId,
    pub after_seq: Option<u64>,
    pub max_bytes: Option<usize>,
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutputChunk {
    pub seq: u64,
    pub stream: ExecOutputStream,
    pub chunk: ByteChunk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponse {
    pub chunks: Vec<ProcessOutputChunk>,
    pub next_seq: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub closed: bool,
    pub failure: Option<String>,
    /// executor 是否将进程失败归类为 sandbox denial（拒绝）。
    #[serde(default)]
    pub sandbox_denied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    pub process_id: ProcessId,
    pub chunk: ByteChunk,
    pub write_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteStatus {
    Accepted,
    UnknownProcess,
    StdinClosed,
    Starting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResponse {
    pub status: WriteStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessSignal {
    Interrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalParams {
    pub process_id: ProcessId,
    pub signal: ProcessSignal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateParams {
    pub process_id: ProcessId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateResponse {
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadFileParams {
    pub path: PathUri,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadFileResponse {
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsOpenParams {
    pub handle_id: String,
    pub path: PathUri,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsOpenResponse {
    pub handle_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadBlockParams {
    pub handle_id: String,
    pub offset: u64,
    pub len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadBlockResponse {
    pub chunk: ByteChunk,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCloseParams {
    pub handle_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCloseResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteFileParams {
    pub path: PathUri,
    pub data_base64: String,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteFileResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateDirectoryParams {
    pub path: PathUri,
    pub recursive: Option<bool>,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCreateDirectoryResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsGetMetadataParams {
    pub path: PathUri,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsGetMetadataResponse {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCanonicalizeParams {
    pub path: PathUri,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCanonicalizeResponse {
    pub path: PathUri,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryParams {
    pub path: PathUri,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryEntry {
    pub file_name: String,
    pub is_directory: bool,
    pub is_file: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsReadDirectoryResponse {
    pub entries: Vec<FsReadDirectoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWalkParams {
    pub path: PathUri,
    pub options: WalkOptions,
    pub sandbox: Option<FileSystemSandboxContext>,
}

pub type FsWalkResponse = WalkOutcome;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRemoveParams {
    pub path: PathUri,
    pub recursive: Option<bool>,
    pub force: Option<bool>,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsRemoveResponse {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCopyParams {
    pub source_path: PathUri,
    pub destination_path: PathUri,
    pub recursive: bool,
    pub sandbox: Option<FileSystemSandboxContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCopyResponse {}

/// 在 executor protocol 中表示的 HTTP header。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    /// 在 HTTP wire 上出现的 header name。
    pub name: String,
    /// 经 UTF-8 转换后的 header value。
    pub value: String,
}

/// executor 侧 HTTP 请求的 redirect 行为。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HttpRedirectPolicy {
    /// 使用 HTTP client 的常规限制跟随 redirect。
    #[default]
    Follow,
    /// 返回 redirect response，不跟随其 location。
    Stop,
}

/// executor 侧 HTTP 请求 envelope。
///
/// 该结构有意保持 transport-shaped 而非 MCP-shaped，使调用方可用于 Streamable HTTP、
/// OAuth discovery 以及未来 executor 自有的 HTTP probe，而无需为每个更高层用途引入一个
/// 独立的 protocol method。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestParams {
    /// HTTP method，例如 `GET`、`POST` 或 `DELETE`。
    pub method: String,
    /// 绝对 `http://` 或 `https://` URL。
    pub url: String,
    /// ordered 的 request headers。重复的 header name 会被保留。
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
    /// 可选的 request body bytes。
    #[serde(default, rename = "bodyBase64")]
    pub body: Option<ByteChunk>,
    /// 请求超时时间，单位 milliseconds。
    ///
    /// 省略或 `null` 表示禁用超时。数值表示应用该精确 millisecond 截止时间。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// executor 是否应跟随 HTTP redirect。
    #[serde(default)]
    pub redirect_policy: HttpRedirectPolicy,
    /// 调用方选择的 stream id，用于 `http/request/bodyDelta` 通知。
    ///
    /// 该 id 在连接上必须保持唯一，直到 terminal body delta 到达，即使调用方提前停止读取
    /// stream 也是如此。buffered 请求仍会发送 id，使调用方可以保持一致的 request envelope
    /// shape。
    pub request_id: String,
    /// 在 response headers 返回后，以 delta 形式流式传输 response body。
    #[serde(default)]
    pub stream_response: bool,
}

/// executor `http/request` 调用返回的 HTTP response envelope。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestResponse {
    /// 数值型 HTTP response status code。
    pub status: u16,
    /// ordered 的 response headers。重复的 header name 会被保留。
    pub headers: Vec<HttpHeader>,
    /// buffered 的 response body bytes。当 `streamResponse` 为 true 时为空。
    #[serde(rename = "bodyBase64")]
    pub body: ByteChunk,
}

/// `streamResponse` HTTP 请求的 ordered response-body frame。
///
/// headers 在 `http/request` response 中一并返回，使调用方可以立即选择 parser；
/// body bytes 随后通过该 notification stream 到达。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestBodyDeltaNotification {
    /// 来自流式 `http/request` 调用的 request id。
    pub request_id: String,
    /// 单调递增的从 1 开始的 body frame 序列号。
    pub seq: u64,
    /// 该 frame 携带的 response-body bytes。
    #[serde(rename = "deltaBase64")]
    pub delta: ByteChunk,
    /// 标记 response-body EOF。此后该 request 不会再有 delta 到达。
    #[serde(default)]
    pub done: bool,
    /// terminal stream error。仅在最后一个 notification 上设置。
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecOutputStream {
    Stdout,
    Stderr,
    Pty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutputDeltaNotification {
    pub process_id: ProcessId,
    pub seq: u64,
    pub stream: ExecOutputStream,
    pub chunk: ByteChunk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecExitedNotification {
    pub process_id: ProcessId,
    pub seq: u64,
    pub exit_code: i32,
    #[serde(default)]
    pub sandbox_denied: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecClosedNotification {
    pub process_id: ProcessId,
    pub seq: u64,
}

mod base64_bytes {
    use super::BASE64_STANDARD;
    use base64::Engine as _;
    use serde::Deserialize;
    use serde::Deserializer;
    use serde::Serializer;

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&BASE64_STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        BASE64_STANDARD
            .decode(encoded)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::EnvironmentInfo;
    use super::ExecExitedNotification;
    use super::ExecParams;
    use super::FsReadFileParams;
    use super::HttpRequestParams;
    use super::ProcessId;
    use super::ShellInfo;
    use codex_file_system::FileSystemSandboxContext;
    use codex_network_proxy::ManagedNetworkSandboxContext;
    use codex_protocol::models::PermissionProfile;
    use codex_utils_path_uri::PathUri;
    use pretty_assertions::assert_eq;
    use std::collections::HashMap;

    #[test]
    fn exec_params_managed_network_context_round_trips_and_defaults_for_legacy_peers() {
        let cwd =
            PathUri::from_host_native_path(std::env::current_dir().expect("current directory"))
                .expect("cwd URI");
        let params = ExecParams {
            process_id: ProcessId::from("managed-network"),
            argv: vec!["true".to_string()],
            cwd,
            env_policy: None,
            env: HashMap::new(),
            tty: false,
            pipe_stdin: false,
            arg0: None,
            sandbox: None,
            enforce_managed_network: true,
            managed_network: Some(ManagedNetworkSandboxContext {
                loopback_ports: vec![43123, 48081],
                allow_local_binding: false,
            }),
        };

        let mut serialized = serde_json::to_value(&params).expect("serialize exec params");
        assert_eq!(
            serialized["managedNetwork"],
            serde_json::json!({
                "loopbackPorts": [43123, 48081],
                "allowLocalBinding": false,
            })
        );
        let round_trip: ExecParams =
            serde_json::from_value(serialized.clone()).expect("deserialize exec params");
        assert_eq!(round_trip, params);

        serialized
            .as_object_mut()
            .expect("exec params object")
            .remove("managedNetwork");
        let legacy: ExecParams =
            serde_json::from_value(serialized).expect("deserialize legacy exec params");
        assert!(legacy.enforce_managed_network);
        assert_eq!(legacy.managed_network, None);
    }

    #[test]
    fn environment_info_accepts_legacy_response_without_cwd() {
        let info: EnvironmentInfo = serde_json::from_value(serde_json::json!({
            "shell": { "name": "zsh", "path": "/bin/zsh" }
        }))
        .expect("legacy environment info should deserialize");

        assert_eq!(
            info,
            EnvironmentInfo {
                shell: ShellInfo {
                    name: "zsh".to_string(),
                    path: "/bin/zsh".to_string(),
                },
                cwd: None,
            }
        );
    }

    #[test]
    fn filesystem_protocol_rejects_native_absolute_paths() {
        let native_path = std::env::current_dir()
            .expect("current directory")
            .join("native-file.txt");
        let native_cwd = std::env::current_dir().expect("current directory");

        serde_json::from_value::<FsReadFileParams>(serde_json::json!({
            "path": native_path.to_string_lossy(),
            "sandbox": null,
        }))
        .expect_err("native absolute path should not deserialize as a URI");

        let sandbox = FileSystemSandboxContext::from_permission_profile_with_cwd(
            PermissionProfile::default(),
            PathUri::from_host_native_path(&native_cwd).expect("cwd URI"),
        );
        let mut native_path_sandbox =
            serde_json::to_value(sandbox).expect("sandbox should serialize");
        native_path_sandbox["cwd"] = serde_json::json!(native_cwd.to_string_lossy());

        serde_json::from_value::<FsReadFileParams>(serde_json::json!({
            "path": PathUri::from_host_native_path(native_path)
                .expect("path URI")
                .to_string(),
            "sandbox": native_path_sandbox,
        }))
        .expect_err("native absolute sandbox cwd should not deserialize as a URI");
    }

    #[test]
    fn http_request_timeout_treats_omitted_and_null_as_no_timeout() {
        let omitted: HttpRequestParams = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "url": "https://example.test",
            "requestId": "req-omitted-timeout",
        }))
        .expect("omitted timeout should deserialize");
        let null_timeout: HttpRequestParams = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "url": "https://example.test",
            "requestId": "req-null-timeout",
            "timeoutMs": null,
        }))
        .expect("null timeout should deserialize");
        let explicit_timeout: HttpRequestParams = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "url": "https://example.test",
            "requestId": "req-explicit-timeout",
            "timeoutMs": 1234,
        }))
        .expect("numeric timeout should deserialize");

        assert_eq!(
            (omitted.request_id.as_str(), omitted.timeout_ms),
            ("req-omitted-timeout", None)
        );
        assert_eq!(
            (null_timeout.request_id.as_str(), null_timeout.timeout_ms),
            ("req-null-timeout", None)
        );
        assert_eq!(
            (
                explicit_timeout.request_id.as_str(),
                explicit_timeout.timeout_ms
            ),
            ("req-explicit-timeout", Some(1234))
        );
    }

    #[test]
    fn exited_notification_accepts_legacy_payload_without_sandbox_denied() {
        let notification: ExecExitedNotification = serde_json::from_value(serde_json::json!({
            "processId": "proc-1",
            "seq": 3,
            "exitCode": 1,
        }))
        .expect("legacy exited notification should deserialize");

        assert_eq!(notification.sandbox_denied, None);
    }
}

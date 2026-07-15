//! 执行服务器（exec-server）核心模块。
//!
//! 本 crate 实现了 codex 的远程执行服务器协议，提供在隔离环境中执行
//! 进程、文件系统操作与 HTTP 请求的能力。支持本地与远程两种环境模式，
//! 远程模式通过 Noise 协议进行加密通信。
//!
//! 主要能力：
//! - 进程启动、信号控制与输出流式传输
//! - 文件系统读写、遍历、复制、删除等操作
//! - HTTP 请求代理（支持重定向策略与流式响应）
//! - 环境注册表（environment registry）管理
//! - Noise 通道加密与中继（relay）
//! - 沙箱化文件系统与进程隔离

// ========== 子模块声明 ==========

mod client;
mod client_api;
mod client_transport;
mod connection;
mod environment;
mod environment_provider;
mod environment_registry;
mod environment_toml;
mod file_read;
mod fs_helper;
mod fs_helper_main;
mod fs_sandbox;
mod local_file_system;
mod local_process;
mod noise_channel;
mod noise_relay;
mod process;
mod process_sandbox;
mod regular_file;
mod relay;
mod relay_proto;
mod remote;
mod remote_file_system;
mod remote_process;
mod resolved_capability;
mod rpc;
mod runtime_paths;
mod sandboxed_file_system;
mod server;
mod telemetry;
mod trace_context;

use codex_exec_server_protocol as protocol;

// ========== 客户端 ==========

/// 执行服务器客户端，提供连接远程服务器并调用其能力的统一入口。
pub use client::ExecServerClient;
/// 执行服务器客户端错误。
pub use client::ExecServerError;
/// HTTP 响应体流，用于流式读取 HTTP 响应。
pub use client::http_client::HttpResponseBodyStream;
/// 基于 reqwest 的 HTTP 客户端实现。
pub use client::http_client::ReqwestHttpClient;

// ========== 客户端 API ==========

/// 执行服务器客户端连接选项。
pub use client_api::ExecServerClientConnectOptions;
/// HTTP 客户端 trait，抽象 HTTP 请求行为。
pub use client_api::HttpClient;
/// Noise 会合（rendezvous）连接参数。
pub use client_api::NoiseRendezvousConnectArgs;
/// Noise 会合连接 bundle，打包连接所需信息。
pub use client_api::NoiseRendezvousConnectBundle;
/// Noise 会合连接提供者 trait。
pub use client_api::NoiseRendezvousConnectProvider;
/// 远程执行服务器连接参数。
pub use client_api::RemoteExecServerConnectArgs;

// ========== 协议类型重导出 ==========

/// 进程 ID。
pub use codex_exec_server_protocol::ProcessId;

/// 执行环境变量策略（用于 exec 命令的 env 字段过滤）。
// 补充 re-export：rmcp-client 等下游 crate 需要通过 codex_exec_server 访问 ExecEnvPolicy，
// 与 ProcessId 的 re-export 模式一致。
pub use codex_exec_server_protocol::ExecEnvPolicy;

// ========== 文件系统类型重导出 ==========

/// 文件复制选项。
pub use codex_file_system::CopyOptions;
/// 创建目录选项。
pub use codex_file_system::CreateDirectoryOptions;
/// 执行器文件系统 trait，抽象文件系统操作。
pub use codex_file_system::ExecutorFileSystem;
/// 执行器文件系统 future 类型。
pub use codex_file_system::ExecutorFileSystemFuture;
/// 文件读取的块大小常量。
pub use codex_file_system::FILE_READ_CHUNK_SIZE;
/// 文件元数据。
pub use codex_file_system::FileMetadata;
/// 文件系统读取流。
pub use codex_file_system::FileSystemReadStream;
/// 文件系统操作结果类型。
pub use codex_file_system::FileSystemResult;
/// 文件系统沙箱上下文。
pub use codex_file_system::FileSystemSandboxContext;
/// 读取目录条目。
pub use codex_file_system::ReadDirectoryEntry;
/// 文件移除选项。
pub use codex_file_system::RemoveOptions;
/// 遍历条目。
pub use codex_file_system::WalkEntry;
/// 遍历条目类型（文件或目录）。
pub use codex_file_system::WalkEntryKind;
/// 遍历错误。
pub use codex_file_system::WalkError;
/// 遍历选项。
pub use codex_file_system::WalkOptions;
/// 遍历结果。
pub use codex_file_system::WalkOutcome;

// ========== 环境变量常量 ==========

/// Noise 鉴权 token 的环境变量名。
pub use environment::CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN_ENV_VAR;
/// Noise ChatGPT 账户 ID 的环境变量名。
pub use environment::CODEX_EXEC_SERVER_NOISE_CHATGPT_ACCOUNT_ID_ENV_VAR;
/// Noise 环境 ID 的环境变量名。
pub use environment::CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID_ENV_VAR;
/// Noise 注册表 URL 的环境变量名。
pub use environment::CODEX_EXEC_SERVER_NOISE_REGISTRY_URL_ENV_VAR;
/// 执行服务器 URL 的环境变量名。
pub use environment::CODEX_EXEC_SERVER_URL_ENV_VAR;

// ========== 环境类型 ==========

/// 执行环境，描述一个可执行进程的隔离环境。
pub use environment::Environment;
/// 环境管理器，维护多个执行环境的生命周期。
pub use environment::EnvironmentManager;
/// 本地环境标识。
pub use environment::LOCAL_ENVIRONMENT_ID;
/// 远程环境标识。
pub use environment::REMOTE_ENVIRONMENT_ID;

// ========== 环境提供者 ==========

/// 默认环境提供者实现。
pub use environment_provider::DefaultEnvironmentProvider;
/// 环境提供者 trait，抽象环境发现与选择逻辑。
pub use environment_provider::EnvironmentProvider;
/// 环境提供者 future 类型。
pub use environment_provider::EnvironmentProviderFuture;

// ========== 环境注册表 ==========

/// 环境注册表连接请求。
pub use environment_registry::EnvironmentRegistryConnectRequest;
/// 环境注册表连接响应。
pub use environment_registry::EnvironmentRegistryConnectResponse;
/// 环境注册表 harness key 校验请求。
pub use environment_registry::EnvironmentRegistryHarnessKeyValidationRequest;
/// 环境注册表 harness key 校验响应。
pub use environment_registry::EnvironmentRegistryHarnessKeyValidationResponse;
/// 环境注册表注册请求。
pub use environment_registry::EnvironmentRegistryRegistrationRequest;
/// 环境注册表注册响应。
pub use environment_registry::EnvironmentRegistryRegistrationResponse;

// ========== FS Helper ==========

/// FS Helper 程序的第一个位置参数常量。
pub use fs_helper::CODEX_FS_HELPER_ARG1;
/// FS Helper 程序的 main 入口。
pub use fs_helper_main::main as run_fs_helper_main;

// ========== 本地文件系统 ==========

/// 本地文件系统单例。
pub use local_file_system::LOCAL_FS;
/// 本地文件系统实现。
pub use local_file_system::LocalFileSystem;

// ========== Noise 通道 ==========

/// Noise 通道错误。
pub use noise_channel::NoiseChannelError;
/// Noise 通道身份标识。
pub use noise_channel::NoiseChannelIdentity;
/// Noise 通道公钥。
pub use noise_channel::NoiseChannelPublicKey;

// ========== 进程类型 ==========

/// 执行后端，描述进程在何种环境中执行。
pub use process::ExecBackend;
/// 执行后端 future 类型。
pub use process::ExecBackendFuture;
/// 执行进程句柄，代表一个已启动的进程。
pub use process::ExecProcess;
/// 执行进程事件，如输出增量、退出等。
pub use process::ExecProcessEvent;
/// 执行进程事件接收器。
pub use process::ExecProcessEventReceiver;
/// 执行进程 future 类型。
pub use process::ExecProcessFuture;
/// 已启动的执行进程，包含进程 ID 与初始信息。
pub use process::StartedExecProcess;

// ========== 协议类型重导出 ==========

/// 字节块，用于流式传输二进制数据。
pub use protocol::ByteChunk;
/// 环境信息。
pub use protocol::EnvironmentInfo;
/// 进程关闭通知。
pub use protocol::ExecClosedNotification;
/// 进程退出通知。
pub use protocol::ExecExitedNotification;
/// 进程输出增量通知。
pub use protocol::ExecOutputDeltaNotification;
/// 进程输出流标识（stdout/stderr）。
pub use protocol::ExecOutputStream;
/// 进程执行参数。
pub use protocol::ExecParams;
/// 进程执行响应。
pub use protocol::ExecResponse;
/// 文件系统规范化（canonicalize）参数。
pub use protocol::FsCanonicalizeParams;
/// 文件系统规范化响应。
pub use protocol::FsCanonicalizeResponse;
/// 文件系统关闭参数。
pub use protocol::FsCloseParams;
/// 文件系统关闭响应。
pub use protocol::FsCloseResponse;
/// 文件系统复制参数。
pub use protocol::FsCopyParams;
/// 文件系统复制响应。
pub use protocol::FsCopyResponse;
/// 文件系统创建目录参数。
pub use protocol::FsCreateDirectoryParams;
/// 文件系统创建目录响应。
pub use protocol::FsCreateDirectoryResponse;
/// 文件系统获取元数据参数。
pub use protocol::FsGetMetadataParams;
/// 文件系统获取元数据响应。
pub use protocol::FsGetMetadataResponse;
/// 文件系统打开参数。
pub use protocol::FsOpenParams;
/// 文件系统打开响应。
pub use protocol::FsOpenResponse;
/// 文件系统读取块参数。
pub use protocol::FsReadBlockParams;
/// 文件系统读取块响应。
pub use protocol::FsReadBlockResponse;
/// 文件系统读取目录条目。
pub use protocol::FsReadDirectoryEntry;
/// 文件系统读取目录参数。
pub use protocol::FsReadDirectoryParams;
/// 文件系统读取目录响应。
pub use protocol::FsReadDirectoryResponse;
/// 文件系统读取文件参数。
pub use protocol::FsReadFileParams;
/// 文件系统读取文件响应。
pub use protocol::FsReadFileResponse;
/// 文件系统移除参数。
pub use protocol::FsRemoveParams;
/// 文件系统移除响应。
pub use protocol::FsRemoveResponse;
/// 文件系统遍历参数。
pub use protocol::FsWalkParams;
/// 文件系统遍历响应。
pub use protocol::FsWalkResponse;
/// 文件系统写入文件参数。
pub use protocol::FsWriteFileParams;
/// 文件系统写入文件响应。
pub use protocol::FsWriteFileResponse;
/// HTTP 头。
pub use protocol::HttpHeader;
/// HTTP 重定向策略。
pub use protocol::HttpRedirectPolicy;
/// HTTP 请求体增量通知。
pub use protocol::HttpRequestBodyDeltaNotification;
/// HTTP 请求参数。
pub use protocol::HttpRequestParams;
/// HTTP 请求响应。
pub use protocol::HttpRequestResponse;
/// 初始化参数，客户端连接时发送的握手信息。
pub use protocol::InitializeParams;
/// 初始化响应，服务器返回的能力信息。
pub use protocol::InitializeResponse;
/// 进程输出块。
pub use protocol::ProcessOutputChunk;
/// 进程信号。
pub use protocol::ProcessSignal;
/// 读取参数。
pub use protocol::ReadParams;
/// 读取响应。
pub use protocol::ReadResponse;
/// Shell 信息。
pub use protocol::ShellInfo;
/// 信号发送参数。
pub use protocol::SignalParams;
/// 信号发送响应。
pub use protocol::SignalResponse;
/// 进程终止参数。
pub use protocol::TerminateParams;
/// 进程终止响应。
pub use protocol::TerminateResponse;
/// 写入参数。
pub use protocol::WriteParams;
/// 写入响应。
pub use protocol::WriteResponse;
/// 写入状态。
pub use protocol::WriteStatus;

// ========== 远程环境 ==========

/// 远程环境配置。
pub use remote::RemoteEnvironmentConfig;
/// 运行远程环境的主入口。
pub use remote::run_remote_environment;

// ========== 能力解析 ==========

/// 已解析的选中能力根，描述客户端可使用的能力集合。
pub use resolved_capability::ResolvedSelectedCapabilityRoot;

// ========== 运行时路径 ==========

/// 执行服务器运行时路径，管理配置文件与数据目录。
pub use runtime_paths::ExecServerRuntimePaths;

// ========== 服务器入口 ==========

/// 默认监听 URL。
pub use server::DEFAULT_LISTEN_URL;
/// 监听 URL 解析错误。
pub use server::ExecServerListenUrlParseError;
/// 服务器 main 入口。
pub use server::run_main;
/// 带遥测的 main 入口。
pub use server::run_main_with_telemetry;

// ========== 遥测 ==========

/// 执行服务器遥测，记录运行指标与事件。
pub use telemetry::ExecServerTelemetry;

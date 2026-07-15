use crate::message_processor::ConnectionSessionState;
use crate::outgoing_message::OutgoingEnvelope;
use codex_app_server_protocol::ExperimentalApi;
use codex_app_server_protocol::ServerRequest;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

pub use codex_app_server_transport::AppServerTransport;
pub(crate) use codex_app_server_transport::CHANNEL_CAPACITY;
pub(crate) use codex_app_server_transport::ConnectionId;
pub(crate) use codex_app_server_transport::ConnectionOrigin;
pub(crate) use codex_app_server_transport::OutgoingMessage;
pub(crate) use codex_app_server_transport::QueuedOutgoingMessage;
pub(crate) use codex_app_server_transport::RemoteControlEnableError;
pub(crate) use codex_app_server_transport::RemoteControlHandle;
pub(crate) use codex_app_server_transport::RemoteControlPolicy;
pub(crate) use codex_app_server_transport::RemoteControlStartConfig;
pub use codex_app_server_transport::RemoteControlStartupMode;
pub(crate) use codex_app_server_transport::RemoteControlUnavailable;
pub(crate) use codex_app_server_transport::TransportEvent;
pub(crate) use codex_app_server_transport::acquire_app_server_startup_lock;
pub use codex_app_server_transport::app_server_control_socket_path;
pub(crate) use codex_app_server_transport::app_server_startup_lock_path;
pub use codex_app_server_transport::auth;
pub(crate) use codex_app_server_transport::prepare_control_socket_path;
pub(crate) use codex_app_server_transport::start_control_socket_acceptor;
pub(crate) use codex_app_server_transport::start_remote_control;
pub(crate) use codex_app_server_transport::start_stdio_connection;
pub(crate) use codex_app_server_transport::start_websocket_acceptor;
pub use codex_app_server_transport::take_remote_control_disabled_env;

/// processor 主循环侧持有的连接状态。
///
/// 与 outbound 路由侧的 [`OutboundConnectionState`] 通过共享的 `Arc<AtomicBool>` /
/// `Arc<RwLock<...>>` 协同，避免直接共享可变状态。
pub(crate) struct ConnectionState {
    /// outbound 侧同步的"连接是否已 initialize"标志。
    pub(crate) outbound_initialized: Arc<AtomicBool>,
    /// outbound 侧同步的"连接是否启用 experimental API"标志。
    pub(crate) outbound_experimental_api_enabled: Arc<AtomicBool>,
    /// outbound 侧同步的"连接已 opt-out 的通知方法集合"。
    pub(crate) outbound_opted_out_notification_methods: Arc<RwLock<HashSet<String>>>,
    /// 该连接的会话状态（initialize、experimental API、opt-out 等）。
    pub(crate) session: Arc<ConnectionSessionState>,
}

impl ConnectionState {
    /// 创建一个新的 `ConnectionState`，同时初始化对应的 session 状态。
    pub(crate) fn new(
        _origin: ConnectionOrigin,
        outbound_initialized: Arc<AtomicBool>,
        outbound_experimental_api_enabled: Arc<AtomicBool>,
        outbound_opted_out_notification_methods: Arc<RwLock<HashSet<String>>>,
    ) -> Self {
        Self {
            outbound_initialized,
            outbound_experimental_api_enabled,
            outbound_opted_out_notification_methods,
            session: Arc::new(ConnectionSessionState::new()),
        }
    }
}

/// outbound 路由侧持有的连接状态。
///
/// 持有向该连接写入消息的 mpsc sender，以及共享的初始化/实验性 API/opt-out 标志。
/// 当连接过慢或被关闭时，通过 `disconnect_sender` 触发断开。
pub(crate) struct OutboundConnectionState {
    /// 连接是否已 initialize。
    pub(crate) initialized: Arc<AtomicBool>,
    /// 连接是否启用 experimental API。
    pub(crate) experimental_api_enabled: Arc<AtomicBool>,
    /// 连接已 opt-out 的通知方法集合。
    pub(crate) opted_out_notification_methods: Arc<RwLock<HashSet<String>>>,
    /// 向该连接写入消息的 mpsc sender。
    pub(crate) writer: mpsc::Sender<QueuedOutgoingMessage>,
    /// 可选的断开连接 token；`None` 表示该连接无法主动断开（例如 stdio）。
    disconnect_sender: Option<CancellationToken>,
}

impl OutboundConnectionState {
    /// 创建一个新的 `OutboundConnectionState`。
    pub(crate) fn new(
        writer: mpsc::Sender<QueuedOutgoingMessage>,
        initialized: Arc<AtomicBool>,
        experimental_api_enabled: Arc<AtomicBool>,
        opted_out_notification_methods: Arc<RwLock<HashSet<String>>>,
        disconnect_sender: Option<CancellationToken>,
    ) -> Self {
        Self {
            initialized,
            experimental_api_enabled,
            opted_out_notification_methods,
            writer,
            disconnect_sender,
        }
    }

    /// 该连接是否支持主动断开（即 `disconnect_sender` 为 `Some`）。
    fn can_disconnect(&self) -> bool {
        self.disconnect_sender.is_some()
    }

    /// 请求断开该连接。
    ///
    /// 若 `disconnect_sender` 为 `Some`，则触发 `CancellationToken::cancel()`；
    /// 否则为 no-op。
    pub(crate) fn request_disconnect(&self) {
        if let Some(disconnect_sender) = &self.disconnect_sender {
            disconnect_sender.cancel();
        }
    }
}

/// 判断给定消息是否应当对指定连接跳过（不下发）。
///
/// 跳过条件：
/// 1. 消息是 experimental notification 且连接未启用 experimental API。
/// 2. 消息方法名在连接的 opt-out 列表中。
///
/// 非 notification 消息（请求/响应）永不跳过。
fn should_skip_notification_for_connection(
    connection_state: &OutboundConnectionState,
    message: &OutgoingMessage,
) -> bool {
    let Ok(opted_out_notification_methods) = connection_state.opted_out_notification_methods.read()
    else {
        warn!("failed to read outbound opted-out notifications");
        return false;
    };
    match message {
        OutgoingMessage::AppServerNotification(notification) => {
            if notification.experimental_reason().is_some()
                && !connection_state
                    .experimental_api_enabled
                    .load(Ordering::Acquire)
            {
                return true;
            }
            let method = notification.to_string();
            opted_out_notification_methods.contains(method.as_str())
        }
        _ => false,
    }
}

/// 从连接表中移除并主动断开指定连接。
///
/// # 返回值
///
/// 当连接存在并已触发断开时返回 `true`；连接不存在返回 `false`。
fn disconnect_connection(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    connection_id: ConnectionId,
) -> bool {
    if let Some(connection_state) = connections.remove(&connection_id) {
        connection_state.request_disconnect();
        return true;
    }
    false
}

/// 向指定连接发送一条消息。
///
/// 先经过 [`filter_outgoing_message_for_connection`] 过滤，再判断是否应跳过
/// （experimental / opt-out）。对支持主动断开的连接使用 `try_send`，队列满时
/// 直接断开慢连接；对不支持主动断开的连接（如 stdio）使用 `send().await` 阻塞。
///
/// # 参数
///
/// - `connections`: 当前所有连接的状态表
/// - `connection_id`: 目标连接 ID
/// - `message`: 待发送消息
/// - `write_complete_tx`: 可选的"写入完成"通知 oneshot sender
///
/// # 返回值
///
/// 返回 `true` 表示因发送失败/队列满而断开了该连接；`false` 表示发送成功或
/// 连接不存在。
async fn send_message_to_connection(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    connection_id: ConnectionId,
    message: OutgoingMessage,
    write_complete_tx: Option<tokio::sync::oneshot::Sender<()>>,
) -> bool {
    let Some(connection_state) = connections.get(&connection_id) else {
        warn!("dropping message for disconnected connection: {connection_id:?}");
        return false;
    };
    let message = filter_outgoing_message_for_connection(connection_state, message);
    if should_skip_notification_for_connection(connection_state, &message) {
        return false;
    }

    let writer = connection_state.writer.clone();
    let queued_message = QueuedOutgoingMessage {
        message,
        write_complete_tx,
    };
    if connection_state.can_disconnect() {
        // 可主动断开的连接：使用 try_send，队列满时立即断开慢连接。
        match writer.try_send(queued_message) {
            Ok(()) => false,
            Err(mpsc::error::TrySendError::Full(_)) => {
                warn!(
                    "disconnecting slow connection after outbound queue filled: {connection_id:?}"
                );
                disconnect_connection(connections, connection_id)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                disconnect_connection(connections, connection_id)
            }
        }
    } else if writer.send(queued_message).await.is_err() {
        // 不可主动断开的连接（stdio）：阻塞 send，出错时仅移除状态。
        disconnect_connection(connections, connection_id)
    } else {
        false
    }
}

/// 针对连接的 experimental API 启用状态过滤出站消息。
///
/// 当前仅对 `CommandExecutionRequestApproval` 请求生效：若连接未启用
/// experimental API，则剥离其 experimental 字段。其他消息原样返回。
fn filter_outgoing_message_for_connection(
    connection_state: &OutboundConnectionState,
    message: OutgoingMessage,
) -> OutgoingMessage {
    let experimental_api_enabled = connection_state
        .experimental_api_enabled
        .load(Ordering::Acquire);
    match message {
        OutgoingMessage::Request(ServerRequest::CommandExecutionRequestApproval {
            request_id,
            mut params,
        }) => {
            if !experimental_api_enabled {
                params.strip_experimental_fields();
            }
            OutgoingMessage::Request(ServerRequest::CommandExecutionRequestApproval {
                request_id,
                params,
            })
        }
        _ => message,
    }
}

/// outbound 路由任务的核心：根据 envelope 类型将消息投递到目标连接。
///
/// 支持两种投递模式：
/// - `ToConnection`：定向投递到单个连接。
/// - `Broadcast`：广播到所有已 initialize 且不跳过的连接。
///
/// 广播时会先快照目标连接列表，再逐个发送，避免在发送过程中修改连接表。
pub(crate) async fn route_outgoing_envelope(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    envelope: OutgoingEnvelope,
) {
    match envelope {
        OutgoingEnvelope::ToConnection {
            connection_id,
            message,
            write_complete_tx,
        } => {
            let _ =
                send_message_to_connection(connections, connection_id, message, write_complete_tx)
                    .await;
        }
        OutgoingEnvelope::Broadcast { message } => {
            // 先快照目标连接列表，避免在发送过程中修改 connections 表。
            let target_connections: Vec<ConnectionId> = connections
                .iter()
                .filter_map(|(connection_id, connection_state)| {
                    if connection_state.initialized.load(Ordering::Acquire)
                        && !should_skip_notification_for_connection(connection_state, &message)
                    {
                        Some(*connection_id)
                    } else {
                        None
                    }
                })
                .collect();

            for connection_id in target_connections {
                let _ = send_message_to_connection(
                    connections,
                    connection_id,
                    message.clone(),
                    /*write_complete_tx*/ None,
                )
                .await;
            }
        }
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;

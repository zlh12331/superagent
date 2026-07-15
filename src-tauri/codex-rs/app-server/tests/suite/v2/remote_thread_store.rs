//! 针对基于 non-local `ThreadStore` 的 app-server thread 操作的回归测试覆盖。
//!
//! app-server 的启动路径应当尊重 `experimental_thread_store` 配置，将所有
//! thread 持久化路由到所配置的 store。本套件使用 thread-store crate 中
//! 仅用于测试的内存 store 来触发 non-local 配置驱动选择路径，而不触碰本地
//! rollout 或 sqlite 存储。
//!
//! 重要的失败模式是：在配置了 non-local store 的情况下意外地产生了本地持久化。
//! 在执行 `thread/start` 和一次简单 turn 之后，临时的 `codex_home` 目录中
//! 不应出现 rollout session 文件或 sqlite 状态文件。本检查并不会观测那些不
//! 留下任何产物的只读探测，它只是一个临时兜底，目的是防止额外的本地持久化写入
//! 悄然混入而被忽略。

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use app_test_support::create_mock_responses_server_repeating_assistant;
use codex_app_server::in_process;
use codex_app_server::in_process::InProcessClientHandle;
use codex_app_server::in_process::InProcessServerEvent;
use codex_app_server::in_process::InProcessStartArgs;
use codex_app_server_protocol::ClientInfo;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::InitializeParams;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadDeleteParams;
use codex_app_server_protocol::ThreadDeleteResponse;
use codex_app_server_protocol::ThreadListParams;
use codex_app_server_protocol::ThreadListResponse;
use codex_app_server_protocol::ThreadResumeParams;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::UserInput as V2UserInput;
use codex_arg0::Arg0DispatchPaths;
use codex_config::CloudConfigBundleLoader;
use codex_config::LoaderOverrides;
use codex_config::NoopThreadConfigLoader;
use codex_core::config::Config;
use codex_core::config::ConfigBuilder;
use codex_exec_server::EnvironmentManager;
use codex_feedback::CodexFeedback;
use codex_protocol::ThreadId;
use codex_protocol::models::BaseInstructions;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::ThreadMemoryMode;
use codex_thread_store::CreateThreadParams as StoreCreateThreadParams;
use codex_thread_store::InMemoryThreadStore;
use codex_thread_store::ThreadPersistenceMetadata;
use codex_thread_store::ThreadStore;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[tokio::test]
async fn thread_delete_with_non_local_thread_store_does_not_create_local_persistence() -> Result<()>
{
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    let store_id = Uuid::new_v4().to_string();
    // plugin 启动预热可能会在 codex_home 下创建 `.tmp` 文件。这里禁用预热，
    // 使本回归测试专注于 thread 持久化产物。
    create_config_toml_with_thread_store(codex_home.path(), &server.uri(), &store_id)?;

    let thread_store = InMemoryThreadStore::for_id(store_id.clone());
    let _in_memory_store = InMemoryThreadStoreId { store_id };

    let mut client = start_in_process_server(codex_home.path()).await?;

    let response = client
        .request(ClientRequest::ThreadStart {
            request_id: RequestId::Integer(1),
            params: ThreadStartParams::default(),
        })
        .await?
        .expect("thread/start should succeed");
    let ThreadStartResponse { thread, .. } =
        serde_json::from_value(response).expect("thread/start response should parse");
    assert_eq!(thread.path, None);

    client
        .request(ClientRequest::TurnStart {
            request_id: RequestId::Integer(2),
            params: TurnStartParams {
                thread_id: thread.id.clone(),
                client_user_message_id: None,
                input: vec![V2UserInput::Text {
                    text: "Hello".to_string(),
                    text_elements: Vec::new(),
                }],
                ..Default::default()
            },
        })
        .await?
        .expect("turn/start should succeed");

    timeout(DEFAULT_READ_TIMEOUT, async {
        loop {
            let Some(event) = client.next_event().await else {
                anyhow::bail!("in-process app-server stopped before turn/completed");
            };
            if let InProcessServerEvent::ServerNotification(ServerNotification::TurnCompleted(
                completed,
            )) = event
                && completed.thread_id == thread.id
            {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await??;

    let response = client
        .request(ClientRequest::ThreadList {
            request_id: RequestId::Integer(3),
            params: ThreadListParams {
                cursor: None,
                limit: Some(10),
                sort_key: None,
                sort_direction: None,
                model_providers: Some(Vec::new()),
                source_kinds: None,
                archived: None,
                cwd: None,
                use_state_db_only: false,
                search_term: None,
                parent_thread_id: None,
                ancestor_thread_id: None,
            },
        })
        .await?
        .expect("thread/list should succeed");
    let ThreadListResponse { data, .. } =
        serde_json::from_value(response).expect("thread/list response should parse");
    assert_eq!(data.len(), 1);
    assert_eq!(data[0].id, thread.id);
    assert_eq!(data[0].path, None);

    delete_thread(&client, /*request_id*/ 4, thread.id.clone()).await?;
    let unloaded_thread_id = ThreadId::from_string(&Uuid::new_v4().to_string())?;
    thread_store
        .create_thread(StoreCreateThreadParams {
            session_id: unloaded_thread_id.into(),
            thread_id: unloaded_thread_id,
            extra_config: None,
            forked_from_id: None,
            parent_thread_id: None,
            source: SessionSource::Cli,
            thread_source: None,
            originator: "test_originator".to_string(),
            base_instructions: BaseInstructions::default(),
            dynamic_tools: Vec::new(),
            selected_capability_roots: Vec::new(),
            multi_agent_version: None,
            history_mode: Default::default(),
            initial_window_id: Uuid::now_v7().to_string(),
            metadata: ThreadPersistenceMetadata {
                cwd: Some(codex_home.path().to_path_buf()),
                model_provider: "mock_provider".to_string(),
                memory_mode: ThreadMemoryMode::Enabled,
            },
        })
        .await?;
    delete_thread(
        &client,
        /*request_id*/ 5,
        unloaded_thread_id.to_string(),
    )
    .await?;

    client.shutdown().await?;

    let calls = thread_store.calls().await;
    assert_eq!(calls.create_thread, 2);
    assert_eq!(calls.list_threads, 1);
    assert_eq!(calls.delete_thread, 2);
    assert!(
        calls.append_items > 0,
        "turn/start should append rollout items through the injected store"
    );
    assert!(
        calls.flush_thread > 0,
        "turn completion should flush through the injected store"
    );

    assert_no_local_persistence_artifacts(codex_home.path())?;

    Ok(())
}

#[tokio::test]
async fn cold_thread_resume_reuses_non_local_history_probe() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    let store_id = Uuid::new_v4().to_string();
    create_config_toml_with_thread_store(codex_home.path(), &server.uri(), &store_id)?;

    let loader_overrides = LoaderOverrides::without_managed_config_for_tests();
    let config = Arc::new(
        ConfigBuilder::default()
            .codex_home(codex_home.path().to_path_buf())
            .fallback_cwd(Some(codex_home.path().to_path_buf()))
            .loader_overrides(loader_overrides.clone())
            .build()
            .await?,
    );
    let thread_store = InMemoryThreadStore::for_id(store_id.clone());
    let _in_memory_store = InMemoryThreadStoreId { store_id };

    let mut client = start_in_process_client(config.clone(), loader_overrides.clone()).await?;
    let response = client
        .request(ClientRequest::ThreadStart {
            request_id: RequestId::Integer(1),
            params: ThreadStartParams::default(),
        })
        .await?
        .expect("thread/start should succeed");
    let ThreadStartResponse { thread, .. } = serde_json::from_value(response)?;

    client
        .request(ClientRequest::TurnStart {
            request_id: RequestId::Integer(2),
            params: TurnStartParams {
                thread_id: thread.id.clone(),
                client_user_message_id: None,
                input: vec![V2UserInput::Text {
                    text: "Materialize the thread".to_string(),
                    text_elements: Vec::new(),
                }],
                ..Default::default()
            },
        })
        .await?
        .expect("turn/start should succeed");
    timeout(DEFAULT_READ_TIMEOUT, async {
        loop {
            let Some(event) = client.next_event().await else {
                anyhow::bail!("in-process app-server stopped before turn/completed");
            };
            if let InProcessServerEvent::ServerNotification(ServerNotification::TurnCompleted(
                completed,
            )) = event
                && completed.thread_id == thread.id
            {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await??;
    client.shutdown().await?;

    let client = start_in_process_client(config, loader_overrides).await?;
    let reads_before_resume = thread_store.calls().await.read_thread_with_history;
    // 内存 store 没有 path 概念，因此 resume 在后续组装响应阶段会失败。但带
    // history 的探测路径仍需要被复用，以验证其不会写入本地。
    let _resume_result = client
        .request(ClientRequest::ThreadResume {
            request_id: RequestId::Integer(3),
            params: ThreadResumeParams {
                thread_id: thread.id.clone(),
                ..Default::default()
            },
        })
        .await?;

    assert_eq!(
        thread_store.calls().await.read_thread_with_history,
        reads_before_resume + 1
    );

    client.shutdown().await?;
    Ok(())
}

async fn start_in_process_server(codex_home: &Path) -> Result<InProcessClientHandle> {
    let loader_overrides = LoaderOverrides::without_managed_config_for_tests();
    let config = Arc::new(
        ConfigBuilder::default()
            .codex_home(codex_home.to_path_buf())
            .fallback_cwd(Some(codex_home.to_path_buf()))
            .loader_overrides(loader_overrides.clone())
            .build()
            .await?,
    );

    Ok(start_in_process_client(config, loader_overrides).await?)
}

async fn start_in_process_client(
    config: Arc<Config>,
    loader_overrides: LoaderOverrides,
) -> std::io::Result<InProcessClientHandle> {
    in_process::start(InProcessStartArgs {
        arg0_paths: Arg0DispatchPaths::default(),
        config,
        cli_overrides: Vec::new(),
        loader_overrides,
        strict_config: false,
        cloud_config_bundle: CloudConfigBundleLoader::default(),
        thread_config_loader: Arc::new(NoopThreadConfigLoader),
        feedback: CodexFeedback::new(),
        log_db: None,
        state_db: None,
        environment_manager: Arc::new(EnvironmentManager::default_for_tests()),
        config_warnings: Vec::new(),
        session_source: SessionSource::Cli,
        enable_codex_api_key_env: false,
        initialize: InitializeParams {
            client_info: ClientInfo {
                name: "codex-app-server-tests".to_string(),
                title: None,
                version: "0.1.0".to_string(),
            },
            capabilities: None,
        },
        channel_capacity: in_process::DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
    })
    .await
}

async fn delete_thread(
    client: &InProcessClientHandle,
    request_id: i64,
    thread_id: String,
) -> Result<()> {
    let response = client
        .request(ClientRequest::ThreadDelete {
            request_id: RequestId::Integer(request_id),
            params: ThreadDeleteParams { thread_id },
        })
        .await?
        .map_err(|error| anyhow::anyhow!("thread/delete failed: {}", error.message))?;
    let _: ThreadDeleteResponse = serde_json::from_value(response)?;
    Ok(())
}

fn assert_no_local_persistence_artifacts(codex_home: &Path) -> Result<()> {
    // 以下是用于检测意外本地持久化的可观测“绊线”。如果未来的某条代码路径
    // 构造了本地 rollout/session store，或打开了本地 thread sqlite 数据库，
    // 都会在隔离的测试 codex_home 中留下其中一种产物。
    assert!(
        !codex_home.join("sessions").exists(),
        "non-local thread persistence should not create local rollout sessions"
    );
    assert!(
        !codex_home.join("archived_sessions").exists(),
        "non-local thread persistence should not create archived rollout sessions"
    );
    assert!(
        !codex_state::state_db_path(codex_home).exists(),
        "non-local thread persistence should not create local thread sqlite"
    );

    let sqlite_artifacts = std::fs::read_dir(codex_home)?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.ends_with(".sqlite")
                        || name.ends_with(".sqlite-shm")
                        || name.ends_with(".sqlite-wal")
                })
        })
        .collect::<Vec<_>>();

    assert!(
        sqlite_artifacts.is_empty(),
        "non-local thread persistence should not create sqlite artifacts: {sqlite_artifacts:?}"
    );
    let mut entries = codex_home_entries(codex_home)?;
    // Bazel 测试运行可能会在 codex_home 下初始化 shell snapshot 存储。这不
    // 属于 thread 持久化范畴，因此将断言聚焦在 rollout、session、sqlite 以及
    // 其他非预期的 thread-store 产物上，排除该目录的干扰。
    entries.remove("shell_snapshots");
    assert_eq!(
        entries,
        BTreeSet::from([
            "config.toml".to_string(),
            "installation_id".to_string(),
            "skills".to_string(),
        ]),
        "non-local thread persistence should not create unexpected files in codex_home"
    );

    Ok(())
}

fn codex_home_entries(codex_home: &Path) -> Result<BTreeSet<String>> {
    Ok(std::fs::read_dir(codex_home)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            Some(entry.file_name().to_string_lossy().into_owned())
        })
        .collect())
}

struct InMemoryThreadStoreId {
    store_id: String,
}

impl Drop for InMemoryThreadStoreId {
    fn drop(&mut self) {
        InMemoryThreadStore::remove_id(&self.store_id);
    }
}

fn create_config_toml_with_thread_store(
    codex_home: &Path,
    server_uri: &str,
    store_id: &str,
) -> std::io::Result<()> {
    std::fs::write(
        codex_home.join("config.toml"),
        format!(
            r#"
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"
experimental_thread_store = {{ type = "in_memory", id = "{store_id}" }}

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[features]
plugins = false
"#
        ),
    )
}

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use core_test_support::responses;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Respond;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path_regex;

/// 创建一个 mock server，按顺序为发往 `/v1/responses` 端点的请求返回预设的响应。
///
/// 设计意图：底层使用 `SeqResponder` 顺序消费传入的响应列表，
/// 通过 `expect(num_calls)` 断言调用次数，确保测试结束时所有响应都被消费，
/// 用于覆盖需要严格顺序的 LLM 流式响应场景。
pub async fn create_mock_responses_server_sequence(responses: Vec<String>) -> MockServer {
    let server = responses::start_mock_server().await;

    let num_calls = responses.len();
    let seq_responder = SeqResponder {
        num_calls: AtomicUsize::new(0),
        responses,
    };

    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(seq_responder)
        .expect(num_calls as u64)
        .mount(&server)
        .await;

    server
}

/// Same as `create_mock_responses_server_sequence` but does not enforce an
/// expectation on the number of calls.
pub async fn create_mock_responses_server_sequence_unchecked(responses: Vec<String>) -> MockServer {
    let server = responses::start_mock_server().await;

    let seq_responder = SeqResponder {
        num_calls: AtomicUsize::new(0),
        responses,
    };

    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(seq_responder)
        .mount(&server)
        .await;

    server
}

struct SeqResponder {
    num_calls: AtomicUsize,
    responses: Vec<String>,
}

impl Respond for SeqResponder {
    fn respond(&self, _: &wiremock::Request) -> ResponseTemplate {
        let call_num = self.num_calls.fetch_add(1, Ordering::SeqCst);
        let response = self
            .responses
            .get(call_num)
            .expect("mock model response should exist");
        responses::sse_response(response.clone())
    }
}

/// 创建一个 mock responses API server，对每一次请求都返回相同的 assistant 消息。
///
/// 适用场景：测试不关心多轮对话差异、只需要稳定的 LLM 回复即可推进流程的场景，
/// 例如验证 UI 渲染或会话状态机的迁移逻辑。
pub async fn create_mock_responses_server_repeating_assistant(message: &str) -> MockServer {
    let server = responses::start_mock_server().await;
    let body = responses::sse(vec![
        responses::ev_response_created("resp-1"),
        responses::ev_assistant_message("msg-1", message),
        responses::ev_completed("resp-1"),
    ]);
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(responses::sse_response(body))
        .mount(&server)
        .await;
    server
}

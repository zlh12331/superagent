//! Hook 输出溢出落盘工具。
//!
//! 当 hook 输出文本超过模型可见 token 预算时，将完整内容写入 OS 临时目录，
//! 并替换为 head/tail 摘要 + 完整内容路径的预览，避免占用过多模型上下文。

use codex_protocol::ThreadId;
use codex_protocol::items::HookPromptFragment;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::approx_token_count;
use codex_utils_output_truncation::formatted_truncate_text;
use tokio::fs;
use tracing::warn;
use uuid::Uuid;

/// 临时目录下存放溢出输出的子目录名。
const HOOK_OUTPUTS_DIR: &str = "hook_outputs";
/// hook 输出在模型上下文中所占的 token 上限。
const HOOK_OUTPUT_TOKEN_LIMIT: usize = 2_500;

/// 负责 hook 输出溢出落盘的内部工具类型。
#[derive(Clone)]
pub(crate) struct HookOutputSpiller {
    /// 溢出文件落盘的根目录。
    output_dir: AbsolutePathBuf,
}

impl HookOutputSpiller {
    /// 构造一个新的 spiller，输出目录解析为 OS 临时目录下的 `hook_outputs`。
    pub(crate) fn new() -> Self {
        Self {
            output_dir: AbsolutePathBuf::resolve_path_against_base(std::env::temp_dir(), "/")
                .join(HOOK_OUTPUTS_DIR),
        }
    }

    /// 在不超出模型可见 hook 输出预算的前提下处理文本。
    ///
    /// 超长文本会被完整写入 OS 临时目录下的
    /// `<temp_dir>/hook_outputs/<thread_id>/<uuid>.txt`，
    /// 并替换为与其他截断输出相同的 head/tail 预览样式，附带指向完整文本的路径。
    ///
    /// 若目录创建或写入失败，则仅返回截断预览，不抛出错误。
    pub(crate) async fn maybe_spill_text(&self, thread_id: ThreadId, text: String) -> String {
        if approx_token_count(&text) <= HOOK_OUTPUT_TOKEN_LIMIT {
            return text;
        }

        let path = hook_output_path(&self.output_dir, thread_id);
        if let Some(parent) = path.parent()
            && let Err(err) = fs::create_dir_all(parent.as_ref()).await
        {
            warn!(
                "failed to create hook output directory {}: {err}",
                parent.display()
            );
            return formatted_truncate_text(
                &text,
                TruncationPolicy::Tokens(HOOK_OUTPUT_TOKEN_LIMIT),
            );
        }

        if let Err(err) = fs::write(path.as_ref(), &text).await {
            warn!("failed to write hook output {}: {err}", path.display());
            return formatted_truncate_text(
                &text,
                TruncationPolicy::Tokens(HOOK_OUTPUT_TOKEN_LIMIT),
            );
        }

        spilled_hook_output_preview(&text, &path)
    }

    /// 对一组文本逐个执行 [`maybe_spill_text`](Self::maybe_spill_text)。
    pub(crate) async fn maybe_spill_texts(
        &self,
        thread_id: ThreadId,
        texts: Vec<String>,
    ) -> Vec<String> {
        let mut spilled = Vec::with_capacity(texts.len());
        for text in texts {
            spilled.push(self.maybe_spill_text(thread_id, text).await);
        }
        spilled
    }

    /// 对一组 prompt fragment 的文本执行溢出处理，保留 `hook_run_id` 不变。
    pub(crate) async fn maybe_spill_prompt_fragments(
        &self,
        thread_id: ThreadId,
        fragments: Vec<HookPromptFragment>,
    ) -> Vec<HookPromptFragment> {
        let mut spilled = Vec::with_capacity(fragments.len());
        for fragment in fragments {
            spilled.push(HookPromptFragment {
                text: self.maybe_spill_text(thread_id, fragment.text).await,
                hook_run_id: fragment.hook_run_id,
            });
        }
        spilled
    }
}

/// 构造某个 thread 的溢出输出文件路径，文件名使用随机 UUID。
fn hook_output_path(output_dir: &AbsolutePathBuf, thread_id: ThreadId) -> AbsolutePathBuf {
    output_dir
        .join(thread_id.to_string())
        .join(format!("{}.txt", Uuid::new_v4()))
}

/// 为已落盘的 hook 输出构建模型可见的替换文本。
///
/// 路径 footer 会在截断前从预算中扣除，确保追加恢复路径后
/// 整体预览不会超出 hook 输出上限。
fn spilled_hook_output_preview(text: &str, path: &AbsolutePathBuf) -> String {
    let footer = format!("\n\nFull hook output saved to: {}", path.display());
    let preview_policy = TruncationPolicy::Tokens(
        HOOK_OUTPUT_TOKEN_LIMIT.saturating_sub(approx_token_count(&footer)),
    );
    format!("{}{footer}", formatted_truncate_text(text, preview_policy))
}

#[cfg(test)]
#[path = "output_spill_tests.rs"]
mod tests;

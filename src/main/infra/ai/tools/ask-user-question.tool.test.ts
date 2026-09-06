// src/main/infra/ai/tools/ask-user-question.tool.test.ts
// ask_user_question 工具单测：无窗口降级 / 空应答 / 回答序列化渲染

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAskService } from '../agent/agent-ask-service';
import { createAskUserQuestionTool } from './ask-user-question.tool';
import type { ToolContext } from './tool';

function makeCtx(webContents?: unknown): ToolContext {
  return {
    sessionId: 's1',
    webContents: webContents as never,
  } as unknown as ToolContext;
}

type AskAnswer = { selectedIndexes?: number[]; text?: string };

function makeAskService(answers: AskAnswer[] | null) {
  return {
    ask: vi.fn(async () => answers),
  } as unknown as AgentAskService;
}

describe('ask_user_question', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无窗口（后台/测试）→ 无法提问，不阻塞回合', async () => {
    const ask = makeAskService([]);
    const res = await createAskUserQuestionTool(ask).execute(
      { questions: [{ question: 'q1' }] },
      makeCtx(),
    );
    expect(res.title).toBe('提问失败');
    expect(ask.ask).not.toHaveBeenCalled();
  });

  it('窗口已销毁 → 同无窗口', async () => {
    const ask = makeAskService([]);
    const res = await createAskUserQuestionTool(ask).execute(
      { questions: [{ question: 'q1' }] },
      makeCtx({ isDestroyed: () => true }),
    );
    expect(res.title).toBe('提问失败');
  });

  it('用户 60s 未响应（null）→ 提示继续执行', async () => {
    const ask = makeAskService(null);
    const res = await createAskUserQuestionTool(ask).execute(
      { questions: [{ question: '选哪家' }] },
      makeCtx({ isDestroyed: () => false }),
    );
    expect(res.title).toBe('用户未响应');
  });

  it('回答序列化：选项 label + 自由文本合并', async () => {
    const ask = makeAskService([{ selectedIndexes: [0, 2], text: '补充说明' }]);
    const res = await createAskUserQuestionTool(ask).execute(
      {
        questions: [
          {
            question: '用途',
            options: [{ label: '学习' }, { label: '工作' }, { label: '项目' }],
          },
        ],
      },
      makeCtx({ isDestroyed: () => false }),
    );
    expect(ask.ask).toHaveBeenCalledTimes(1);
    expect(res.output).toContain('Q1: 用途 → 学习、项目；补充说明');
  });

  it('未选任何选项 → 「用户未选择」', async () => {
    const ask = makeAskService([{}]);
    const res = await createAskUserQuestionTool(ask).execute(
      { questions: [{ question: 'q' }] },
      makeCtx({ isDestroyed: () => false }),
    );
    expect(res.output).toContain('（用户未选择）');
  });

  it('选项索引越界兜底 label（选项 1/选项 2）', async () => {
    const ask = makeAskService([{ selectedIndexes: [9] }]);
    const res = await createAskUserQuestionTool(ask).execute(
      { questions: [{ question: 'q', options: [{ label: 'A' }] }] },
      makeCtx({ isDestroyed: () => false }),
    );
    expect(res.output).toContain('选项1');
  });
});

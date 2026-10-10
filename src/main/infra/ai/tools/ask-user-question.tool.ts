import { z } from 'zod';
import { t } from '../../i18n';
import type { AgentAskService } from '../agent/agent-ask-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const AskUserQuestionInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).describe('问题正文'),
        header: z.string().optional().describe('问题标题（如「代码审查」）'),
        options: z
          .array(
            z.object({
              label: z.string().min(1).describe('选项标签'),
              description: z.string().optional().describe('选项说明'),
            }),
          )
          .optional()
          .describe('预置选项（单选/多选，用户也可自由输入）'),
        multiSelect: z.boolean().optional().describe('是否多选（默认单选）'),
      }),
    )
    .min(1)
    .describe('问题列表（一次可多问）'),
});

const toolDescription = `在执行过程中需要向用户提问时使用（收集偏好、确认方向、让用户在选项间选择等）。支持一次问多个问题，每个问题可带预置选项（单选/多选），用户也可以自由输入文本回答。请优先提供选项以降低用户输入成本。`;

export function createAskUserQuestionTool(askService: AgentAskService): Tool {
  return {
    name: 'ask_user_question',
    description: toolDescription,
    permission: 'auto' as const,
    category: 'control' as const,
    inputSchema: AskUserQuestionInputSchema,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { questions } = AskUserQuestionInputSchema.parse(input);
      const { webContents } = context;

      if (webContents === undefined || webContents.isDestroyed()) {
        return {
          title: t('tools.askUser.failed'),
          output: '无法向用户提问（无可用窗口）。请基于现有信息继续执行或说明需要用户确认的原因。',
        };
      }

      const answers = await askService.ask(webContents, questions, context.sessionId);
      if (answers === null) {
        return {
          title: t('tools.askUser.noResponse'),
          output: '用户在 60 秒内未回答提问。请基于现有信息继续执行，或说明需要用户确认的原因。',
        };
      }

      const rendered = questions
        .map((q, index) => {
          const answer = answers[index];
          if (answer === undefined) return `Q${index + 1}: ${q.question} → （无回答）`;
          const selected =
            answer.selectedIndexes !== undefined && answer.selectedIndexes.length > 0
              ? answer.selectedIndexes
                  .map((i) =>
                    q.options !== undefined
                      ? (q.options[i]?.label ?? `选项${i + 1}`)
                      : `选项${i + 1}`,
                  )
                  .join('、')
              : '';
          const text = answer.text !== undefined && answer.text !== '' ? answer.text : '';
          const parts = [selected, text].filter((p) => p !== '');
          return `Q${index + 1}: ${q.question} → ${parts.length > 0 ? parts.join('；') : '（用户未选择）'}`;
        })
        .join('\n');

      return {
        title: t('tools.askUser.answered'),
        output: `用户回答如下：\n${rendered}`,
      };
    },
  };
}

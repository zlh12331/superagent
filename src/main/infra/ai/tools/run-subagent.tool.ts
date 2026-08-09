// src/main/infra/ai/tools/run-subagent.tool.ts
// run_subagent 工具：模型委派任务给子代理（对齐 qwen Subagents 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - permission='ask' / category='exec'：子代理回合可能产生副作用（写文件），
//   保守审批；auto 模式下无 command 字段 → 走"其余命令保守 ask"
// - 子代理执行是嵌套回合（独立 sessionId，无头模式）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { getSubagentManager } from '../agent/subagent-manager';
import type { Tool, ToolContext, ToolResult } from './tool';

/** run_subagent 入参 */
const RunSubagentInputSchema = z.object({
  /** 子代理名（general / code_review / plan 等） */
  agent: z.string().min(1).max(100),
  /** 委派任务描述 */
  task: z.string().min(1).max(2000),
});

type RunSubagentInput = z.infer<typeof RunSubagentInputSchema>;

/**
 * 创建 run_subagent 工具（依赖模块级 SubagentManager 单例）
 */
export function createRunSubagentTool(): Tool<RunSubagentInput> {
  return {
    name: 'run_subagent',
    description:
      '将独立子任务委派给子代理执行（general 通用 / code_review 代码审查 / plan 方案）。子代理在独立回合中运行，返回其结论。适合代码审查、方案设计、独立研究等可并行任务。',
    inputSchema: RunSubagentInputSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: RunSubagentInput, ctx: ToolContext): Promise<ToolResult> => {
      const manager = getSubagentManager();
      try {
        const result = await manager.run(input.agent, input.task, ctx.workingDir);
        return {
          title: `子代理完成: ${input.agent}`,
          output: result.hasOutput
            ? `【子代理 ${input.agent} 结果】（耗时 ${Math.round(result.durationMs / 1000)}s）\n${result.output}`
            : `【子代理 ${input.agent}】回合完成但无文本输出（可能为纯工具回合），请检查工作区变更。`,
        };
      } catch (err: unknown) {
        return {
          title: `子代理失败: ${input.agent}`,
          output: `子代理执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

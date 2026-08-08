// src/main/infra/ai/tools/plan-mode.tools.ts
// 计划模式切换工具（enter_plan_mode / exit_plan_mode，对齐 qwen-code）
// ──────────────────────────────────────────────────────────────
// 语义：
// - enter_plan_mode：切换审批模式为 plan（只读探索：read 类 auto、
//   写类 deny——permission-service 已实现硬拦截），记录进入前模式
// - exit_plan_mode：恢复进入前模式（无记录回退 'ask' 保守默认）
//
// 子代理继承：子代理回合走同一 PermissionService → plan 模式下
// 子代理写工具同样被拒（对齐 qwen subagent-plan-tool-policy）
// ──────────────────────────────────────────────────────────────

import type { ApprovalMode } from '@code-agent/shared/main';
import { z } from 'zod';
import { writeApprovalMode } from '../../storage/approval-pref';
import type { IPermissionService } from '../permission-service';
import type { Tool, ToolResult } from '../tool';

/** 进入 plan 模式前保存的模式（exit 时恢复；进程内单实例） */
let previousMode: ApprovalMode | null = null;

/**
 * 创建 enter_plan_mode 工具
 *
 * @param permissionService 权限服务（模式切换 + 持久化）
 */
export function createEnterPlanModeTool(permissionService: IPermissionService): Tool {
  return {
    name: 'enter_plan_mode',
    description:
      '进入计划模式（只读）：在此模式下所有写操作（编辑/写入/命令执行）会被拒绝，仅允许读取与搜索。适用于先分析、制定方案、再征求用户同意的阶段。完成后调用 exit_plan_mode 恢复原模式。',
    permission: 'auto' as const,
    category: 'exec' as const,
    inputSchema: z.object({
      reason: z.string().optional().describe('进入计划模式的原因（记录用）'),
    }),
    async execute(): Promise<ToolResult> {
      const current = permissionService.getApprovalMode();
      if (current === 'plan') {
        return { title: '已在计划模式', output: '当前已处于计划模式（只读），无需重复切换。' };
      }
      previousMode = current;
      await writeApprovalMode('plan');
      permissionService.setApprovalMode('plan');
      return {
        title: '已进入计划模式',
        output:
          '已进入计划模式（只读）：所有写操作（编辑/写入/命令）将被拒绝，仅可读取与搜索。请先完成分析与方案设计，然后调用 exit_plan_mode 恢复原模式，或在方案确认后由用户恢复。',
      };
    },
  };
}

/**
 * 创建 exit_plan_mode 工具
 *
 * @param permissionService 权限服务（模式切换 + 持久化）
 */
export function createExitPlanModeTool(permissionService: IPermissionService): Tool {
  return {
    name: 'exit_plan_mode',
    description:
      '退出计划模式：恢复进入计划模式前的审批模式（未记录则回退 ask 保守默认）。在方案确认、需要执行写操作时调用。',
    permission: 'auto' as const,
    category: 'exec' as const,
    inputSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      const current = permissionService.getApprovalMode();
      if (current !== 'plan') {
        return { title: '不在计划模式', output: '当前不在计划模式，无需退出。' };
      }
      const target: ApprovalMode = previousMode ?? 'ask';
      previousMode = null;
      await writeApprovalMode(target);
      permissionService.setApprovalMode(target);
      return {
        title: '已退出计划模式',
        output: `已退出计划模式，恢复审批模式为 ${target}（写操作按该模式决策）。`,
      };
    },
  };
}

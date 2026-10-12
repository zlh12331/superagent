// plan-mode.tools.ts：plan 模式进出工具——enter 切 plan 只读态（记住原模式），exit 还原
import type { ApprovalMode } from '@code-agent/shared/main';
import { z } from 'zod';
import { t } from '../../i18n';
import { writeApprovalMode } from '../../storage/approval-pref';
import type { IPermissionService } from './permission-service';
import type { Tool, ToolResult } from './tool';

let previousMode: ApprovalMode | null = null;

export function createEnterPlanModeTool(permissionService: IPermissionService): Tool {
  return {
    name: 'enter_plan_mode',
    description:
      '进入计划模式（只读）：在此模式下所有写操作（编辑/写入/命令执行）会被拒绝，仅允许读取与搜索。适用于先分析、制定方案、再征求用户同意的阶段。完成后调用 exit_plan_mode 恢复原模式。',
    permission: 'auto' as const,
    category: 'control' as const,
    inputSchema: z.object({
      reason: z.string().optional().describe('进入计划模式的原因（记录用）'),
    }),
    async execute(): Promise<ToolResult> {
      const current = permissionService.getApprovalMode();
      if (current === 'plan') {
        return {
          title: t('tools.planMode.alreadyInPlan'),
          output: '当前已处于计划模式（只读），无需重复切换。',
        };
      }
      previousMode = current;
      await writeApprovalMode('plan');
      permissionService.setApprovalMode('plan');
      return {
        title: t('tools.planMode.entered'),
        output:
          '已进入计划模式（只读）：所有写操作（编辑/写入/命令）将被拒绝，仅可读取与搜索。请先完成分析与方案设计，然后调用 exit_plan_mode 恢复原模式，或在方案确认后由用户恢复。',
      };
    },
  };
}

export function createExitPlanModeTool(permissionService: IPermissionService): Tool {
  return {
    name: 'exit_plan_mode',
    description:
      '退出计划模式：恢复进入计划模式前的审批模式（未记录则回退 ask 保守默认）。在方案确认、需要执行写操作时调用。',
    permission: 'auto' as const,
    category: 'control' as const,
    inputSchema: z.object({}),
    async execute(): Promise<ToolResult> {
      const current = permissionService.getApprovalMode();
      if (current !== 'plan') {
        return { title: t('tools.planMode.notInPlan'), output: '当前不在计划模式，无需退出。' };
      }
      const target: ApprovalMode = previousMode ?? 'ask';
      previousMode = null;
      await writeApprovalMode(target);
      permissionService.setApprovalMode(target);
      return {
        title: t('tools.planMode.exited'),
        output: `已退出计划模式，恢复审批模式为 ${target}（写操作按该模式决策）。`,
      };
    },
  };
}

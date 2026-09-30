// src/renderer/hooks/use-backups.ts
// 备份恢复点查询与操作 hook（37 号 B：L3 服务端数据层；查询逻辑域文件）
// ──────────────────────────────────────────────────────────────
// 职责：
// - useBackups：查询恢复点列表（backup:list → TanStack Query）
// - useCreateBackup：手动立即备份 mutation（成功后失效列表重拉）
// - useRestoreBackup：从恢复点恢复 mutation（成功后应用将重启，前端兜提示）
//
// 设计（对齐项目查询层约定）：
// - queryKey 常量在本文件导出（禁组件内联定义 key）
// - 变更操作 onError 统一 toast（调用层不重复挂）
// - restore 会触发主进程 relaunch+quit——成功响应到达后应用即将退出，
//   不给「已恢复」成功 toast（进程将消失），仅错误路径有 toast
// ──────────────────────────────────────────────────────────────

import type { BackupEntry } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useErrorMessage } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap, unwrapErrorMessage } from '@/lib/ipc';

/** 备份列表查询 key（域文件导出；调用方引用常量） */
export const BACKUPS_QUERY_KEY = ['backups'] as const;

/**
 * 备份恢复点列表查询
 *
 * 无桥（浏览器模式）返回空列表（mock 域同为空的诚实形态）。
 */
export function useBackups() {
  return useQuery({
    queryKey: BACKUPS_QUERY_KEY,
    queryFn: async (): Promise<readonly BackupEntry[]> => {
      if (!hasIpcBridge()) {
        return [];
      }
      const res = await window.api.backup.list();
      return unwrap(res).backups;
    },
  });
}

/**
 * 手动立即备份 mutation
 *
 * 成功：失效列表（新恢复点即时出现）+ 调用方 toast；失败：toast（本 hook）。
 * restore 成功后进程将重启，本 mutation 不需要（创建备份不重启）。
 */
export function useCreateBackup() {
  const queryClient = useQueryClient();
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async () => {
      const res = await window.api.backup.create();
      return unwrap(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
  });
}

/**
 * 从恢复点恢复 mutation（应用将重启，重启后暂存生效）
 *
 * 成功路径不弹「已恢复」（进程立刻消失）；失败（SESSION_IN_USE / BACKUP_INVALID）
 * 由本 hook toast。调用方在调用前需 confirm（danger：重启 + 未导出改动丢失）。
 */
export function useRestoreBackup() {
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async (name: string) => {
      const res = await window.api.backup.restore({ name });
      return unwrap(res);
    },
    onError: (error) => {
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
  });
}

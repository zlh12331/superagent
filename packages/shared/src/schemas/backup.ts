// backup.ts：Backup 域 zod 契约单一真源（backup:list / create / restore 的请求-响应形状）
// 消费方：IPC 定义表引用这些 schema，注册层据此校验入参与 handler 返回值——防手写 Res 接口与实现漂移
// 边界：只做形状校验；name 的路径穿越防御、healthy 的 quick_check 判定、backups/ 轮转环都在主进程

import { z } from 'zod';

/** 备份恢复点条目（backup:list 响应元素） */
export interface BackupEntry {
  /** 备份文件名（裸名，如 sessions-2026-09-30T04-00-00.db；可直接回传给 backup:restore） */
  readonly name: string;
  /** 备份创建时间（epoch ms；从文件名时间戳解析，解析失败回落文件 mtime） */
  readonly createdAtMs: number;
  /** 文件大小（字节） */
  readonly sizeBytes: number;
  /** 完整性校验结论（quick_check === ok）；损坏备份不可用于恢复——假恢复点比没有备份更危险 */
  readonly healthy: boolean;
}

/** backup:list 响应 payload（最新在前；损坏项同样列出，是否开放恢复入口由消费方按 healthy 判断） */
export interface BackupListRes {
  readonly backups: readonly BackupEntry[];
}

/** backup:list 响应 zod schema（响应契约校验用） */
export const BackupListResSchema = z.object({
  backups: z.array(
    z.object({
      name: z.string().min(1),
      createdAtMs: z.number().int(),
      sizeBytes: z.number().int().nonnegative(),
      healthy: z.boolean(),
    }),
  ),
});

/** backup:create 响应 payload（name = 新备份文件名）；新备份与启动热备份共用 backups/ 轮转环，超出 BACKUP_KEEP 份删最旧 */
export interface BackupCreateRes {
  readonly name: string;
}

/** backup:create 响应 zod schema */
export const BackupCreateResSchema = z.object({
  name: z.string().min(1),
});

/** backup:restore 入参 zod schema（name 为裸文件名，应为 backup:list 给出的名字；穿越防御与健康度检查在主进程） */
export const BackupRestoreReqSchema = z.object({
  name: z.string().min(1),
});

/** backup:restore 响应 payload（ok=true 表示恢复点已暂存，主进程随即重启应用使其生效） */
export interface BackupRestoreRes {
  readonly ok: boolean;
}

/** backup:restore 响应 zod schema */
export const BackupRestoreResSchema = z.object({
  ok: z.boolean(),
});

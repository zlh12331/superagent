// packages/shared/src/schemas/backup.ts
// Backup 域 zod schema 单一真源（37 号 B：启动备份可见性与手动恢复）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 backup:list / backup:create / backup:restore 请求-响应 zod schema
// - 供主进程 backup.handler 校验入参、推导响应类型
//
// 设计：
// - 恢复点是 backups/ 目录下的轮转环（sessions-<ISO 时间戳>.db，保留最近
//   BACKUP_KEEP 份）——启动热备份与手动备份进同一环，语义单一
// - name 是**裸文件名**（basename 校验 + 必须落在 backups/ 目录内）：
//   主进程侧再做路径穿越防御（schema 只做形状校验）
// - healthy 由主进程 quick_check 得出——「假恢复点比没有备份更危险」，
//   列表与恢复入口都以健康度为分界
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** 备份恢复点条目（backup:list 响应元素） */
export interface BackupEntry {
  /** 备份文件名（裸名，如 sessions-2026-09-30T04-00-00.db） */
  readonly name: string;
  /** 备份创建时间（epoch ms；从文件名时间戳解析，解析失败回落文件 mtime） */
  readonly createdAtMs: number;
  /** 文件大小（字节） */
  readonly sizeBytes: number;
  /** 完整性校验结论（quick_check === ok；损坏备份不可用于恢复） */
  readonly healthy: boolean;
}

/** backup:list 响应 payload（最新在前） */
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

/** backup:create 响应 payload（name = 新备份文件名） */
export interface BackupCreateRes {
  readonly name: string;
}

/** backup:create 响应 zod schema */
export const BackupCreateResSchema = z.object({
  name: z.string().min(1),
});

/** backup:restore 入参 zod schema（name 为裸文件名，穿越防御在主进程） */
export const BackupRestoreReqSchema = z.object({
  name: z.string().min(1),
});

/** backup:restore 响应 payload（ok=true 表示已暂存、重启后生效） */
export interface BackupRestoreRes {
  readonly ok: boolean;
}

/** backup:restore 响应 zod schema */
export const BackupRestoreResSchema = z.object({
  ok: z.boolean(),
});

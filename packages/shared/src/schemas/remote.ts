// remote.ts：远程控制域 IPC 契约单一真源（局域网直连：移动端 → 桌面端 Agent）
// 四方法（getStatus / start / stop / setBindScope）响应统一为 RemoteStatusRes，且变更后立即回读
// 状态返回——渲染层无需二次请求即可刷新面板。
// 安全约束：token 只经桌面端显式展示分发（配对动作），不进入 UDP 公告与 HTTP /info 响应。
// 边界：只定义形状与值域；监听、令牌校验与 UDP 发现实现在 src/main/infra/remote/。

import { z } from 'zod';

/**
 * 绑定范围：HTTP 监听与局域网可见性
 *
 * - lan：监听 0.0.0.0（局域网设备可配对连接）+ UDP 发现广播（现状默认，兼容存量）
 * - loopback：仅监听 127.0.0.1（局域网不可达），停发 UDP 公告——
 *   仅本机模式不应向局域网广播自身存在
 */
export type RemoteBindScope = 'loopback' | 'lan';

/**
 * 远程控制状态响应（getStatus / start / stop / setBindScope 共用）
 */
export interface RemoteStatusRes {
  /** 监听是否在运行 */
  readonly running: boolean;
  /** HTTP 命令入口端口（未运行为 null） */
  readonly port: number | null;
  /** 本次会话配对令牌（未运行为 null；仅桌面端展示） */
  readonly token: string | null;
  /** 实例名（发现公告展示名，默认主机名） */
  readonly instanceName: string;
  /** 绑定范围（lan=局域网可连；loopback=仅本机 127.0.0.1） */
  readonly bindScope: RemoteBindScope;
  /**
   * 可直连的完整入口 URL（形如 `http://192.168.1.10:52341`，含协议与端口，可直接展示/复制）
   * lan=局域网 IPv4 端点；loopback=仅本机端点；未运行或不可配对时为空数组
   */
  readonly addresses: readonly string[];
  /** 正在执行的远程命令数（无头回合） */
  readonly activeCommands: number;
  /** 最近一次命令到达时间戳（毫秒，同 `Date.now()`；从未收到为 null） */
  readonly lastCommandAt: number | null;
}

/** 远程控制状态响应 zod schema（R4：响应契约校验） */
export const RemoteStatusResSchema = z.object({
  running: z.boolean(),
  port: z.number().int().nonnegative().nullable(),
  token: z.string().nullable(),
  instanceName: z.string(),
  bindScope: z.enum(['loopback', 'lan']),
  addresses: z.array(z.string()),
  activeCommands: z.number().int().nonnegative(),
  lastCommandAt: z.number().int().nonnegative().nullable(),
});

/** remote:setBindScope 请求体（z.infer 派生，与 im 域请求类型同构，防手写漂移） */
export type RemoteSetBindScopeReq = z.infer<typeof RemoteSetBindScopeReqSchema>;

/** remote:setBindScope 请求体 zod schema */
export const RemoteSetBindScopeReqSchema = z.object({
  scope: z.enum(['loopback', 'lan']),
});

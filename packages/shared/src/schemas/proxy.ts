// packages/shared/src/schemas/proxy.ts
// Proxy 域 zod schema 单一真源（网络代理，34 号 spec §2.3）
// ──────────────────────────────────────────────────────────────
// proxy:test：渲染层「测试连接」按钮 → 主进程经 proxiedFetch 探测轻量端点。
// kind 双值归因（反例 6）：proxy-unreachable = 连代理本身失败；
// target-unreachable = 代理通但目标不可达。mode 非 fixed 时不可测（ok=false）。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** proxy:test 入参（无必填；超时由主进程固定 3s，D7） */
export const ProxyTestReqSchema = z.object({
  /** 探测目标（省略 = 主进程默认中立端点 https://www.gstatic.com/generate_204） */
  targetUrl: z.string().url().optional(),
});

export type ProxyTestReq = z.infer<typeof ProxyTestReqSchema>;

/** proxy:test 响应（V10 三态：ok / proxy-unreachable / target-unreachable） */
export interface ProxyTestRes {
  /** true = 经代理成功到达目标 */
  readonly ok: boolean;
  /** 归因（ok=false 时有值；ok=true 恒 'ok'） */
  readonly kind: 'ok' | 'proxy-unreachable' | 'target-unreachable' | 'not-applicable';
  /** 人类可读补充（失败原因/当前模式提示；i18n 由渲染层按 kind 映射文案） */
  readonly message?: string;
}

export const ProxyTestResSchema = z.object({
  ok: z.boolean(),
  kind: z.enum(['ok', 'proxy-unreachable', 'target-unreachable', 'not-applicable']),
  message: z.string().optional(),
});

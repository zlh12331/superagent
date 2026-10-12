// proxy.ts：Proxy 域 IPC 契约单一真源（proxy:test 的入参 / 响应形状与取值）
// 链路：设置页「测试连接」→ invoke proxy:test → 主进程经 proxiedFetch 探测轻量端点（超时固定 3s）
// 边界：只定义契约；探测与模式判定在 src/main/ipc/proxy.handler.ts，代理配置值门禁在 packages/shared/src/schemas/settings.ts
// 设计依据：docs/implementation/34-network-proxy-spec.md

import { z } from 'zod';

/** proxy:test 入参（无必填字段，传 {} 合法；3s 探测超时由主进程固定，无对应入参） */
export const ProxyTestReqSchema = z.object({
  /** 探测目标（省略 = 主进程默认中立端点 https://www.gstatic.com/generate_204：204 空响应、不锚定 AI 供应商域名） */
  targetUrl: z.string().url().optional(),
});

/** proxy:test 入参类型（z.infer 自 ProxyTestReqSchema） */
export type ProxyTestReq = z.infer<typeof ProxyTestReqSchema>;

/** proxy:test 响应（ok 与 kind 同源：成功恒为 ok=true + kind='ok'，失败按 kind 归因） */
export interface ProxyTestRes {
  /** true = 探测成功（经当前代理配置到达目标） */
  readonly ok: boolean;
  /**
   * 归因（ok=false 时有值；ok=true 恒 'ok'）
   *
   * 'proxy-unreachable' = 连代理本身失败：设计预留值，当前主进程把失败统一归为
   * 'target-unreachable'（src/main/ipc/proxy.handler.ts），消费方勿依赖它被产出；
   * 'not-applicable' = 当前模式无需探测（非 fixed 或无 IPC 桥）。
   */
  readonly kind: 'ok' | 'proxy-unreachable' | 'target-unreachable' | 'not-applicable';
  /**
   * 归因补充文本：not-applicable 为模式提示；target-unreachable 透传原始网络错误
   * （不转译——ECONNREFUSED 等要能看到真实代理端口）。渲染层按 kind 映射 i18n 文案、
   * 不直出此字段，勿在此塞用户可见文案。
   */
  readonly message?: string;
}

/** proxy:test 响应契约 schema（注册层 wrap 校验 handler 返回值，防接口声明与实现漂移） */
export const ProxyTestResSchema = z.object({
  ok: z.boolean(),
  kind: z.enum(['ok', 'proxy-unreachable', 'target-unreachable', 'not-applicable']),
  message: z.string().optional(),
});

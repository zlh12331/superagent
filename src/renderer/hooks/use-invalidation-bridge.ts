// src/renderer/hooks/use-invalidation-bridge.ts
// 失效域事件桥（AppShell 挂载，全局唯一订阅点）
// ──────────────────────────────────────────────────────────────
// 职责：订阅 invalidation:event:domains，把主进程写路径声明的受影响域
// 逐域前缀失效（TanStack Query）。失效的「知识」由写入端（主进程）声明，
// 渲染层不再逐域人工补清单（docs/design/31-invalidation-automation-spec.md）。
//
// 双职责：
// 1. applyDomainInvalidation —— 失效事件覆盖的域
// 2. noteInvalidationEvent —— 登记回合结束聚合声明已覆盖，供 use-agent-bridge
//    的 streamEnd 处理跳过旧硬编码清单（渐进回落判定）
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';

import { applyDomainInvalidation, noteInvalidationEvent } from '@/lib/invalidation/invalidation';
import { hasIpcBridge } from '@/lib/ipc';

/** 挂载失效域事件桥（无返回值；随 AppShell 生命周期，卸载即退订） */
export function useInvalidationBridge(): void {
  useEffect(() => {
    if (!hasIpcBridge()) {
      return;
    }
    const unsubscribe = window.api.invalidation.subscribeDomains((payload) => {
      // 先登记覆盖再失效（顺序无实质影响，保持「记录后动作」的阅读顺序）
      noteInvalidationEvent(payload.domains, payload.sessionId);
      applyDomainInvalidation(payload.domains);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}

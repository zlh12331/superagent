// src/renderer/hooks/use-update-bridge.ts
// 更新事件桥（AppShell 挂载，全局唯一订阅点）
// ──────────────────────────────────────────────────────────────
// 职责：挂载时读主进程状态快照（update:getStatus）并订阅 update:event:status，
// 统一写入 update-store；消费方（关于面板 / 顶栏指示 / toast 提示）只读 store。
//
// 为什么集中：此前三个消费点各自订阅同一通道（每个订阅额外发一次 getStatus），
// 既与项目单 bridge 惯例不符，也随消费点增加线性放大启动期请求。
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';

import { unwrap } from '@/lib/ipc';
import { useUpdateStore } from '@/stores/transient/update-store';

/** 挂载更新事件桥（无返回值；随 AppShell 生命周期，卸载即退订） */
export function useUpdateBridge(): void {
  const applySnapshot = useUpdateStore((s) => s.applySnapshot);
  const applyLive = useUpdateStore((s) => s.applyLive);

  // 浏览器模式（window.api 缺失）跳过订阅：与 use-agent-bridge 等守卫模式对齐
  useEffect(() => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    let active = true;
    // 先拉快照（窗口重载后恢复界面），再订阅事件；事件到达后以事件态为准
    void api.update
      .getStatus()
      .then((res) => {
        const status = unwrap(res);
        if (active && status.snapshot !== null) {
          applySnapshot(status.snapshot, status.lastCheckAt);
        }
      })
      .catch(() => {
        // 快照读取失败静默：后续状态仍由事件通道推送
      });
    const unsubscribe = api.update.subscribeStatus(applyLive);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applySnapshot, applyLive]);
}

// src/renderer/hooks/use-settings-bridge.ts
// 设置变更事件桥（AppShell 挂载，全局唯一订阅点）
// ──────────────────────────────────────────────────────────────
// 职责：订阅 settings:event:changed，把「主进程主动写入」的设置变更应用到 store。
//
// 为什么需要（docs/design/30-residency-fix-spec.md §3 P2-6）：正常路径是渲染层写 →
// settings:set → SQLite；但托盘菜单会在主进程侧直写（如「关闭时最小化到托盘」改
// window.closeAction）。渲染层 store 若不跟随，后续任何其它设置变更都会把 store 里
// 的旧值整体写回，静默覆盖主进程的改动（丢更新）。
//
// 只处理主进程来源的变更：渲染层自身写入的回显由各 set* 的响应负责，此处收到即
// 应用（`applyMainSettingChange` 不回写，无回声）。
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';

import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 挂载设置变更事件桥（无返回值；随 AppShell 生命周期，卸载即退订） */
export function useSettingsBridge(): void {
  const applyMainSettingChange = useSettingsStore((s) => s.applyMainSettingChange);

  // 浏览器模式（window.api 缺失）跳过订阅：与 use-agent-bridge / use-update-bridge 同模式
  useEffect(() => {
    const api = window.api;
    if (api === undefined) {
      return;
    }
    const unsubscribe = api.settings.subscribeChanged((payload) => {
      applyMainSettingChange(payload.key, payload.value);
    });
    return () => {
      unsubscribe();
    };
  }, [applyMainSettingChange]);
}

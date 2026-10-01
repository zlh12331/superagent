// src/renderer/hooks/use-zoom-effect.ts
// 界面缩放应用单点（35 号 spec §2.4.1：AppShell 挂载，订阅 store 单真源）
// ──────────────────────────────────────────────────────────────
// 为什么单点：缩放的五个入口（设置页/快捷键/导入广播/resetAll/启动）全部经
// settings-store——挂一个订阅 appearance.zoom 的 effect 构造性覆盖全部入口，
// 无需在各入口散布 applyZoom 调用（CP2 第二路 D-1 采纳；changeLanguage 的
// 内联收口先例不适用：language 只有一个旁路入口，zoom 是五入口全走 store）。
//
// 与 main.tsx 首帧应用的关系：render 前已应用首帧值（无跳变），本 effect 挂载
// 时会对同值再调一次——setZoomFactor 幂等无害（断言按「值收敛」而非调用次数）。
// ──────────────────────────────────────────────────────────────

import { useEffect } from 'react';

import { applyZoom } from '@/lib/zoom';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 订阅 store.appearance.zoom 并应用（AppShell 顶层挂载一次） */
export function useZoomEffect(): void {
  const zoom = useSettingsStore((s) => s.appearance.zoom);
  useEffect(() => {
    void applyZoom(zoom);
  }, [zoom]);
}

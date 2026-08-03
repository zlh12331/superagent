// src/renderer/components/common/UpdateNotice.tsx
// 自动更新提示（AppShell 根级挂载，事件驱动 toast）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅主进程更新状态推送（useUpdate）
// - 按阶段渲染 toast：发现新版本 / 下载完成（带重启安装）/ 已是最新 / 错误
// - 下载进度（downloading）不弹 toast（频率过高），由状态保留供后续展示
//
// 设计：
// - 纯事件消费组件：不渲染 DOM（返回 null），所有提示走 sonner
// - lastPhase ref 防抖：同一阶段不重复弹（避免重复订阅/重渲染误报）
// ──────────────────────────────────────────────────────────────

import type { UpdatePhase } from '@code-agent/shared/renderer';
import { type ReactElement, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useUpdate } from '@/hooks/use-update';

/**
 * 自动更新提示组件（挂载在 AppShell 根级，全局只此一个）
 */
export function UpdateNotice(): ReactElement | null {
  const { state, install } = useUpdate();
  // 记录上次已提示的阶段（同阶段重复推送不弹，避免干扰）
  const lastNotifiedPhaseRef = useRef<UpdatePhase | null>(null);

  useEffect(() => {
    const phase = state?.phase;
    if (phase === undefined || phase === lastNotifiedPhaseRef.current) {
      return;
    }
    lastNotifiedPhaseRef.current = phase;

    switch (phase) {
      case 'available':
        // electron-updater 默认自动下载，这里提示用户已发现新版
        toast.info('发现新版本', {
          description: `v${state?.version ?? ''} 正在后台下载…`,
        });
        break;
      case 'downloaded':
        toast('更新已就绪', {
          description: `v${state?.version ?? ''} 下载完成，重启后生效`,
          action: {
            label: '立即重启',
            onClick: install,
          },
          duration: 60_000,
        });
        break;
      case 'not-available':
        toast.success('已是最新版本');
        break;
      case 'error':
        toast.error('更新检查失败', {
          description: state?.message ?? '未知错误',
        });
        break;
      case 'checking':
      case 'downloading':
        // 检查中/下载进度不做 toast（进度高频推送，避免刷屏）
        break;
    }
  }, [state, install]);

  return null;
}

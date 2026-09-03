// src/renderer/hooks/use-deep-link.ts
// 深度链接 IPC 桥接 Hook（协议唤起 `code-agent://` 导航）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 订阅 app:event:deep-link 事件（主进程在协议唤起时广播）
// - 携带 sessionId → 导航到 /chat/:sessionId（历史会话续传）并激活侧栏
// - 无 sessionId（仅唤起）→ 聚焦窗口（AppShell 挂载即已聚焦；广播时保持现状）
//
// 设计：
// - AppShell 根布局初始化一次，保证任意路由下均能接收（对齐 use-terminal-bridge）
// - 冷启动场景：主进程在 createWindow 后补发，本 hook 与窗口同时就绪
// - 浏览器模式（dev:web，无 window.api）：跳过（无协议注册）
// ──────────────────────────────────────────────────────────────

import type { DeepLinkPayload } from '@code-agent/shared/renderer';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

import { ROUTES } from '@/lib/constants';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';

/**
 * 深度链接桥接 Hook（AppShell 挂载一次）
 *
 * 收到 `code-agent://session/<id>` 唤起时跳转到对应会话；
 * 仅唤起（无 sessionId）时留驻当前页面（窗口已由主进程聚焦）。
 */
export function useDeepLink(): void {
  const navigate = useNavigate();
  const setActiveSession = useActiveSessionStore((s) => s.setActiveSession);

  useEffect(() => {
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }

    // 冷启动（Windows/Linux）：协议 URL 作为进程参数传入，主进程仅在窗口存在时
    // 广播——渲染层启动时主动拉取一次兜底（配合主进程 createWindow 后补发）
    const unsubscribe = window.api.app.subscribeDeepLink((payload) => {
      const typedPayload = payload as DeepLinkPayload;
      if (typedPayload.sessionId === null || typedPayload.sessionId === '') {
        return; // 仅唤起：窗口已聚焦，无导航动作
      }
      setActiveSession(typedPayload.sessionId);
      navigate(ROUTES.chatPath(typedPayload.sessionId));
    });

    return () => {
      unsubscribe();
    };
  }, [navigate, setActiveSession]);
}

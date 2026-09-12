// src/main/ipc/browser.handler.ts
// 浏览器预览域 handler：请求转发到 BrowserPreviewService（ServiceContainer 持有）
// ──────────────────────────────────────────────────────────────
// browser:navigate / back / forward / reload —— 页面导航
// browser:setViewport —— 渲染层视口几何同步（高频 invoke）
// browser:configure —— 严格沙箱切换（重建视图）
// browser:getState —— 地址栏/导航按钮状态
// 事件推送（browser:event:state / loadFailed）由服务内 webContents 事件
// 统一收敛后广播，handler 不参与
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IBrowserPreviewService } from '../infra/browser/preview-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** Browser 域 handler 依赖 */
export interface BrowserHandlerDeps {
  /** 浏览器预览服务（由 ServiceContainer 注入） */
  readonly browserPreviewService: IBrowserPreviewService;
}

/** browser 域 handler 实现（导航/视口/配置/状态查询） */
export function createBrowserHandlers(
  deps: BrowserHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['browser'] {
  const { browserPreviewService: svc } = deps;
  return {
    // browser:navigate - 加载 URL（zod 契约已限 http/https）
    navigate: async (input) => {
      return svc.navigate(input);
    },
    // browser:back - 历史后退（无视图时幂等 no-op）
    back: async () => {
      return svc.back();
    },
    // browser:forward - 历史前进
    forward: async () => {
      return svc.forward();
    },
    // browser:reload - 重新加载
    reload: async () => {
      return svc.reload();
    },
    // browser:setViewport - 视口几何同步（rect=null/visible=false 仅隐藏保活）
    setViewport: async (input) => {
      return svc.setViewport(input);
    },
    // browser:configure - 严格沙箱切换（值变化时重建视图并回放 URL/几何）
    configure: async (input) => {
      return svc.configure(input);
    },
    // browser:getState - 当前预览状态（挂载时拉一次初值，此后走事件推送）
    getState: async () => {
      return svc.getState();
    },
  };
}

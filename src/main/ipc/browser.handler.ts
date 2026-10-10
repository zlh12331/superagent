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
    navigate: async (input) => {
      return svc.navigate(input);
    },
    back: async () => {
      return svc.back();
    },
    forward: async () => {
      return svc.forward();
    },
    reload: async () => {
      return svc.reload();
    },
    setViewport: async (input) => {
      return svc.setViewport(input);
    },
    configure: async (input) => {
      return svc.configure(input);
    },
    getState: async () => {
      return svc.getState();
    },
  };
}

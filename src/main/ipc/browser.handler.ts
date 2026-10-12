// browser.handler.ts：browser 域 IPC——右面板网页预览的导航/视口/配置（WebContentsView 承载，非 iframe）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IBrowserPreviewService } from '../infra/browser/preview-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：index.ts 传入 browserPreviewService */
export interface BrowserHandlerDeps {
  readonly browserPreviewService: IBrowserPreviewService;
}

/** 依赖注入工厂（全部方法透传） */
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

// src/main/ipc/update.handler.ts
// Update 域 IPC handler（UpdateService 暴露给渲染层的入口，定义表驱动）
//
// 实现 4 个请求-响应方法：
// - check     触发更新检查（manual=true 时错误会推送事件提示）
// - install   安装已下载的更新并重启（update-downloaded 事件后由渲染层触发）
// - cancel    取消在途下载（幂等；结果经 update-cancelled 事件推送）
// - getStatus 读取主进程状态快照（渲染层重载后恢复界面，不触发事件语义）
//
// 流式事件由 UpdateService 主动推送（不在此 handler 返回）：
// - update:event:status：检查/下载进度/就绪/错误状态
//
// 设计要点：
// - DI 模式：通过 deps 注入 IUpdateService 实例（ServiceContainer 持有）
// - 事件推送统一走 UpdateService.emit（广播所有窗口），handler 只做请求转发

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IUpdateService } from '../infra/update/update-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** Update 域 handler 依赖 */
export interface UpdateHandlerDeps {
  /** 自动更新服务（由 ServiceContainer 注入） */
  readonly updateService: IUpdateService;
}

/** update 域 handler 实现（check + install + cancel + getStatus） */
export function createUpdateHandlers(
  deps: UpdateHandlerDeps,
): Pick<
  InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['update'],
  'check' | 'install' | 'cancel' | 'getStatus'
> {
  return {
    // update:check - 触发更新检查（manual=true 时失败会推送 error 事件）
    check: async (input) => {
      return deps.updateService.check(input.manual ?? false);
    },
    // update:install - 安装已下载更新并重启（update-downloaded 事件后调用）
    install: async () => {
      deps.updateService.quitAndInstall();
      return { ok: true };
    },
    // update:cancel - 取消在途下载（无在途下载时空操作，幂等）
    cancel: async () => {
      deps.updateService.cancelDownload();
      return { ok: true };
    },
    // update:getStatus - 状态快照与上次检查时间（渲染层挂载时读取，避免重载后界面状态丢失）
    getStatus: async () => {
      return deps.updateService.getStatus();
    },
  };
}

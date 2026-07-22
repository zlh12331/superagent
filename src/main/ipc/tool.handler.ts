// src/main/ipc/tool.handler.ts
// 工具域 IPC handler（ToolRegistry 暴露给渲染层的入口）
//
// 注册 1 个请求-响应 channel：
// - tool:list  列出当前已注册的工具清单（含权限级别，供渲染层展示工具面板）
//
// 设计要点：
// - 与 chat.handler.ts / file.handler.ts 一致的 DI 模式
// - 入参 zod schema 来自 @novel-writer/shared，handler 不内联定义
// - 工具元数据（ToolDescriptor）由 ToolRegistry.list() 返回，handler 仅做转发
// - 渲染层启动时调用一次 tool:list，获取可用工具列表展示工具面板
// - 后续可通过 tool:added / tool:removed 事件增量更新（当前阶段不实现）

import {
  IPC_CHANNELS,
  type ToolListReq,
  ToolListReqSchema,
  type ToolListRes,
} from '@novel-writer/shared';
import type { IToolRegistry } from '../infra/ai/tool-registry';
import { wrap } from '../utils/wrap';

/**
 * 工具域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 ToolRegistry 实现：
 * - 生产环境：ServiceContainer 注入默认 ToolRegistry 实例（已注册内置工具）
 * - 测试环境：可注入 mock 实现，不依赖真实工具注册
 */
export interface ToolHandlerDeps {
  /** ToolRegistry 实例（由 ServiceContainer 注入） */
  readonly toolRegistry: IToolRegistry;
}

/**
 * 注册工具域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerFileHandlers / registerSearchHandlers 并列。
 *
 * @param deps 依赖项：包含 IToolRegistry 实例
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerToolHandlers(deps: ToolHandlerDeps): void {
  const { toolRegistry } = deps;

  // 列出工具清单：渲染层启动时调用一次，展示工具面板
  // permission 过滤可选：省略列出全部工具，传 'auto' / 'ask' 仅列出对应权限的工具
  // 返回 tools 数组（按 name 字母序排序，由 ToolRegistry.list 保证）
  wrap<ToolListReq, ToolListRes>(IPC_CHANNELS.TOOL_LIST, ToolListReqSchema, async (input) => {
    const tools = toolRegistry.list(input.permission);
    return { tools };
  });
}

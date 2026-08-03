// src/main/ipc/codebase.handler.ts
// Codebase 域 IPC handler：codegraph 查询通道（定义表驱动）
//
// 职责：
// - 实现 6 个 codebase:* 请求-响应方法
// - 把 IPC 调用委托给 CodebaseService
//
// 设计：
// - 与 GitService / FileService 一致的 DI 模式
// - CodebaseHandlerDeps 接口声明依赖，便于测试 mock
// - 不持有状态，所有调用转发给 CodebaseService

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ICodebaseService } from '../infra/codebase/codebase-service';
import type { IpcHandlerContext } from '../utils/wrap';

export interface CodebaseHandlerDeps {
  readonly codebaseService: ICodebaseService;
}

/**
 * 创建 Codebase 域 handler 实现
 *
 * 6 个方法对应 codegraph CLI 的 6 个子命令：
 * - query   → codegraph query（结构化符号搜索，--json）
 * - explore → codegraph explore（区域探索，markdown 输出）
 * - node    → codegraph node（符号详情或文件内容，markdown 输出）
 * - callers → codegraph callers（调用方查询，markdown 输出）
 * - callees → codegraph callees（被调用方查询，markdown 输出）
 * - impact  → codegraph impact（影响分析，markdown 输出）
 */
export function createCodebaseHandlers(
  deps: CodebaseHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['codebase'] {
  const { codebaseService } = deps;

  return {
    // codebase:query - 结构化符号搜索
    query: async (input) => {
      return codebaseService.query({
        path: input.path,
        search: input.search,
        limit: input.limit,
        kind: input.kind,
      });
    },

    // codebase:explore - 区域探索
    explore: async (input) => {
      return codebaseService.explore({
        path: input.path,
        query: input.query,
        maxFiles: input.maxFiles,
      });
    },

    // codebase:node - 符号详情或文件内容
    node: async (input) => {
      return codebaseService.node({
        path: input.path,
        name: input.name,
        file: input.file,
        offset: input.offset,
        limit: input.limit,
        symbolsOnly: input.symbolsOnly,
      });
    },

    // codebase:callers - 调用方查询
    callers: async (input) => {
      return codebaseService.callers({
        path: input.path,
        symbol: input.symbol,
        limit: input.limit,
      });
    },

    // codebase:callees - 被调用方查询
    callees: async (input) => {
      return codebaseService.callees({
        path: input.path,
        symbol: input.symbol,
        limit: input.limit,
      });
    },

    // codebase:impact - 影响分析
    impact: async (input) => {
      return codebaseService.impact({
        path: input.path,
        symbol: input.symbol,
        depth: input.depth,
      });
    },
  };
}

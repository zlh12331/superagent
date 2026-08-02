// src/main/ipc/codebase.handler.ts
// Codebase 域 IPC handler：注册 codegraph 查询通道
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注册 6 个 codebase:* 请求-响应 channel
// - 入参用 zod schema 校验，出参类型由 Res 接口保证
// - 把 IPC 调用委托给 CodebaseService
//
// 设计：
// - 与 GitService / FileService 一致的 DI 模式
// - CodebaseHandlerDeps 接口声明依赖，便于测试 mock
// - 不持有状态，所有调用转发给 CodebaseService
// ──────────────────────────────────────────────────────────────

import {
  type CodebaseCalleesReq,
  CodebaseCalleesReqSchema,
  type CodebaseCalleesRes,
  type CodebaseCallersReq,
  CodebaseCallersReqSchema,
  type CodebaseCallersRes,
  type CodebaseExploreReq,
  CodebaseExploreReqSchema,
  type CodebaseExploreRes,
  type CodebaseImpactReq,
  CodebaseImpactReqSchema,
  type CodebaseImpactRes,
  type CodebaseNodeReq,
  CodebaseNodeReqSchema,
  type CodebaseNodeRes,
  type CodebaseQueryReq,
  CodebaseQueryReqSchema,
  type CodebaseQueryRes,
  IPC_CHANNELS,
} from '@code-agent/shared';
import type { ICodebaseService } from '../infra/codebase/codebase-service';
import { wrap } from '../utils/wrap';

export interface CodebaseHandlerDeps {
  readonly codebaseService: ICodebaseService;
}

/**
 * 注册 Codebase 域 IPC handler
 *
 * 6 个 channel 对应 codegraph CLI 的 6 个子命令：
 * - codebase:query   → codegraph query（结构化符号搜索，--json）
 * - codebase:explore → codegraph explore（区域探索，markdown 输出）
 * - codebase:node    → codegraph node（符号详情或文件内容，markdown 输出）
 * - codebase:callers → codegraph callers（调用方查询，markdown 输出）
 * - codebase:callees → codegraph callees（被调用方查询，markdown 输出）
 * - codebase:impact  → codegraph impact（影响分析，markdown 输出）
 */
export function registerCodebaseHandlers(deps: CodebaseHandlerDeps): void {
  const { codebaseService } = deps;

  // codebase:query - 结构化符号搜索
  wrap<CodebaseQueryReq, CodebaseQueryRes>(
    IPC_CHANNELS.CODEBASE_QUERY,
    CodebaseQueryReqSchema,
    async (input) => {
      return codebaseService.query({
        path: input.path,
        search: input.search,
        limit: input.limit,
        kind: input.kind,
      });
    },
  );

  // codebase:explore - 区域探索
  wrap<CodebaseExploreReq, CodebaseExploreRes>(
    IPC_CHANNELS.CODEBASE_EXPLORE,
    CodebaseExploreReqSchema,
    async (input) => {
      return codebaseService.explore({
        path: input.path,
        query: input.query,
        maxFiles: input.maxFiles,
      });
    },
  );

  // codebase:node - 符号详情或文件内容
  wrap<CodebaseNodeReq, CodebaseNodeRes>(
    IPC_CHANNELS.CODEBASE_NODE,
    CodebaseNodeReqSchema,
    async (input) => {
      return codebaseService.node({
        path: input.path,
        name: input.name,
        file: input.file,
        offset: input.offset,
        limit: input.limit,
        symbolsOnly: input.symbolsOnly,
      });
    },
  );

  // codebase:callers - 调用方查询
  wrap<CodebaseCallersReq, CodebaseCallersRes>(
    IPC_CHANNELS.CODEBASE_CALLERS,
    CodebaseCallersReqSchema,
    async (input) => {
      return codebaseService.callers({
        path: input.path,
        symbol: input.symbol,
        limit: input.limit,
      });
    },
  );

  // codebase:callees - 被调用方查询
  wrap<CodebaseCalleesReq, CodebaseCalleesRes>(
    IPC_CHANNELS.CODEBASE_CALLEES,
    CodebaseCalleesReqSchema,
    async (input) => {
      return codebaseService.callees({
        path: input.path,
        symbol: input.symbol,
        limit: input.limit,
      });
    },
  );

  // codebase:impact - 影响分析
  wrap<CodebaseImpactReq, CodebaseImpactRes>(
    IPC_CHANNELS.CODEBASE_IMPACT,
    CodebaseImpactReqSchema,
    async (input) => {
      return codebaseService.impact({
        path: input.path,
        symbol: input.symbol,
        depth: input.depth,
      });
    },
  );
}

// src/main/ipc/search.handler.ts
// 搜索域 IPC handler（SearchService 暴露给渲染层的入口）
//
// 注册 2 个请求-响应 channel：
// - search:grep  在文件内容中搜索匹配（基于 ripgrep --json）
// - search:glob  按 glob 模式匹配文件路径（基于 ripgrep --files）
//
// 设计要点：
// - 与 chat.handler.ts / file.handler.ts 一致的 DI 模式
// - 入参 zod schema 来自 @novel-writer/shared，handler 不内联定义
// - search 是短任务（spawn 子进程 → 读取 stdout → 子进程退出），
//   不需要像 file:watch 那样管理长期状态，handler 直接转发即可
// - maxResults 默认值由 schema 提供（grep 默认 100，glob 默认 1000），
//   handler 不再硬编码默认值，保证 schema 单一真源

import {
  type GlobReq,
  GlobReqSchema,
  type GlobRes,
  type GrepReq,
  GrepReqSchema,
  type GrepRes,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import type { ISearchService } from '../infra/search/search-service';
import { wrap } from '../utils/wrap';

/**
 * 搜索域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 SearchService 实现：
 * - 生产环境：ServiceContainer 注入默认 SearchService 实例
 * - 测试环境：可注入 mock 实现，不依赖真实 ripgrep 子进程
 */
export interface SearchHandlerDeps {
  /** SearchService 实例（由 ServiceContainer 注入） */
  readonly searchService: ISearchService;
}

/**
 * 注册搜索域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerFileHandlers 并列。
 *
 * @param deps 依赖项：包含 ISearchService 实例
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerSearchHandlers(deps: SearchHandlerDeps): void {
  const { searchService } = deps;

  // 内容搜索：基于 ripgrep --json 输出
  // 支持正则 / 字面量两种模式（isRegex 控制）
  // include/exclude 为文件名 glob 过滤，等价于 ripgrep 的 -g 参数
  // 返回 matches 数组（含前后 2 行 context）+ truncated 标志
  wrap<GrepReq, GrepRes>(IPC_CHANNELS.SEARCH_GREP, GrepReqSchema, async (input) => {
    return searchService.grep({
      pattern: input.pattern,
      paths: input.paths,
      caseSensitive: input.caseSensitive,
      isRegex: input.isRegex,
      include: input.include,
      exclude: input.exclude,
      maxResults: input.maxResults,
    });
  });

  // 文件路径匹配：基于 ripgrep --files 输出
  // 用于"按文件名查找"场景（不读取文件内容）
  // includeHidden=true 时包含隐藏文件（默认 ripgrep 跳过 .gitignore / 隐藏文件）
  // 返回 files 数组（绝对路径）+ truncated 标志
  wrap<GlobReq, GlobRes>(IPC_CHANNELS.SEARCH_GLOB, GlobReqSchema, async (input) => {
    return searchService.glob({
      pattern: input.pattern,
      path: input.path,
      includeHidden: input.includeHidden,
      maxResults: input.maxResults,
    });
  });
}

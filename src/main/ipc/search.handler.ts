// src/main/ipc/search.handler.ts
// 搜索域 IPC handler（SearchService 暴露给渲染层的入口，定义表驱动）
//
// 实现 2 个请求-响应方法：
// - grep  在文件内容中搜索匹配（基于 ripgrep --json）
// - glob  按 glob 模式匹配文件路径（基于 ripgrep --files）
//
// 设计要点：
// - DI 模式：通过 deps 注入 ISearchService 实例
// - search 是短任务（spawn 子进程 → 读取 stdout → 子进程退出），
//   不需要像 file:watch 那样管理长期状态，handler 直接转发即可
// - maxResults 默认值由 schema 提供（grep 默认 100，glob 默认 1000），
//    handler 不再硬编码默认值，保证 schema 单一真源
// - **路径收口（2026-09-08 安全修复）**：所有 path/paths 经
//   resolveWithinWorkspace 校验，与 file.handler / grep.tool / glob.tool 一致。
//   此前 handler 直接透传给 ripgrep，渲染层可越界读取任意目录内容。
//   注意：workingDir 来自 ctx（会话工作目录），无会话时回退进程 cwd。

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ISearchService } from '../infra/search/search-service';
import type { IpcHandlerContext } from '../utils/wrap';
import { confineToWorkspace, defaultWorkspaceRoots } from './file.handler';

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
  /**
   * 可选：工作区根集合提供者（边界来源）
   *
   * 缺省实现读取会话 workingDir 集合（与 file.handler 同源）；
   * 测试可注入自定义实现。返回绝对路径数组。
   */
  readonly workspaceRoots?: () => Promise<readonly string[]>;
}

/**
 * 创建搜索域 handler 实现
 *
 * @param deps 依赖项：包含 ISearchService 实例
 */
export function createSearchHandlers(
  deps: SearchHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['search'] {
  const { searchService } = deps;
  const rootsProvider = deps.workspaceRoots ?? defaultWorkspaceRoots;

  return {
    // 内容搜索：基于 ripgrep --json 输出
    // 支持正则 / 字面量两种模式（isRegex 控制）
    // include/exclude 为文件名 glob 过滤，等价于 ripgrep 的 -g 参数
    // 返回 matches 数组（含前后 2 行 context）+ truncated 标志
    grep: async (input) => {
      // 路径收口：任一越界即拒绝（与 file.handler 同一守卫，fail closed）
      const paths: string[] = [];
      for (const p of input.paths) {
        paths.push(await confineToWorkspace(p, rootsProvider));
      }
      return searchService.grep({
        pattern: input.pattern,
        paths,
        caseSensitive: input.caseSensitive,
        isRegex: input.isRegex,
        include: input.include,
        exclude: input.exclude,
        maxResults: input.maxResults,
      });
    },

    // 文件路径匹配：基于 ripgrep --files 输出
    // 用于"按文件名查找"场景（不读取文件内容）
    // includeHidden=true 时包含隐藏文件（默认 ripgrep 跳过 .gitignore / 隐藏文件）
    // 返回 files 数组（绝对路径）+ truncated 标志
    glob: async (input) => {
      const path = await confineToWorkspace(input.path, rootsProvider);
      return searchService.glob({
        pattern: input.pattern,
        path,
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
      });
    },
  };
}

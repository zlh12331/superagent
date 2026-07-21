// src/main/infra/agent/tools/index.ts
// 工具系统 barrel 导出：统一注册入口与工具工厂函数
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 5 个工具工厂函数（createReadFileTool / createWriteFileTool / ...）
// - 导出 registerBuiltinTools：将所有内置工具注册到 ToolRegistry
// - 导出 path-guard 供其他模块复用路径安全检查
//
// 设计原则：
// - 工厂模式：每个工具通过工厂函数创建，注入 IFileService / ISearchService 依赖
// - 单一注册入口：ServiceContainer 调用 registerBuiltinTools 一次完成所有注册
// - 开闭原则：新增工具只需添加文件并在 registerBuiltinTools 中追加注册
// ──────────────────────────────────────────────────────────────

import type { IFileService } from '../../file/file-service';
import type { ISearchService } from '../../search/search-service';
import type { IToolRegistry } from '../tool-registry';
import { createGlobTool } from './glob.tool';
import { createGrepTool } from './grep.tool';
import { createListDirectoryTool } from './list-directory.tool';
import { createReadFileTool } from './read-file.tool';
import { createWriteFileTool } from './write-file.tool';

export { createGlobTool } from './glob.tool';
export { createGrepTool } from './grep.tool';
export { createListDirectoryTool } from './list-directory.tool';
// 重新导出路径守卫，供其他工具复用
export { resolveWithinWorkspace } from './path-guard';
// 重新导出工具工厂函数，供外部按需使用
export { createReadFileTool } from './read-file.tool';
export { createWriteFileTool } from './write-file.tool';

/**
 * 注册所有内置工具到 ToolRegistry
 *
 * ServiceContainer 在初始化时调用一次，把 5 个内置工具全部注册：
 * - read_file / write_file / list_directory（依赖 IFileService）
 * - grep / glob（依赖 ISearchService）
 *
 * 工具列表（按注册顺序，与 ToolRegistry.list 返回的字母序无关）：
 * | 工具名           | 权限  | 依赖            |
 * |-----------------|-------|----------------|
 * | read_file       | auto  | IFileService   |
 * | write_file      | ask   | IFileService   |
 * | list_directory  | auto  | IFileService   |
 * | grep            | auto  | ISearchService |
 * | glob            | auto  | ISearchService |
 *
 * @param registry 工具注册表
 * @param fileService 文件服务实例
 * @param searchService 搜索服务实例
 */
export function registerBuiltinTools(
  registry: IToolRegistry,
  fileService: IFileService,
  searchService: ISearchService,
): void {
  registry.register(createReadFileTool(fileService));
  registry.register(createWriteFileTool(fileService));
  registry.register(createListDirectoryTool(fileService));
  registry.register(createGrepTool(searchService));
  registry.register(createGlobTool(searchService));
}

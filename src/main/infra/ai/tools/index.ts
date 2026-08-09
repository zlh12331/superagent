// src/main/infra/ai/tools/index.ts
// 工具系统 barrel 导出：统一注册入口与工具工厂函数
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 7 个工具工厂函数（createReadFileTool / createWriteFileTool / ...）
// - 导出 registerBuiltinTools：将所有内置工具注册到 ToolRegistry
// - 导出 path-guard 供其他模块复用路径安全检查
//
// 设计原则：
// - 工厂模式：每个工具通过工厂函数创建，注入 IFileService / ISearchService 依赖
// - 单一注册入口：ServiceContainer 调用 registerBuiltinTools 一次完成所有注册
// - 开闭原则：新增工具只需添加文件并在 registerBuiltinTools 中追加注册
// ──────────────────────────────────────────────────────────────

import type { IFileService } from '../../file/file-service';
import type { IGitService } from '../../git/git-service';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import type { ISearchService } from '../../search/search-service';
import type { ITerminalService } from '../../terminal/terminal-service';
import type { AgentAskService } from '../agent/agent-ask-service';
import type { MemoryService } from '../knowledge/memory-service';
import { skillRegistry } from '../skills/skill-registry';
import { createAskUserQuestionTool } from './ask-user-question.tool';
import { createCodeReviewTool } from './code-review.tool';
import { createCronCreateTool } from './cron-create.tool';
import { createCronDeleteTool } from './cron-delete.tool';
import { createCronListTool } from './cron-list.tool';
import { createEditFileTool } from './edit-file.tool';
import { createGitAddTool } from './git-add.tool';
import { createGitCommitTool } from './git-commit.tool';
import { createGitPushTool } from './git-push.tool';
import { createGlobTool } from './glob.tool';
import { createGrepTool } from './grep.tool';
import { createListDirectoryTool } from './list-directory.tool';
import { createLoadSkillTool } from './load-skill.tool';
import { createLspDefinitionTool } from './lsp-definition.tool';
import { createLspReferencesTool } from './lsp-references.tool';
import type { IPermissionService } from './permission-service';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-mode.tools';
import { createReadFileTool } from './read-file.tool';
import { createRunCommandTool } from './run-command.tool';
import { createRunSubagentTool } from './run-subagent.tool';
import { createRunTeamTool } from './run-team.tool';
import { createSaveMemoryTool } from './save-memory.tool';
import { createTaskCreateTool } from './task-create.tool';
import { createTaskListTool } from './task-list.tool';
import { createTaskStopTool } from './task-stop.tool';
import { createTaskUpdateTool } from './task-update.tool';
import { createTerminalTool } from './terminal.tool';
import type { IToolRegistry } from './tool-registry';
import { createWebFetchTool } from './web-fetch.tool';
import { createWriteFileTool } from './write-file.tool';

export { createCodeReviewTool } from './code-review.tool';
export { createEditFileTool } from './edit-file.tool';
export { createGitAddTool } from './git-add.tool';
export { createGitCommitTool } from './git-commit.tool';
export { createGitPushTool } from './git-push.tool';
export { createGlobTool } from './glob.tool';
export { createGrepTool } from './grep.tool';
export { createListDirectoryTool } from './list-directory.tool';
// 重新导出路径守卫，供其他工具复用
export { resolveWithinWorkspace } from './path-guard';
// 重新导出工具工厂函数，供外部按需使用
export { createReadFileTool } from './read-file.tool';
export { createRunCommandTool } from './run-command.tool';
export { createTerminalTool } from './terminal.tool';
export { createWriteFileTool } from './write-file.tool';

/**
 * 注册所有内置工具到 ToolRegistry
 *
 * ServiceContainer 在初始化时调用一次，把 12 个内置工具全部注册：
 * - read_file / write_file / list_directory / code_review（依赖 IFileService）
 * - grep / glob（依赖 ISearchService）
 * - terminal（依赖 ITerminalService）
 * - run_command / edit_file（无外部依赖）
 * - git_add / git_commit / git_push（依赖 IGitService，写操作 permission='ask'）
 *
 * 工具列表（按注册顺序，与 ToolRegistry.list 返回的字母序无关）：
 * | 工具名           | 权限  | 依赖            |
 * |-----------------|-------|----------------|
 * | read_file       | auto  | IFileService   |
 * | write_file      | ask   | IFileService   |
 * | list_directory  | auto  | IFileService   |
 * | code_review     | auto  | IFileService   |
 * | grep            | auto  | ISearchService |
 * | glob            | auto  | ISearchService |
 * | terminal        | ask   | ITerminalService |
 * | run_command     | ask   | 无             |
 * | edit_file       | ask   | 无             |
 * | git_add         | ask   | IGitService    |
 * | git_commit      | ask   | IGitService    |
 * | git_push        | ask   | IGitService    |
 *
 * @param registry 工具注册表
 * @param fileService 文件服务实例
 * @param searchService 搜索服务实例
 * @param terminalService 终端服务实例
 * @param gitService Git 服务实例
 */
export function registerBuiltinTools(
  registry: IToolRegistry,
  fileService: IFileService,
  searchService: ISearchService,
  terminalService: ITerminalService,
  gitService: IGitService,
  memoryService: MemoryService,
  lspManager: LspServerManager,
  askService: AgentAskService,
  permissionService: IPermissionService,
): void {
  registry.register(createReadFileTool(fileService));
  registry.register(createAskUserQuestionTool(askService));
  registry.register(createEnterPlanModeTool(permissionService));
  registry.register(createExitPlanModeTool(permissionService));
  registry.register(createWriteFileTool(fileService));
  registry.register(createListDirectoryTool(fileService));
  registry.register(createCodeReviewTool(fileService));
  registry.register(createGrepTool(searchService));
  registry.register(createGlobTool(searchService));
  registry.register(createTerminalTool(terminalService));
  registry.register(createRunCommandTool());
  registry.register(createEditFileTool());
  registry.register(createGitAddTool(gitService));
  registry.register(createGitCommitTool(gitService));
  registry.register(createGitPushTool(gitService));
  // 技能加载工具（模型按名加载技能提示词；只读自动放行）
  registry.register(createLoadSkillTool(skillRegistry));
  // 子代理委派工具（任务分解与并行执行）
  registry.register(createRunSubagentTool());
  // 团队协作工具（多代理并行委派）
  registry.register(createRunTeamTool());
  // 任务跟踪工具（任务面板登记/状态机/列表）
  registry.register(createTaskCreateTool());
  registry.register(createTaskUpdateTool());
  registry.register(createTaskStopTool());
  registry.register(createTaskListTool());
  // 网页抓取工具（资料查阅）
  registry.register(createWebFetchTool());
  // 记忆主动存储工具
  registry.register(createSaveMemoryTool(memoryService));
  // 定时任务工具（cron 表达式调度）
  registry.register(createCronCreateTool());
  registry.register(createCronListTool());
  registry.register(createCronDeleteTool());
  // 代码智能工具（LSP 定义/引用；只读自动放行）
  registry.register(createLspDefinitionTool(lspManager));
  registry.register(createLspReferencesTool(lspManager));
}

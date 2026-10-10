import type { ICodebaseService } from '../../codebase/codebase-service';
import type { IFileService } from '../../file/file-service';
import type { IGitService } from '../../git/git-service';
import type { LspServerManager } from '../../lsp/lsp-server-manager';
import type { MemoryPort } from '../../memory-hub/types';
import type { ISearchService } from '../../search/search-service';
import type { ITerminalService } from '../../terminal/terminal-service';
import type { AgentAskService } from '../agent/agent-ask-service';
import { skillRegistry } from '../skills/skill-registry';
import { createAskUserQuestionTool } from './ask-user-question.tool';
import { createCodeReviewTool } from './code-review.tool';
import { createCodeSymbolsTool } from './code-symbols.tool';
import { createCodebaseTool } from './codebase.tool';
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
import { createLspHoverTool } from './lsp-hover.tool';
import { createLspReferencesTool } from './lsp-references.tool';
import type { IPermissionService } from './permission-service';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-mode.tools';
import { createReadFileTool } from './read-file.tool';
import { createRecallMemoryTool } from './recall-memory.tool';
import { createRunCommandTool } from './run-command.tool';
import { createRunSubagentTool } from './run-subagent.tool';
import { createRunTeamTool } from './run-team.tool';
import { createRunWorkflowTool } from './run-workflow.tool';
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
export { resolveWithinWorkspace } from './path-guard';
export { createReadFileTool } from './read-file.tool';
export { createRunCommandTool } from './run-command.tool';
export { createTerminalTool } from './terminal.tool';
export { createWriteFileTool } from './write-file.tool';

/**
 * 注册所有内置工具到 ToolRegistry
 *
 * ServiceContainer 在初始化时调用一次，把全部内置工具注册：
 * - 文件/搜索/终端/命令/Git 基础工具（依赖注入对应服务）
 * - 交互与模式工具（ask_user_question / plan_mode，注入 askService / permissionService）
 * - 编排工具（run_subagent / run_team / run_workflow / task×4，模块级单例）
 * - 扩展工具（load_skill / web_fetch / save_memory / cron×3 / lsp×2）
 *
 * @param registry 工具注册表
 * @param fileService 文件服务实例
 * @param searchService 搜索服务实例
 * @param terminalService 终端服务实例
 * @param gitService Git 服务实例
 * @param memoryPort 记忆引擎端口（MemoryHub）
 * @param lspManager LSP 服务器管理器
 * @param askService Agent 提问服务
 * @param permissionService 权限服务（plan 模式拦截）
 */
export function registerBuiltinTools(
  registry: IToolRegistry,
  fileService: IFileService,
  searchService: ISearchService,
  terminalService: ITerminalService,
  gitService: IGitService,
  memoryPort: MemoryPort,
  lspManager: LspServerManager,
  askService: AgentAskService,
  permissionService: IPermissionService,
  codebaseService: ICodebaseService,
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
  registry.register(createLoadSkillTool(skillRegistry));
  registry.register(createRunSubagentTool());
  registry.register(createRunTeamTool());
  registry.register(createRunWorkflowTool());
  registry.register(createTaskCreateTool());
  registry.register(createTaskUpdateTool());
  registry.register(createTaskStopTool());
  registry.register(createTaskListTool());
  registry.register(createWebFetchTool());
  registry.register(createSaveMemoryTool(memoryPort));
  registry.register(createRecallMemoryTool(memoryPort));
  registry.register(createCronCreateTool());
  registry.register(createCronListTool());
  registry.register(createCronDeleteTool());
  registry.register(createLspDefinitionTool(lspManager));
  registry.register(createLspReferencesTool(lspManager));
  registry.register(createLspHoverTool(lspManager));
  registry.register(createCodebaseTool(codebaseService));
  registry.register(createCodeSymbolsTool());
}

// index.ts：内置工具注册入口——registerBuiltinTools 把全部工具装进注册表
//（容器构造 ToolRegistry 时调用；新增工具：写 *.tool.ts + 此处 import + register）
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

// src/main/infra/ai/prompt/index.ts
// Prompt 模块 barrel export
// ──────────────────────────────────────────────────────────────

export {
  discoverAgentsMd,
  type FoundAgentsMd,
  formatAgentsMdSection,
  resolveAgentsMd,
} from './agents-md';
export { DEFAULT_CODE_AGENT_PROMPT } from './default-prompt';
export {
  type DynamicContextOptions,
  type GitSummaryProvider,
  injectDynamicContext,
} from './dynamic-context';
export { createGitSummaryProvider } from './git-adapter';
export {
  DEFAULT_CODE_AGENT_PROMPT_ID,
  type IPromptService,
  PromptService,
  type PromptServiceOptions,
  type ResolvedPrompt,
} from './prompt-service';

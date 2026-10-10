// packages/core/src/permissions/destructive-commands.ts（Copyright 2025 Qwen Team，
// SPDX-License-Identifier: Apache-2.0）的 DESTRUCTIVE_GIT_PATTERNS /

/**
 * 危险命令检测结果
 */
export interface DangerousCommandDecision {
  /** 是否破坏性命令（auto 模式下必须 ask） */
  readonly isDangerous: boolean;
  /** 危险类别（git-destructive / iac-destroy / none） */
  readonly category: 'git-destructive' | 'iac-destroy' | 'none';
  /** 判定说明（审批展示用） */
  readonly reason: string;
}

/**
 * 破坏性 git 命令：丢弃本地工作（借鉴 qwen destructive-commands.ts）
 * 用户显式提及 discard/wipe 等意图词时不拦截（用户意图优先）
 */
const DESTRUCTIVE_GIT_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+stash\s+drop\b/,
]);

/**
 * IaC 销毁命令：拆除基础设施（借鉴 qwen destructive-commands.ts）
 */
const IAC_DESTROY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bterraform\s+destroy\b/,
  /\bpulumi\s+destroy\b/,
  /\bcdk\s+destroy\b/,
]);

/**
 * 用户显式意图关键词：提及即视为有意丢弃工作（借鉴 qwen DISCARD_KEYWORDS）
 */
const DISCARD_KEYWORDS: readonly RegExp[] = Object.freeze([
  /\bdiscard\b/i,
  /\bthrow\s+away\b/i,
  /\bwipe\b/i,
  /\breset\s+my\s+changes\b/i,
  /\bundo\s+all\s+my\s+changes\b/i,
]);

/**
 * 只读安全命令白名单（auto 模式自动放行；对齐 qwen AUTO 分类器安全命令收敛）
 *
 * 只覆盖最常见的确定性安全命令；其余命令保持 ask（保守默认）。
 */
const SAFE_READ_ONLY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^(?:ls|dir|pwd|whoami|hostname|date|echo|cat|head|tail|less|more|wc)\b/,
  /^git\s+(?:status|log|diff|show|branch|remote\s+-v)\b/,
  /^(?:pnpm|npm|yarn)\s+(?:list|view|info)\b/,
]);

/**
 * 检测命令是否破坏性（确定性 Layer-0 守卫，不可被分类器失败绕过）
 *
 * @param command 待检测命令（run_command 工具的 input.command）
 * @param userPrompt 用户原始 prompt（显式意图关键词豁免）
 * @returns 检测决策（isDangerous + 类别 + 说明）
 */
export function detectDangerousCommand(
  command: string,
  userPrompt?: string,
): DangerousCommandDecision {
  const hasDiscardIntent =
    userPrompt !== undefined && DISCARD_KEYWORDS.some((pattern) => pattern.test(userPrompt));

  if (!hasDiscardIntent) {
    for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
      if (pattern.test(command)) {
        return {
          isDangerous: true,
          category: 'git-destructive',
          reason: '破坏性 git 命令（丢弃本地工作）',
        };
      }
    }
    for (const pattern of IAC_DESTROY_PATTERNS) {
      if (pattern.test(command)) {
        return {
          isDangerous: true,
          category: 'iac-destroy',
          reason: 'IaC 销毁命令（拆除基础设施）',
        };
      }
    }
  }

  return { isDangerous: false, category: 'none', reason: '' };
}

/**
 * 命令是否只读安全（auto 模式自动放行）
 */
export function isSafeReadOnlyCommand(command: string): boolean {
  return SAFE_READ_ONLY_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

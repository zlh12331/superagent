export interface DangerousCommandDecision {
  readonly isDangerous: boolean;
  readonly category: 'git-destructive' | 'iac-destroy' | 'none';
  readonly reason: string;
}

const DESTRUCTIVE_GIT_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+stash\s+drop\b/,
]);

const IAC_DESTROY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bterraform\s+destroy\b/,
  /\bpulumi\s+destroy\b/,
  /\bcdk\s+destroy\b/,
]);

const DISCARD_KEYWORDS: readonly RegExp[] = Object.freeze([
  /\bdiscard\b/i,
  /\bthrow\s+away\b/i,
  /\bwipe\b/i,
  /\breset\s+my\s+changes\b/i,
  /\bundo\s+all\s+my\s+changes\b/i,
]);

const SAFE_READ_ONLY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^(?:ls|dir|pwd|whoami|hostname|date|echo|cat|head|tail|less|more|wc)\b/,
  /^git\s+(?:status|log|diff|show|branch|remote\s+-v)\b/,
  /^(?:pnpm|npm|yarn)\s+(?:list|view|info)\b/,
]);

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

export function isSafeReadOnlyCommand(command: string): boolean {
  return SAFE_READ_ONLY_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

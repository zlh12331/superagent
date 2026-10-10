// ls-config.ts：语言服务器配置——内置四语言启动规格 + 扩展名映射 + 用户覆盖解析（纯函数）
export interface LsServerSpec {
  readonly command: string;
  readonly args: readonly string[];
}

// JS 系全走 typescript-language-server（它同时服务 js/jsx——不单列 javascript）
export const SUPPORTED_LS_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;
export type LsLanguage = (typeof SUPPORTED_LS_LANGUAGES)[number];

// 内置规格 = PATH 里可执行的标准 LSP 命令（用户机器须自备；不在则该语言 LSP 能力降级）
const BUILTIN_SERVERS: Readonly<Record<LsLanguage, LsServerSpec>> = {
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  go: { command: 'gopls', args: [] },
  rust: { command: 'rust-analyzer', args: [] },
};

const EXT_TO_LANGUAGE: Readonly<Record<string, LsLanguage>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** 扩展名 → 语言（无扩展名/未映射返回 undefined——该文件不走 LSP） */
export function languageForFile(filePath: string): LsLanguage | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    return undefined;
  }
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
}

/** 用户配置行 "cmd arg1 arg2" → 启动规格（空白分隔，不处理引号——配置面保持简单） */
export function parseServerCommand(line: string): LsServerSpec | undefined {
  const parts = line
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  const [command, ...args] = parts;
  return command !== undefined ? { command, args } : undefined;
}

/** 文件 → 语言 + 启动规格（一步到位入口） */
export function resolveLsServer(
  filePath: string,
  overrides?: Readonly<Record<string, LsServerSpec>>,
): { language: LsLanguage; spec: LsServerSpec } | undefined {
  const language = languageForFile(filePath);
  if (language === undefined) {
    return undefined;
  }
  return { language, spec: serverSpecForLanguage(language, overrides) };
}

/** 语言 → 规格：用户覆盖优先（命令非空才采纳），否则内置 */
export function serverSpecForLanguage(
  language: LsLanguage,
  overrides?: Readonly<Record<string, LsServerSpec>>,
): LsServerSpec {
  const override = overrides?.[language];
  if (override !== undefined && override.command.length > 0) {
    return override;
  }
  return BUILTIN_SERVERS[language];
}

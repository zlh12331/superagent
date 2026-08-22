// src/main/infra/lsp/ls-config.ts
// 语言服务器解析：扩展名 → 语言 → 服务器命令（内置默认 + 用户覆盖）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 内置默认服务器表（stdio 约定；对齐主流 LSP server 的启动方式）
// - 文件扩展名 → 语言标识映射（工具入参只有文件路径）
// - parseServerCommand：用户配置的命令行字符串 → 结构化 spec（空白分隔）
// - resolveLsServer：按文件解析生效服务器（override 优先，缺省回落内置）
//
// 设计原则：
// - 纯函数无副作用（可测性）；不校验命令存在性（启动失败由 manager/工具层兜底）
// - 只收录 stdio 模式成熟的主流服务器；未收录语言明确报错（不伪造能力）
// ──────────────────────────────────────────────────────────────

/** 语言服务器启动规格 */
export interface LsServerSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** 支持的语言标识 */
export const SUPPORTED_LS_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;
export type LsLanguage = (typeof SUPPORTED_LS_LANGUAGES)[number];

/** 内置默认服务器（stdio 约定；用户可在设置中按语言覆盖） */
const BUILTIN_SERVERS: Readonly<Record<LsLanguage, LsServerSpec>> = {
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  go: { command: 'gopls', args: [] },
  rust: { command: 'rust-analyzer', args: [] },
};

/** 扩展名 → 语言映射（小写含点；ts/js 家族共用 tsserver 生态） */
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

/**
 * 按文件路径解析语言标识（大小写不敏感；无扩展名/未收录返回 undefined）
 */
export function languageForFile(filePath: string): LsLanguage | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    return undefined;
  }
  const ext = filePath.slice(dot).toLowerCase();
  // 扩展名后缀截断（如 ".d.ts" 命中 .ts；目录段中的点不影响 lastIndexOf 取尾）
  return EXT_TO_LANGUAGE[ext];
}

/**
 * 解析用户配置的命令行为结构化规格（首个空白前为命令，余为参数；空白串返回 undefined）
 */
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

/**
 * 按文件解析生效的服务器规格（用户 override 优先，缺省回落内置默认）
 *
 * @param filePath 目标文件绝对路径（决定语言）
 * @param overrides 按语言的服务器规格覆盖（结构化；来自设置经 parseServerCommand 转换）
 * @returns 语言 + 规格；文件类型未收录时 undefined（调用方给出明确错误）
 */
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

/**
 * 按语言取生效服务器规格（override 优先，缺省回落内置默认）
 */
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

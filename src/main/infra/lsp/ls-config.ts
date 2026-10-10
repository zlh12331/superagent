export interface LsServerSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export const SUPPORTED_LS_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;
export type LsLanguage = (typeof SUPPORTED_LS_LANGUAGES)[number];

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

export function languageForFile(filePath: string): LsLanguage | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    return undefined;
  }
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
}

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

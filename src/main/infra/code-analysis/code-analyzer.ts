import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Language, Parser, type Tree } from 'web-tree-sitter';

import { logger } from '../../utils/logger';

const require = createRequire(import.meta.url);

const EXT_TO_LANG: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
  '.sh': 'bash',
  '.bash': 'bash',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
};

const SYMBOL_KINDS: Readonly<Record<string, CodeSymbolKind>> = {
  function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  import_statement: 'import',
  method_definition: 'method',
};

export type CodeSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'import' | 'method';

export interface CodeSymbol {
  readonly kind: CodeSymbolKind;
  readonly name: string;
  readonly line: number;
}

export interface CodeAnalysis {
  readonly language: string;
  readonly symbols: readonly CodeSymbol[];
  readonly parseFailed: boolean;
}

export interface ICodeAnalyzer {
  analyze(options: { readonly path: string; readonly content?: string }): Promise<CodeAnalysis>;
}

let parserClass: typeof Parser | null = null;
let parserInstance: Parser | null = null;
let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();
let initFailed = false;

function resolveWasm(specifier: string): Buffer | null {
  try {
    const filePath = require.resolve(specifier);
    return require('node:fs').readFileSync(filePath);
  } catch {
    return null;
  }
}

async function ensureParser(): Promise<void> {
  if (parserInstance !== null) {
    return;
  }
  if (initFailed) {
    throw new Error('tree-sitter WASM 初始化已失败');
  }
  if (initPromise !== null) {
    return initPromise;
  }
  initPromise = (async () => {
    const runtimeWasm = resolveWasm('web-tree-sitter/web-tree-sitter.wasm');
    if (runtimeWasm === null) {
      throw new Error('web-tree-sitter 运行时 wasm 缺失');
    }
    await Parser.init({ wasmBinary: runtimeWasm });
    parserClass = Parser;
    parserInstance = new Parser();
  })().catch((error: unknown) => {
    initFailed = true;
    initPromise = null;
    logger.error({ error }, 'web-tree-sitter 初始化失败（代码分析降级为空）');
    throw error;
  });
  return initPromise;
}

async function loadLanguage(lang: string): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached !== undefined) {
    return cached;
  }
  if (parserClass === null) {
    throw new Error('Parser 未初始化');
  }
  const wasm = resolveWasm(`@cursorless/tree-sitter-wasms/out/tree-sitter-${lang}.wasm`);
  if (wasm === null) {
    throw new Error(`语言 wasm 缺失: ${lang}`);
  }
  const language = await Language.load(wasm);
  languageCache.set(lang, language);
  return language;
}

function extractSymbols(tree: Tree): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const cursor = tree.walk();
  let done = false;
  while (!done) {
    const node = cursor.currentNode;
    const kind = SYMBOL_KINDS[node.type];
    if (kind !== undefined) {
      let name = '';
      if (kind === 'import') {
        const pathNode = node.childForFieldName('path');
        if (pathNode !== null) {
          name = pathNode.text;
        } else {
          const stringChild = node.namedChildren.find((c) => c.type === 'string');
          name = stringChild !== undefined ? stringChild.text.replace(/^['"]|['"]$/g, '') : '';
        }
      } else {
        const nameNode = node.childForFieldName('name');
        name = nameNode !== null ? nameNode.text : '';
      }
      if (name.length > 0) {
        symbols.push({ kind, name, line: node.startPosition.row + 1 });
      }
    }
    if (cursor.gotoFirstChild()) {
      continue;
    }
    if (cursor.gotoNextSibling()) {
      continue;
    }
    let backtracking = true;
    while (backtracking && !done) {
      if (!cursor.gotoParent()) {
        done = true;
        break;
      }
      if (cursor.gotoNextSibling()) {
        backtracking = false;
      }
    }
  }
  return symbols;
}

class CodeAnalyzer implements ICodeAnalyzer {
  async analyze(options: {
    readonly path: string;
    readonly content?: string;
  }): Promise<CodeAnalysis> {
    const { path, content } = options;
    const lang = EXT_TO_LANG[extname(path).toLowerCase()] ?? 'typescript';

    try {
      await ensureParser();
      const language = await loadLanguage(lang);
      const source = content ?? (await fs.readFile(path, 'utf-8'));
      if (parserInstance === null) {
        throw new Error('Parser 未初始化');
      }
      parserInstance.setLanguage(language);
      const tree = parserInstance.parse(source);
      if (tree === null) {
        throw new Error('解析中止，未产出语法树');
      }
      return { language: lang, symbols: extractSymbols(tree), parseFailed: false };
    } catch (error) {
      logger.warn({ path, lang, error }, '代码分析失败，降级为空结果');
      return { language: lang, symbols: [], parseFailed: true };
    }
  }
}

let codeAnalyzer: CodeAnalyzer | null = null;

export function getCodeAnalyzer(): ICodeAnalyzer {
  if (codeAnalyzer === null) {
    codeAnalyzer = new CodeAnalyzer();
  }
  return codeAnalyzer;
}

export function resetCodeAnalyzer(): void {
  codeAnalyzer = null;
  parserClass = null;
  parserInstance = null;
  initPromise = null;
  initFailed = false;
  languageCache.clear();
}

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Language, Parser, type Tree } from 'web-tree-sitter';

import { logger } from '../../utils/logger';

const require = createRequire(import.meta.url);

/** 扩展名 → tree-sitter 语言 id（@cursorless/tree-sitter-wasms 支持子集） */
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

/** 语法树节点类型 → 符号类型 */
const SYMBOL_KINDS: Readonly<Record<string, CodeSymbolKind>> = {
  function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  import_statement: 'import',
  method_definition: 'method',
};

/** 符号类型 */
export type CodeSymbolKind = 'function' | 'class' | 'interface' | 'type' | 'import' | 'method';

/** 单个符号（名称 + 起始行，1-based） */
export interface CodeSymbol {
  readonly kind: CodeSymbolKind;
  readonly name: string;
  readonly line: number;
}

/** 分析结果 */
export interface CodeAnalysis {
  /** 实际使用的语言 id（如 'typescript'） */
  readonly language: string;
  readonly symbols: readonly CodeSymbol[];
  /** true 表示解析失败（WASM 不可用/语法异常），symbols 为空 */
  readonly parseFailed: boolean;
}

/** CodeAnalyzer 接口 */
export interface ICodeAnalyzer {
  /**
   * 分析源文件，提取符号列表
   *
   * @param options.path 文件路径（扩展名决定语言；路径不存在时需提供 content）
   * @param options.content 源码内容（可选；省略时按 path 读取）
   * @returns 分析结果；失败时 parseFailed=true 且 symbols 为空（不抛错）
   */
  analyze(options: { readonly path: string; readonly content?: string }): Promise<CodeAnalysis>;
}

let parserClass: typeof Parser | null = null;
let parserInstance: Parser | null = null;
let initPromise: Promise<void> | null = null;
/** 语言缓存：language id → Language（wasm 加载一次复用） */
const languageCache = new Map<string, Language>();
/** 初始化永久失败标记（避免反复重试挂起） */
let initFailed = false;

/** 解析 wasm 文件绝对路径（node_modules 内，返回 Buffer；缺失返回 null） */
function resolveWasm(specifier: string): Buffer | null {
  try {
    const filePath = require.resolve(specifier);
    return require('node:fs').readFileSync(filePath);
  } catch {
    return null;
  }
}

/** 初始化 Parser 单例（web-tree-sitter 运行时 wasm） */
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

/** 按需加载语言 wasm（带缓存） */
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

/** 遍历语法树提取符号（递归 walk） */
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

/**
 * CodeAnalyzer 默认实现
 */
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

/** CodeAnalyzer 单例 */
let codeAnalyzer: CodeAnalyzer | null = null;

/**
 * 获取 CodeAnalyzer 单例
 */
export function getCodeAnalyzer(): ICodeAnalyzer {
  if (codeAnalyzer === null) {
    codeAnalyzer = new CodeAnalyzer();
  }
  return codeAnalyzer;
}

/**
 * 重置 CodeAnalyzer（仅测试用）
 */
export function resetCodeAnalyzer(): void {
  codeAnalyzer = null;
  parserClass = null;
  parserInstance = null;
  initPromise = null;
  initFailed = false;
  languageCache.clear();
}

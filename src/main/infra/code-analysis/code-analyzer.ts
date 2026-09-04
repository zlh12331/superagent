// src/main/infra/code-analysis/code-analyzer.ts
// CodeAnalyzer：代码结构分析服务（web-tree-sitter）
// ──────────────────────────────────────────────────────────────
// 职责：
// - analyze：解析源文件语法树，提取顶层符号（function/class/interface/type/import/method）
// - 能力基础：支撑代码智能（结构化理解、符号索引、Agent 代码定位）
// - 参考 qwen-code shellAstParser 的懒加载模式：Parser 单例 + 语言 wasm 按需加载
//
// 设计：
// - 懒加载：首次 analyze 才初始化 web-tree-sitter（WASM 加载约几十 ms）
// - 语言映射：扩展名 → tree-sitter 语言 id（@cursorless/tree-sitter-wasms 提供的子集）
// - 失败降级：WASM 缺失/解析异常 → 返回空符号 + parseFailed=true（不阻塞主流程）
// - 单例模式：与 FileService / SearchService 一致
//
// 版本钉扎（2026-09-04 升级核实）：web-tree-sitter 0.27.x + @cursorless/tree-sitter-wasms
// 0.10.x（语言 wasm 提供者，2026-08 更新，单包覆盖全所需语言）——新 dylink.0 ABI 与
// 0.25+ 运行时匹配（实测 9/9 语言加载解析通过）。旧的 tree-sitter-wasms 0.1.13 仍用旧
// dylink 格式，与 0.25+ 运行时 Language.load 不兼容（dylink 元数据错误），勿回退混用。
// ──────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
// web-tree-sitter 0.27：命名导出（Parser 运行时、Language 语言加载、Tree 语法树）；与
// @cursorless/tree-sitter-wasms 0.10.x 的 wasm ABI 匹配
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

// ── 懒加载单例状态 ──────────────────────────────────────

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
    // web-tree-sitter 0.27：命名导出；wasmBinary 显式注入（asar 打包后文件定位不可靠）
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
      // 符号名称：import 特殊处理（path 字段在部分 wasm 变体缺失，回退 string 子节点去引号）
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
    // 回溯：无兄弟节点时上移直到找到下一个兄弟或结束
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
    // 扩展名 → 语言；未知扩展名回退 typescript（避免不可用）
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
        // 0.27 parse 返回 Tree | null：语言未设置/解析中止时为 null
        throw new Error('解析中止，未产出语法树');
      }
      return { language: lang, symbols: extractSymbols(tree), parseFailed: false };
    } catch (error) {
      // 降级：返回空结果，不阻塞调用方（工具/搜索等上层自行处理）
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

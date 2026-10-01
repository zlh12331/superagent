// scripts/lib/tsdoc-rules.ts
// TSDoc 覆盖门禁规则核（纯函数层，供 check-tsdoc.ts CLI 调用）
// ──────────────────────────────────────────────────────────────
// 落实 docs/design/typescript-dev-standards-ai.md 规则 18.1：
// 「所有 export 的函数、类、接口、类型必须有 TSDoc 注释」。
// 此前无自动门禁（debt.md#d3），2026-09-25 落地：AST 扫描 + 棘轮基线
// （存量已清零——落地日实测 75 处并全部补写；量化首跑的 1126 系判据误判
// 产物，修正 Export 节点锚定后 75 为真值；新代码即写即 100% 覆盖）。
//
// 判据（@babel/parser AST，零手写正则）：
// - 目标：export 的 function / class / interface / type alias / enum 声明
// - 「有 TSDoc」= 声明前最近的块注释以 /** 开头，且注释结束到声明起始之间只有空白
// - 不计：TSDeclareFunction（重载签名，由实现签名携带文档）、
//   export { x } / export * from（注释责任在被指向的声明）
// - export const 变量规范未列，不强制（constMissing 由调用方按需统计）
// ──────────────────────────────────────────────────────────────

import { parse } from '@babel/parser';

/** 一处无 TSDoc 的 export 声明 */
export interface TsdocMissing {
  /** 展示用相对路径（posix） */
  readonly file: string;
  /** 声明起始行（1-based） */
  readonly line: number;
  /** 声明种类 */
  readonly kind: 'function' | 'class' | 'interface' | 'type' | 'enum';
  /** 符号名 */
  readonly name: string;
}

/** 单文件扫描结果 */
export interface TsdocScan {
  readonly missing: readonly TsdocMissing[];
  /** 已带 TSDoc 的目标声明数（供统计） */
  readonly documented: number;
  /** export const 无注释数（规范 18.1 未列，仅统计参考） */
  readonly constMissing: number;
}

/**
 * 扫描单文件内容，返回无 TSDoc 的 export 声明明细
 *
 * @param content 文件内容
 * @param rel 展示用相对路径（posix）
 */
export function scanTsdoc(content: string, rel: string): TsdocScan {
  const missing: TsdocMissing[] = [];
  let documented = 0;
  let constMissing = 0;

  if (content.trim().length === 0) {
    return { missing, documented, constMissing };
  }

  const ast = parse(content, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  // JSDoc 块注释集合（/** 开头的块注释）；babel 默认收集全部注释
  const jsdocs = (ast.comments ?? []).filter(
    (c) =>
      c.type === 'CommentBlock' &&
      typeof c.start === 'number' &&
      content.startsWith('/**', c.start),
  );

  /** 声明 start 前最近的 JSDoc，且与声明之间只隔空白与 biome-ignore 指令行
   *  （biome-ignore 是工具指令非文档间隔——I 前缀接口「JSDoc + biome-ignore + 声明」
   *  为项目既有合法形态） */
  const hasJsDocBefore = (start: number): boolean => {
    let best: { start: number; end: number } | null = null;
    for (const c of jsdocs) {
      if (c.end === undefined) continue;
      if (c.end <= start && (best === null || (best.end !== null && c.end > best.end))) {
        best = { start: c.start ?? 0, end: c.end };
      }
    }
    if (best === null || best.end === null) return false;
    const gapLines = content.slice(best.end, start).split('\n');
    return gapLines.every((line) => {
      const t = line.trim();
      return t === '' || t.startsWith('// biome-ignore');
    });
  };

  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportDefaultDeclaration') {
      continue;
    }
    // export { x } / export * from：注释责任在被指向的声明
    const decl = node.declaration;
    if (decl === null || decl === undefined) continue;
    // 重载签名由实现签名携带文档
    if (decl.type === 'TSDeclareFunction') continue;

    // 注意：JSDoc 挂在 export 关键字之前，而 babel 的 declaration.start 不含
    // "export " 前缀——判注释邻近性必须用 Export 节点起点（node.start），
    // 否则 gap 恒含 "export" 非空白，全部误判为无注释（实测踩坑）。
    const docAnchor = node.start ?? 0;

    let kind: TsdocMissing['kind'] | 'const' | null = null;
    let name = '?';
    if (decl.type === 'FunctionDeclaration') {
      kind = 'function';
      name = decl.id?.name ?? '?';
    } else if (decl.type === 'ClassDeclaration') {
      kind = 'class';
      name = decl.id?.name ?? '?';
    } else if (decl.type === 'TSInterfaceDeclaration') {
      kind = 'interface';
      name = decl.id?.name ?? '?';
    } else if (decl.type === 'TSTypeAliasDeclaration') {
      kind = 'type';
      name = decl.id?.name ?? '?';
    } else if (decl.type === 'TSEnumDeclaration') {
      kind = 'enum';
      name = decl.id?.name ?? '?';
    } else if (decl.type === 'VariableDeclaration') {
      // 规范 18.1 未列变量；仅统计，不计入 missing
      const first = decl.declarations[0];
      if (first !== null && first !== undefined && first.id.type === 'Identifier') {
        const isJsDoc = hasJsDocBefore(docAnchor);
        if (!isJsDoc) constMissing += 1;
        else documented += 1;
      }
      continue;
    }
    if (kind === null) continue;

    if (hasJsDocBefore(docAnchor)) {
      documented += 1;
      continue;
    }
    missing.push({
      file: rel,
      line: decl.loc?.start.line ?? 0,
      kind,
      name,
    });
  }

  return { missing, documented, constMissing };
}

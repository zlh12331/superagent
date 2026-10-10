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
    const decl = node.declaration;
    if (decl === null || decl === undefined) continue;
    if (decl.type === 'TSDeclareFunction') continue;

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

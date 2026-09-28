// scripts/lib/devtools-residue.ts
// devtools 产物残留扫描核（纯函数层，供 check-devtools.ts CLI 调用）
// ──────────────────────────────────────────────────────────────
// 判据与 src/renderer/providers/query-devtools.tsx 头注释记录的权威门禁同源：
// 「包名串 react-query-devtools」与「组件名 ReactQueryDevtools」两个标记串
// 任一出现即残留（子串匹配，与门禁命令 rg 的默认语义一致）。
// 范围刻意不含 electron-devtools-installer——它是主进程 dev 工具（window.ts
// 静态导入），不属于本门禁。
// 红绿夹具见 devtools-residue.test.ts。
// ──────────────────────────────────────────────────────────────

/** 包名标记串（模块被打回产物图时必经 import 描述符 / sourcesContent 出现） */
const PACKAGE_MARKER = 'react-query-devtools';

/** 组件名标记串（sourcesContent 保留源码原文时的另一形态） */
const COMPONENT_MARKER = 'ReactQueryDevtools';

/** 单处残留命中 */
export interface ResidueHit {
  /** 产物文件路径（相对产物根） */
  readonly file: string;
  /** 首个命中的行号（1 起） */
  readonly line: number;
}

/** 待扫描的产物文件 */
export interface ProductFile {
  /** 产物文件路径（相对产物根） */
  readonly file: string;
  /** UTF-8 内容 */
  readonly content: string;
}

/** 返回两个候选索引中首个命中者（都未命中返回 -1） */
function firstHitIndex(a: number, b: number): number {
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/**
 * 扫描产物内容中的 react-query devtools 残留（两个标记串任一出现即算）。
 *
 * dev 调试面板按设计只允许存在于 dev 构建链（QueryProvider 的 dev 门 +
 * 动态 import），生产构建整体 DCE 出产物图；只要模块以任何形态回到产物图，
 * 标记串经 sourcemap sourcesContent 必然出现（哪怕只在死分支/注释里）。
 *
 * @param files 待扫描的产物文件集合
 * @returns 命中列表（空数组 = 通过）
 */
export function findDevtoolsResidue(files: readonly ProductFile[]): ResidueHit[] {
  const hits: ResidueHit[] = [];
  for (const { file, content } of files) {
    const index = firstHitIndex(content.indexOf(PACKAGE_MARKER), content.indexOf(COMPONENT_MARKER));
    if (index === -1) continue;
    hits.push({ file, line: content.slice(0, index).split('\n').length });
  }
  return hits;
}

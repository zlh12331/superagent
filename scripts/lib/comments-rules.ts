import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 规则命中（file 为调用方给定的展示用相对路径） */
export interface CommentProblem {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
  readonly level: 'error' | 'warning';
}

/** 规则运行环境（CLI 侧绑定仓库真源；测试侧注入 fixture 假根） */
export interface CommentRulesCtx {
  /** 仓库根（规则 B 的相对路径解析基准） */
  readonly root: string;
  /** 根 package.json scripts 键集合（规则 D） */
  readonly rootScripts: ReadonlySet<string>;
  /** node_modules/.bin 工具名集合（规则 D 的回退判据） */
  readonly binStems: ReadonlySet<string>;
  /** TODO 过期天数阈值（默认 90） */
  readonly todoStaleDays: number;
}

/** pnpm 内置 CLI 命令（引用中出现视为合法，不要求是 scripts 键） */
export const PNPM_BUILTIN: ReadonlySet<string> = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'up',
  'upgrade',
  'upgrade-interactive',
  'link',
  'unlink',
  'list',
  'ls',
  'll',
  'why',
  'audit',
  'prune',
  'rebuild',
  'rb',
  'run',
  'exec',
  'dlx',
  'create',
  'init',
  'start',
  'stop',
  'restart',
  'test',
  't',
  'set',
  'get',
  'config',
  'bin',
  'root',
  'store',
  'outdated',
  'owner',
  'pack',
  'publish',
  'patch',
  'patch-commit',
  'patch-remove',
  'import',
  'licenses',
  'completion',
  'env',
  'setup',
  'fetch',
  'dedupe',
  'deploy',
  'approve-builds',
  'install-test',
  'it',
  'ci',
  'help',
  'runx',
  'workspaces',
]);

/** 提取函数前的 JSDoc 块：/** ... *\/ */
function extractJsDocBlocks(content: string): Array<{ start: number; end: number; text: string }> {
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  const re = /\/\*\*([\s\S]*?)\*\//g;
  for (const m of content.matchAll(re)) {
    const index = m.index;
    const captured = m[1];
    if (index === undefined || captured === undefined) continue;
    blocks.push({ start: index, end: index + m[0].length, text: captured });
  }
  return blocks;
}

/** 从 JSDoc 块提取 @param 名集合（仅 {Type} name 或 name 形式，name 为第二捕获组） */
function extractParamNames(jsdoc: string): Set<string> {
  const names = new Set<string>();
  const re = /@param\s+(?:\{([^}]+)\}\s+)?([A-Za-z_$][\w$]*)/g;
  for (const m of jsdoc.matchAll(re)) {
    const name = m[2];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** 从函数签名提取参数名（支持简单签名、可选参数与解构对象属性） */
function extractSignatureParams(signature: string): Set<string> {
  const names = new Set<string>();
  const params = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'));
  const destructuredInner = params.match(/\{\s*([^}]+)\}/)?.[1];
  if (destructuredInner !== undefined) {
    for (const p of destructuredInner.split(/[;,]/)) {
      const name = p
        .trim()
        .split(':')[0]
        ?.trim()
        .replace(/^readonly\s+/, '')
        .replace(/\?$/, '');
      if (name && !name.includes(' ')) names.add(name);
    }
  }
  for (const p of params.split(',')) {
    const clean = p.trim().replace(/^\.\.\./, '');
    if (clean === '') continue;
    const name = clean.split(':')[0]?.trim().replace(/\?$/, '').split('=')[0]?.trim();
    if (name && !name.includes(' ')) names.add(name);
  }
  return names;
}

/**
 * 注释规则组（绑定 ctx 后返回四个检查函数；每个函数向 problems 追加命中）
 */
export function createCommentRules(ctx: CommentRulesCtx) {
  /** 规则 A：JSDoc @param 与函数签名一致性 */
  function checkJsDoc(content: string, file: string, problems: CommentProblem[]): void {
    const blocks = extractJsDocBlocks(content);
    if (blocks.length === 0) return;

    const fnRe =
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\)\s*(?::[^{}]*)?(?=\s*\{)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\(([\s\S]*?)\)|(\w+))\s*=>|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(([\s\S]*?)\)/g;

    for (const block of blocks) {
      fnRe.lastIndex = block.end;
      const m = fnRe.exec(content);
      if (m === null) continue;
      const gap = content.slice(block.end, m.index);
      const gapLines = gap.split('\n').length - 1;
      if (gapLines > 2) continue;
      if (/[a-zA-Z0-9_$]/.test(gap.replace(/\s/g, ''))) continue;
      const signature = m[0];
      const signatureParams = extractSignatureParams(signature);
      if (signatureParams.size === 0) continue;

      const docParams = extractParamNames(block.text);
      const lineNo = content.slice(0, block.start).split('\n').length;

      for (const doc of docParams) {
        if (!signatureParams.has(doc)) {
          problems.push({
            file,
            line: lineNo,
            rule: 'stale-param',
            detail: `JSDoc @param '${doc}' 不存在于签名 ${signature.slice(0, 60)}…`,
            level: 'error',
          });
        }
      }
    }
  }

  /** 规则 B：file:/// 引用路径 + #L 行号有效性 */
  function checkFileRefs(content: string, file: string, problems: CommentProblem[]): void {
    const re = /file:\/\/\/([^)\s"`]+)/g;
    for (const m of content.matchAll(re)) {
      const raw = m[1];
      if (raw === undefined) continue;
      if (raw.includes('${')) continue;
      const [pathPart = '', linePart] = raw.split('#L');
      const abs = pathPart.includes(':') ? pathPart : join(ctx.root, pathPart.replace(/^\/+/, ''));
      const lineNo = content.slice(0, m.index).split('\n').length;
      if (!statSync(abs, { throwIfNoEntry: false })) {
        problems.push({
          file,
          line: lineNo,
          rule: 'stale-file-ref',
          detail: `file:/// 引用不存在：${pathPart}`,
          level: 'error',
        });
        continue;
      }
      if (linePart !== undefined) {
        const targetLines = readFileSync(abs, 'utf8').split('\n').length;
        const refLine = Number.parseInt(linePart, 10);
        if (Number.isFinite(refLine) && refLine > targetLines) {
          problems.push({
            file,
            line: lineNo,
            rule: 'stale-line-ref',
            detail: `#L${refLine} 超出 ${pathPart} 实际行数（${targetLines}）`,
            level: 'error',
          });
        }
      }
    }
  }

  /** 规则 C：TODO/FIXME 过期 */
  function checkTodos(content: string, file: string, problems: CommentProblem[]): void {
    const re = /\b(TODO|FIXME|HACK)\b[:(]?\s*(\d{4}-\d{2}-\d{2})?/g;
    for (const m of content.matchAll(re)) {
      const lineNo = content.slice(0, m.index).split('\n').length;
      const date = m[2];
      if (date === undefined) {
        problems.push({
          file,
          line: lineNo,
          rule: 'todo-no-date',
          detail: `${m[1]} 无日期（建议格式 TODO(YYYY-MM-DD)）`,
          level: 'warning',
        });
        continue;
      }
      const days = (Date.now() - Date.parse(date)) / 86_400_000;
      if (days > ctx.todoStaleDays) {
        problems.push({
          file,
          line: lineNo,
          rule: 'todo-stale',
          detail: `${m[1]}(${date}) 已 ${Math.floor(days)} 天未处理（> ${ctx.todoStaleDays} 天）`,
          level: 'error',
        });
      }
    }
  }

  /** 规则 D：pnpm 命令引用存在性——只查**代码语境**的命令（行内反引号 `pnpm <name>` 与
   * md 围栏代码块的行首命令）。裸文本不查：「pnpm workspace 配置」等描述性短语无法与
   * 命令引用区分，强行匹配只会持续误报（实测）。 */
  function checkCommandRefs(content: string, file: string, problems: CommentProblem[]): void {
    const reInline = /`pnpm\s+([a-zA-Z@][\w@:./-]*)/g;
    const reLine = /^pnpm\s+([a-zA-Z@][\w@:./-]*)/;

    const verify = (token: string | undefined, fileLine: number): void => {
      if (token === undefined) return;
      if (token.startsWith('-')) return;
      if (PNPM_BUILTIN.has(token)) return;
      if (ctx.rootScripts.has(token)) return;
      if (ctx.binStems.has(token)) return;
      problems.push({
        file,
        line: fileLine + 1,
        rule: 'stale-command',
        detail: `pnpm '${token}' 既非 pnpm 内置命令、不在根 package.json scripts，也不是 .bin 工具`,
        level: 'error',
      });
    };

    const lines = content.split('\n');
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (inFence) {
        const m = reLine.exec(line);
        if (m !== null) verify(m[1], i);
      }
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      for (const m of line.matchAll(reInline)) verify(m[1], i);
    }
  }

  return { checkJsDoc, checkFileRefs, checkTodos, checkCommandRefs };
}

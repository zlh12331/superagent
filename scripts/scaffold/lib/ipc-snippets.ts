// scripts/scaffold/lib/ipc-snippets.ts
// IPC 脚手架的纯代码片段生成与源码插入（零 AST / 零依赖，可单测）
// ──────────────────────────────────────────────
// 为什么单独成模块：原 scaffold-ipc.ts 把「生成什么」和「写到哪」混在一起，
// 于是 resSchema 漏发这类「会让应用启动即崩」的错误没有测试可拦。
// register.ts 的启动断言要求每个 request 方法必须有 resSchema：
//   if (def.resSchema === undefined) throw new Error('IPC 响应契约缺失 …——resSchema 必填')
// 旧脚手架产出的是 3 参 withSchema(meta, null, {} as { ok: boolean })，
// 即「脚手架跑完 → pnpm dev 直接崩」。本模块产出一律 4 参（第 4 参用
// 内联 z.object({ ok: z.boolean() }) 占位，与 {} as { ok: boolean } 类型一致）。
// ──────────────────────────────────────────────

import { escapeRegExp, insertSortedLine } from './text';

/** 一个待脚手架的方法 */
export interface MethodSpec {
  readonly domain: string;
  readonly method: string;
  readonly kind: 'request' | 'event';
}

/** request 占位响应类型与其 schema（zod 在 definitions.ts 顶部必有 `import { z } from 'zod'`） */
export const PLACEHOLDER_RES_TYPE = '{ ok: boolean }';
export const PLACEHOLDER_RES_SCHEMA = 'z.object({ ok: z.boolean() })';

/**
 * 生成 meta.ts 的方法行
 *
 * @param spec 方法描述
 * @returns 带 4 空格缩进的 `request('domain:method')` 行
 */
export function metaEntryLine(spec: MethodSpec): string {
  const { domain, method, kind } = spec;
  const channel = `${domain}:${method}`;
  return kind === 'request'
    ? `    ${method}: request('${channel}'),`
    : `    ${method}: event('${channel}'),`;
}

/**
 * 生成 definitions.ts 的方法条目（多行，含 TODO）
 *
 * request 必须发满 4 参：meta / 入参 schema / res 类型标记 / resSchema，
 * 缺第 4 参会触发 registerIpcHandlers 的启动断言。
 *
 * @param spec 方法描述
 * @returns 条目文本（不含结尾换行，缩进 4 空格）
 */
export function definitionsEntryBlock(spec: MethodSpec): string {
  const { domain, method, kind } = spec;
  if (kind === 'request') {
    return [
      `    // TODO: 替换入参 null 与响应占位（${PLACEHOLDER_RES_TYPE} / ${PLACEHOLDER_RES_SCHEMA}）为真实类型`,
      `    //       建议新建 packages/shared/src/schemas/${domain}.ts 并在此 import`,
      `    ${method}: withSchema(`,
      `      IPC_META.${domain}.${method},`,
      '      null,',
      `      {} as ${PLACEHOLDER_RES_TYPE},`,
      `      ${PLACEHOLDER_RES_SCHEMA},`,
      '    ),',
    ].join('\n');
  }
  return [
    '    // TODO: 替换 {} as Record<string, never> 为真实 payload 类型',
    `    ${method}: withPayload(IPC_META.${domain}.${method}, {} as Record<string, never>),`,
  ].join('\n');
}

/**
 * 新域块（meta.ts 用）
 *
 * @param spec 方法描述
 * @returns 以换行开头结尾的域块
 */
export function metaDomainBlock(spec: MethodSpec): string {
  return `\n  ${spec.domain}: {\n${metaEntryLine(spec)}\n  },\n`;
}

/**
 * 新域块（definitions.ts 用）
 *
 * @param spec 方法描述
 * @returns 以换行开头结尾的域块
 */
export function definitionsDomainBlock(spec: MethodSpec): string {
  return `\n  ${spec.domain}: {\n${definitionsEntryBlock(spec)}\n  },\n`;
}

/**
 * handler 骨架文件内容
 *
 * @param spec 方法描述
 * @returns 完整文件文本
 */
export function buildHandlerFile(spec: MethodSpec): string {
  const { domain, method, kind } = spec;
  const Domain = toPascal(domain);
  const channelsLine =
    kind === 'request'
      ? `// - ${domain}:${method}：TODO: 一句话职责`
      : `// - ${domain}:${method}（event，主进程主动推送，无需 handler 实现）`;
  const impl =
    kind === 'request'
      ? [
          '  // TODO: 实现业务逻辑；服务依赖通过工厂函数注入（参考 file.handler.ts / session.handler.ts）',
          `  ${method}: async (input) => {`,
          '    void input;',
          '    // TODO: 返回值必须与 definitions.ts 的 resSchema 校验一致（当前占位为 { ok: boolean }）',
          '    return { ok: true };',
          '  },',
        ].join('\n')
      : '  // TODO: 定义表新增 request 方法后在此实现（缺失会编译期报错）';

  return [
    `// src/main/ipc/${domain}.handler.ts`,
    `// ${Domain} 域 IPC handler（定义表驱动，注册由 registerIpcHandlers 统一执行）`,
    '//',
    '// 当前实现 1 个 channel：',
    channelsLine,
    '//',
    '// 说明：handler 对象形状受 InferHandlers 约束（缺方法编译期报错）；',
    '// channel / schema 由 IPC_DEFINITIONS 提供，本文件只写业务实现。',
    '',
    "import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';",
    '',
    "import type { IpcHandlerContext } from '../utils/wrap';",
    '',
    `/** ${Domain} 域 handler 实现（${domain} 域） */`,
    `export const ${domain}Handlers: InferHandlers<`,
    '  typeof IPC_DEFINITIONS,',
    '  IpcHandlerContext',
    `>['${domain}'] = {`,
    impl,
    '};',
    '',
  ].join('\n');
}

/**
 * index.ts 中的注册条目行
 *
 * @param spec 方法描述
 * @returns 带 6 空格缩进的 `domain: domainHandlers,` 行
 */
export function registrationEntryLine(spec: MethodSpec): string {
  return `      ${spec.domain}: ${spec.domain}Handlers,`;
}

/**
 * index.ts 中的 handler import 行
 *
 * @param spec 方法描述
 * @returns import 语句（不含换行）
 */
export function registrationImportLine(spec: MethodSpec): string {
  return `import { ${spec.domain}Handlers } from './ipc/${spec.domain}.handler';`;
}

/**
 * 跳过字符串/注释，找到与 openIdx 处 `{` 配对的 `}`
 *
 * @param source 源码文本
 * @param openIdx `{` 的下标
 * @returns 配对 `}` 的下标；未找到返回 -1
 */
export function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i, ch);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipStringLiteral(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      const close = findMatchingBrace(source, i + 1);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    i += 1;
  }
  return source.length;
}

/**
 * 在 `registerIpcHandlers({ … })` 的对象字面量末尾插入注册条目，并补 import
 *
 * @param source src/main/index.ts 原文
 * @param spec 方法描述（event 类型不需要注册，调用方应提前跳过）
 * @returns 新文本；调用块未找到返回 null；域已注册返回原文（幂等）
 */
export function insertHandlerRegistration(
  source: string,
  spec: MethodSpec,
): { text: string; inserted: boolean } | null {
  const callHead = source.indexOf('registerIpcHandlers({');
  if (callHead === -1) return null;
  const openIdx = callHead + 'registerIpcHandlers'.length;
  const closeIdx = findMatchingBrace(source, openIdx);
  if (closeIdx === -1) return null;

  const body = source.slice(openIdx + 1, closeIdx);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(spec.domain)}\\s*:`, 'm');
  const withImport = insertImportForHandler(source, spec);
  if (keyPattern.test(body)) {
    return { text: withImport.text, inserted: withImport.inserted };
  }
  const head = source.slice(0, closeIdx);
  const tail = source.slice(closeIdx);
  const indent = /^\n(\s+)\S/m.exec(body)?.[1] ?? '      ';
  const entry = `${indent}${spec.domain}: ${spec.domain}Handlers,`;
  const needsComma = !/,\s*$/.test(head);
  return {
    text: `${head}${needsComma ? ',' : ''}\n${entry}\n${tail}`,
    inserted: true,
  };
}

/**
 * 按字典序插入 handler import（与 tools/index.ts 同一排序策略）
 *
 * @param source index.ts 原文
 * @param spec 方法描述
 * @returns 新文本与是否插入
 */
export function insertImportForHandler(
  source: string,
  spec: MethodSpec,
): {
  text: string;
  inserted: boolean;
} {
  const line = registrationImportLine(spec);
  if (source.includes(line)) return { text: source, inserted: false };
  const pattern = /^import \{ [^}]*\} from '\.\/ipc\/[^']+';$/m;
  const next = insertSortedLine(source, pattern, line, importKey);
  return next === null ? { text: source, inserted: false } : { text: next, inserted: true };
}

function importKey(line: string): string {
  const match = /from '([^']+)'/.exec(line);
  return match?.[1] ?? line;
}

/**
 * 计算 withSchema(...) 调用的实参个数（按顶层逗号切分，忽略嵌套）
 *
 * @param block 含 withSchema( 的代码片段
 * @returns 实参个数；未找到调用返回 -1
 */
export function countWithSchemaArgs(block: string): number {
  const head = /withSchema\(/.exec(block);
  if (head === null || head.index === undefined) return -1;
  const openIdx = head.index + head[0].length - 1;
  const closeIdx = findMatchingParen(block, openIdx);
  if (closeIdx === -1) return -1;
  const args = block.slice(openIdx + 1, closeIdx);
  return splitTopLevelArgs(args).length;
}

/**
 * 拆分顶层实参列表（供校验生成物形状）
 *
 * @param text 括号内的文本
 * @returns 顶层逗号切分后的实参（已 trim，空串会被剔除）
 */
export function splitTopLevelArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const next = skipStringLiteral(text, i, ch);
      current += text.slice(i, next);
      i = next;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch ?? '';
    i += 1;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

function findMatchingParen(source: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i, ch);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 生成「还需人工完成」的指引行（机械可测：脚本改动后测试会跟着失败）
 *
 * @param spec 方法描述
 * @param registered 注册条目是否已由脚手架写入
 * @returns 逐行指引
 */
export function manualSteps(spec: MethodSpec, registered: boolean): string[] {
  const { domain, kind } = spec;
  const lines: string[] = [];
  if (kind === 'request') {
    if (registered) {
      lines.push(
        `  1. src/main/index.ts 已插入注册条目（import 亦已补），请复核 diff：${domain}: ${domain}Handlers,`,
      );
    } else {
      lines.push(`  1. src/main/index.ts 的 registerIpcHandlers({ … }) 中手工加入两行：`);
      lines.push(`       ${registrationImportLine(spec)}`);
      lines.push(`       ${registrationEntryLine(spec).trim()}`);
      lines.push(
        `     若该域已存在（如复用 create${toPascal(domain)}Handlers({...})），则只需补 handler 实现`,
      );
    }
    lines.push(
      `  2. definitions.ts：把占位 null / ${PLACEHOLDER_RES_TYPE} / ${PLACEHOLDER_RES_SCHEMA} 换成真实 schema 与 resSchema`,
    );
    lines.push(
      `  3. 补测试：src/main/ipc/${domain}.handler.test.ts（参考 dialog.handler.test.ts）`,
    );
    lines.push('  4. 校验应用可启动的契约：pnpm check:ipc-contract（复刻 register.ts 的启动断言）');
  } else {
    lines.push(`  1. event 通道无需注册（registerIpcHandlers 只处理 request）`);
    lines.push('  2. 主进程侧用 webContents.send(IPC_META 中的 channel, payload) 推送');
    lines.push('  3. 校验应用可启动的契约：pnpm check:ipc-contract');
  }
  return lines;
}

function toPascal(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

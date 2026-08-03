// scripts/scaffold/scaffold-ipc.ts
// IPC 脚手架：从定义表体系生成新域/新方法的代码骨架
// ──────────────────────────────────────────────────────────────
// 用法：
//   pnpm scaffold:ipc --domain <name> --method <method> [--kind request|event]
//
// 示例：
//   pnpm scaffold:ipc --domain bookmark --method list        # 新建 bookmark 域（request）
//   pnpm scaffold:ipc --domain file --method watchPause --kind event
//
// 自动完成：
//   1. packages/shared/src/ipc/meta.ts 插入通道元数据
//   2. packages/shared/src/ipc/definitions.ts 插入占位 schema（TODO 待替换）
//   3. src/main/ipc/{domain}.handler.ts 生成骨架（不存在时）
//
// 手动完成（打印指引）：
//   - src/main/index.ts 注册 handler
//   - definitions.ts 占位替换为真实 schema / res 类型
//   - handler 测试
//
// 红利说明（定义表体系）：
//   IPC_CHANNELS / window.api（preload）/ IpcApi 类型 / registerIpcHandlers
//   全部由定义表自动推导，本脚手架只补齐"骨架文件"一环。
// ──────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedArgs } from './lib/args';
import { optionalValue, parseArgs, rejectPositionals, requireValue } from './lib/args';
import { camelToPascal, isValidDomain, isValidMethod } from './lib/naming';
import { insertBeforeAnchor, insertIntoObjectBlock } from './lib/text';

/** 仓库根（scripts/scaffold/ → 根） */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface MethodSpec {
  readonly domain: string;
  readonly method: string;
  readonly kind: 'request' | 'event';
}

/** 读取文件（不存在时抛错） */
function readSource(relativePath: string): string {
  const abs = path.join(REPO_ROOT, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`目标文件不存在：${relativePath}`);
  }
  return readFileSync(abs, 'utf8');
}

/** 校验 + 组装方法描述 */
function buildMethodSpec(parsedArgs: ParsedArgs): MethodSpec {
  const domain = requireValue(parsedArgs, 'domain');
  const method = requireValue(parsedArgs, 'method');
  const kind = optionalValue(parsedArgs, 'kind', 'request');

  if (!isValidDomain(domain)) {
    throw new Error(
      `非法 domain：${domain}（要求 camelCase，小写字母开头，如 session / codebase）`,
    );
  }
  if (!isValidMethod(method)) {
    throw new Error(
      `非法 method：${method}（要求 camelCase，小写字母开头，如 getStatus / listRecentDirs）`,
    );
  }
  if (kind !== 'request' && kind !== 'event') {
    throw new Error(`非法 kind：${kind}（仅支持 request / event）`);
  }
  return { domain, method, kind };
}

/** 幂等校验：以通道字符串形式检查是否已存在（防止重复运行覆盖已有方法） */
function assertChannelAbsent(
  source: string,
  fileLabel: string,
  needle: string,
  channel: string,
): void {
  if (source.includes(needle)) {
    throw new Error(`通道已存在（${fileLabel}）：${channel}，请勿重复脚手架`);
  }
}

/** 生成 meta.ts 的方法行 */
function metaEntryLine(spec: MethodSpec): string {
  const { domain, method, kind } = spec;
  const channel = `${domain}:${method}`;
  return kind === 'request'
    ? `    ${method}: request('${channel}'),`
    : `    ${method}: event('${channel}'),`;
}

/** 生成 definitions.ts 的占位条目（含 TODO 注释，多行） */
function definitionsEntryBlock(spec: MethodSpec): string {
  const { domain, method, kind } = spec;
  if (kind === 'request') {
    return [
      '    // TODO: 替换 null schema 与 {} as { ok: boolean } 为真实 schema / res 类型',
      `    ${method}: withSchema(IPC_META.${domain}.${method}, null, {} as { ok: boolean }),`,
    ].join('\n');
  }
  return [
    '    // TODO: 替换 {} as Record<string, never> 为真实 payload 类型',
    `    ${method}: withPayload(IPC_META.${domain}.${method}, {} as Record<string, never>),`,
  ].join('\n');
}

/** 新域块（meta.ts 用，块前空行与上一域分隔） */
function metaDomainBlock(spec: MethodSpec): string {
  return `\n  ${spec.domain}: {\n${metaEntryLine(spec)}\n  },\n`;
}

/** 新域块（definitions.ts 用，块前空行与上一域分隔） */
function definitionsDomainBlock(spec: MethodSpec): string {
  return `\n  ${spec.domain}: {\n${definitionsEntryBlock(spec)}\n  },\n`;
}

/** handler 骨架文件内容 */
function buildHandlerFile(spec: MethodSpec): string {
  const { domain, method, kind } = spec;
  const Domain = camelToPascal(domain);
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
          '    // TODO: 返回类型需与 definitions.ts 的 res 占位一致',
          '    return { ok: true };',
          '  },',
        ].join('\n')
      : '  // TODO: 定义表新增 request 方法后在此实现（缺失会编译期报错）';

  return [
    `// src/main/ipc/${domain}.handler.ts`,
    `// ${Domain} 域 IPC handler（定义表驱动，注册由 registerIpcHandlers 统一执行）`,
    '//',
    `// 当前实现 1 个 channel：`,
    channelsLine,
    '//',
    '// 说明：handler 对象形状受 InferHandlers 约束（缺方法编译期报错）；',
    '// channel / schema 由 IPC_DEFINITIONS 提供，本文件只写业务实现。',
    '',
    `import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';`,
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

/** 写入 handler 骨架（已存在时仅提示） */
function writeHandlerSkeleton(spec: MethodSpec): void {
  const relative = `src/main/ipc/${spec.domain}.handler.ts`;
  const abs = path.join(REPO_ROOT, relative);
  if (existsSync(abs)) {
    console.log(`[跳过] handler 已存在：${relative}`);
    if (spec.kind === 'request') {
      console.log(`  → 请在该文件补实现 ${spec.domain}.${spec.method}（缺失会编译期报错）`);
    }
    return;
  }
  writeFileSync(abs, buildHandlerFile(spec), 'utf8');
  console.log(`[生成] ${relative}`);
}

/** 打印手动步骤指引 */
function printManualSteps(spec: MethodSpec): void {
  const { domain, kind } = spec;
  const Domain = camelToPascal(domain);
  console.log('');
  console.log('手动完成（脚手架无法机械推断的部分）：');
  console.log(`  1. src/main/index.ts 的 registerIpcHandlers({ ... }) 中注册：`);
  console.log(`       ${domain}: ${domain}Handlers,`);
  console.log(`     或按需改造为工厂注入服务（参考 createFileHandlers({ fileService })）：`);
  console.log(`       ${domain}: create${Domain}Handlers({ /* TODO: 注入服务 */ }),`);
  console.log(
    `  2. definitions.ts：把占位 schema/res 替换为真实类型（建议新建 packages/shared/src/schemas/${domain}.ts）`,
  );
  if (kind === 'request') {
    console.log(
      `  3. 为 handler 补测试：src/main/ipc/${domain}.handler.test.ts（参考 dialog.handler.test.ts）`,
    );
  }
  console.log('');
  console.log('红利已自动生效（无需手写）：');
  console.log('  - IPC_CHANNELS 常量 / window.api（preload createIpcApi）/ IpcApi 类型');
  console.log('  - registerIpcHandlers 自动注册（handler 缺失 → 编译期报错）');
}

/** 主流程 */
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  rejectPositionals(parsed);
  const spec = buildMethodSpec(parsed);
  const channel = `${spec.domain}:${spec.method}`;
  const domainHeader = `  ${spec.domain}: {`;

  // 1. meta.ts：插入通道元数据（幂等检查用 request('x')/event('x') 完整形式）
  const metaPath = 'packages/shared/src/ipc/meta.ts';
  const metaSource = readSource(metaPath);
  assertChannelAbsent(metaSource, metaPath, `('${channel}')`, channel);
  const metaUpdated = metaSource.includes(domainHeader)
    ? insertIntoObjectBlock(metaSource, domainHeader, metaEntryLine(spec))
    : insertBeforeAnchor(metaSource, '} as const;', metaDomainBlock(spec));
  if (metaUpdated === null) {
    throw new Error(`meta.ts 插入失败：未找到块 ${domainHeader} 或锚点 '} as const;'`);
  }
  writeFileSync(path.join(REPO_ROOT, metaPath), metaUpdated, 'utf8');
  console.log(`[更新] ${metaPath}（${channel}）`);

  // 2. definitions.ts：插入占位 schema（幂等检查用 IPC_META 引用形式）
  const defsPath = 'packages/shared/src/ipc/definitions.ts';
  const defsSource = readSource(defsPath);
  assertChannelAbsent(defsSource, defsPath, `IPC_META.${spec.domain}.${spec.method}`, channel);
  const defsUpdated = defsSource.includes(domainHeader)
    ? insertIntoObjectBlock(defsSource, domainHeader, definitionsEntryBlock(spec))
    : insertBeforeAnchor(defsSource, '} as const;', definitionsDomainBlock(spec));
  if (defsUpdated === null) {
    throw new Error(`definitions.ts 插入失败：未找到块 ${domainHeader} 或锚点 '} as const;'`);
  }
  writeFileSync(path.join(REPO_ROOT, defsPath), defsUpdated, 'utf8');
  console.log(`[更新] ${defsPath}（占位 schema，TODO 待替换）`);

  // 3. handler 骨架
  writeHandlerSkeleton(spec);

  printManualSteps(spec);
}

try {
  main();
} catch (error: unknown) {
  console.error(`[失败] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

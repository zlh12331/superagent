// scripts/scaffold/scaffold-tool.ts
// Tool 脚手架：从工具名生成 AI 工具代码骨架并接入注册表
// ──────────────────────────────────────────────────────────────
// 用法：
//   pnpm scaffold:tool --name <snake_case> [--permission auto|ask] [--desc <描述>]
//
// 示例：
//   pnpm scaffold:tool --name fetch_url --permission ask --desc "抓取网页正文"
//
// 自动完成：
//   1. src/main/infra/ai/tools/{kebab}.tool.ts 生成工具骨架（工厂函数 + zod schema）
//   2. src/main/infra/ai/tools/index.ts 三处接入（import / export / registerBuiltinTools）
//
// 手动完成（打印指引）：
//   - 实现 execute 逻辑与入参 schema；需要服务依赖时改为工厂注入
//   - 补测试（参考 read-file.tool.test.ts / run-command.tool.test.ts）
// ──────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optionalValue, parseArgs, rejectPositionals, requireValue } from './lib/args';
import { isValidPermission, isValidToolName, snakeToKebab, snakeToPascal } from './lib/naming';
import { insertAfterLastLine, insertSortedLine } from './lib/text';

/** 仓库根（scripts/scaffold/ → 根） */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface ToolSpec {
  readonly name: string;
  readonly permission: 'auto' | 'ask';
  readonly description: string;
}

/** 校验 + 组装工具描述 */
function buildToolSpec(parsedArgs: ReturnType<typeof parseArgs>): ToolSpec {
  const name = requireValue(parsedArgs, 'name');
  const permission = optionalValue(parsedArgs, 'permission', 'auto');
  const description = optionalValue(
    parsedArgs,
    'desc',
    'TODO: 一句话描述工具职责（LLM 选择工具的依据）',
  );

  if (!isValidToolName(name)) {
    throw new Error(`非法 tool name：${name}（要求 snake_case 小写，如 read_file / git_commit）`);
  }
  if (!isValidPermission(permission)) {
    throw new Error(`非法 permission：${permission}（仅支持 auto / ask）`);
  }
  return { name, permission: permission as 'auto' | 'ask', description };
}

/** 生成 tool 文件内容 */
function buildToolFileText(spec: ToolSpec): string {
  const { name, permission, description } = spec;
  const kebab = snakeToKebab(name);
  const Pascal = snakeToPascal(name);

  return [
    `// src/main/infra/ai/tools/${kebab}.tool.ts`,
    `// ${name} 工具：${description}`,
    '// ──────────────────────────────────────────────',
    '// 职责：',
    '// - TODO: 描述工具职责与适用场景（LLM 何时调用）',
    '//',
    `// 权限：'${permission}'（auto=只读自动执行 / ask=写操作需审批）`,
    '//',
    '// 入参：',
    "// - TODO: 字段列表（z.string().describe('参数说明')）",
    '//',
    '// 输出：ToolResult（title + output 文本 + metadata 结构化数据）',
    '// ──────────────────────────────────────────────',
    '',
    "import { z } from 'zod';",
    '',
    "import type { Tool, ToolContext, ToolResult } from '../tool';",
    '',
    `const ${Pascal}InputSchema = z.object({`,
    "  // TODO: 定义 LLM 可见的入参（z.string().describe('参数说明')）",
    '});',
    '',
    `type ${Pascal}Input = z.infer<typeof ${Pascal}InputSchema>;`,
    '',
    `export function create${Pascal}Tool(): Tool<${Pascal}Input> {`,
    '  return {',
    `    name: '${name}',`,
    `    description: '${description}',`,
    `    inputSchema: ${Pascal}InputSchema,`,
    `    permission: '${permission}',`,
    `    execute: async (input: ${Pascal}Input, ctx: ToolContext): Promise<ToolResult> => {`,
    '      // TODO: 实现工具逻辑；需要服务依赖时改为工厂注入（参考 read-file.tool.ts）',
    '      void input;',
    '      void ctx;',
    '      return {',
    "        title: 'TODO: 结果标题',",
    "        output: '',",
    '        metadata: {},',
    '      };',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

/** tools/index.ts 的 import 行模式（工厂导入，仅匹配 import） */
const TOOL_IMPORT_RE = /^import \{ create[A-Z]\w+Tool \} from '\.\/[a-z0-9-]+\.tool';$/m;

/** tools/index.ts 的 export 行模式（含路径守卫导出，按 from 路径参与排序） */
const TOOL_EXPORT_RE = /^export \{ [A-Za-z]\w+ \} from '\.\/[a-z0-9-]+';$/m;

/** 从 export 行提取 from 路径（如 './read-file.tool'），用于字典序 */
const FROM_PATH_RE = /from '(\.\/[a-z0-9.-]+)'/;

/** export 行排序键：from 路径（整行比较会因导出名差异破坏路径顺序） */
function exportKeyOf(line: string): string {
  const match = line.match(FROM_PATH_RE);
  return match?.[1] ?? line;
}

/** 更新 tools/index.ts：import + export + register 三处接入 */
function updateToolIndex(spec: ToolSpec): string | null {
  const { name } = spec;
  const kebab = snakeToKebab(name);
  const Pascal = snakeToPascal(name);
  const relative = 'src/main/infra/ai/tools/index.ts';
  const abs = path.join(REPO_ROOT, relative);
  if (!existsSync(abs)) {
    throw new Error(`目标文件不存在：${relative}`);
  }
  const source = readFileSync(abs, 'utf8');

  // 幂等：工厂名已存在则拒绝
  const factoryName = `create${Pascal}Tool`;
  if (source.includes(factoryName)) {
    throw new Error(`工具已存在（${relative}）：${factoryName}，请勿重复脚手架`);
  }

  const importLine = `import { ${factoryName} } from './${kebab}.tool';`;
  const exportLine = `export { ${factoryName} } from './${kebab}.tool';`;

  const withImport = insertSortedLine(source, TOOL_IMPORT_RE, importLine, (line) => line);
  if (withImport === null) {
    throw new Error(`${relative} 插入失败：未找到 import 行`);
  }
  const withExport = insertSortedLine(withImport, TOOL_EXPORT_RE, exportLine, exportKeyOf);
  if (withExport === null) {
    throw new Error(`${relative} 插入失败：未找到 export 行`);
  }

  // 注册行追加到 registerBuiltinTools 末尾（无依赖默认，需要注入服务时手动改）
  const registerLine = `  registry.register(${factoryName}());`;
  const withRegister = insertAfterLastLine(
    withExport,
    /^ {2}registry\.register\(create\w+Tool\(.*\)\);$/m,
    `\n${registerLine}`,
  );
  if (withRegister === null) {
    throw new Error(`${relative} 插入失败：未找到 registerBuiltinTools 注册行`);
  }

  writeFileSync(abs, withRegister, 'utf8');
  console.log(`[更新] ${relative}（import / export / register 三处已接入）`);
  return relative;
}

/** 生成 tool 骨架文件 */
function writeToolFile(spec: ToolSpec): string {
  const kebab = snakeToKebab(spec.name);
  const relative = `src/main/infra/ai/tools/${kebab}.tool.ts`;
  const abs = path.join(REPO_ROOT, relative);
  if (existsSync(abs)) {
    throw new Error(`工具文件已存在：${relative}（请勿覆盖）`);
  }
  writeFileSync(abs, buildToolFileText(spec), 'utf8');
  console.log(`[生成] ${relative}`);
  return relative;
}

/** 打印手动步骤指引 */
function printManualSteps(spec: ToolSpec): void {
  const { name, permission } = spec;
  const Pascal = snakeToPascal(name);
  console.log('');
  console.log('手动完成（脚手架无法机械推断的部分）：');
  console.log(`  1. 实现 execute 逻辑与入参 schema（${Pascal}InputSchema）`);
  console.log(`  2. 需要服务依赖时改为工厂注入（如 create${Pascal}Tool(fileService)），`);
  console.log('     并同步修改 index.ts 的注册行参数与 registerBuiltinTools 注释表');
  console.log('  3. 补测试：src/main/infra/ai/tools/*.test.ts（参考 run-command.tool.test.ts）');
  console.log('');
  if (permission === 'ask') {
    console.log(`权限说明：已设为 'ask'（审批后执行）；如为只读工具可改为 'auto'`);
  } else {
    console.log("权限说明：已设为 'auto'（自动执行）；如为写操作工具请改为 'ask'（审批后执行）");
  }
}

/** 主流程 */
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  rejectPositionals(parsed);
  const spec = buildToolSpec(parsed);

  writeToolFile(spec);
  updateToolIndex(spec);
  printManualSteps(spec);
}

try {
  main();
} catch (error: unknown) {
  console.error(`[失败] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

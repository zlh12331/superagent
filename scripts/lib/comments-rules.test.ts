// scripts/lib/comments-rules.test.ts
// 注释规则核反例 fixture 测试：每条规则「最小违规样本必须命中 + 干净样本必须放过」
// ──────────────────────────────────────────────────────────────
// 背景外部审计点名 check-comments 判据内联零测试（L2 缺口）——本文件补齐。
// ──────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { type CommentProblem, createCommentRules, PNPM_BUILTIN } from './comments-rules';

/** fixture 假仓库根：规则 B 的相对路径解析基准（3 行文件，供 #L 行号断言） */
const fixtureRoot = mkdtempSync(join(tmpdir(), 'comments-rules-'));
writeFileSync(join(fixtureRoot, 'exists.ts'), 'export {}\n'.repeat(3));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const RULES = createCommentRules({
  root: fixtureRoot,
  rootScripts: new Set(['typecheck', 'lint']),
  binStems: new Set(['drizzle-kit']),
  todoStaleDays: 90,
});

/** 运行单条规则于样本内容，返回命中 */
function run(
  check: (content: string, file: string, problems: CommentProblem[]) => void,
  content: string,
): CommentProblem[] {
  const problems: CommentProblem[] = [];
  check(content, 'a.ts', problems);
  return problems;
}

const errorRules = (problems: readonly CommentProblem[]): string[] =>
  problems.filter((p) => p.level === 'error').map((p) => p.rule);

describe('规则 A · stale-param（JSDoc @param 与签名一致性）', () => {
  it('反例：@param 名不在签名中 → error', () => {
    const content = '/**\n * @param oldName 旧参数\n */\nfunction f(newName: string) {}';
    expect(errorRules(run(RULES.checkJsDoc, content))).toContain('stale-param');
  });

  it('正例：@param 名与签名一致 → 无命中', () => {
    const content = '/**\n * @param name 参数\n */\nfunction f(name: string) {}';
    expect(run(RULES.checkJsDoc, content)).toHaveLength(0);
  });

  it('边界：签名参数为空（size 0）→ 不判（避免误报）', () => {
    const content = '/**\n * @param ghost 无参函数的注释\n */\nfunction f() {}';
    expect(run(RULES.checkJsDoc, content)).toHaveLength(0);
  });
});

describe('规则 B · stale-file-ref / stale-line-ref（file:/// 引用）', () => {
  it('反例：引用不存在的相对路径 → error', () => {
    expect(
      errorRules(run(RULES.checkFileRefs, '参见 [x](file:///src/not-exist-abc.ts)')),
    ).toContain('stale-file-ref');
  });

  it('反例：#L 行号超出目标文件实际行数 → error', () => {
    expect(errorRules(run(RULES.checkFileRefs, '参见 [x](file:///exists.ts#L999)'))).toContain(
      'stale-line-ref',
    );
  });

  it('正例：存在的路径与未越界行号 → 无命中', () => {
    expect(run(RULES.checkFileRefs, '参见 [x](file:///exists.ts#L2)')).toHaveLength(0);
  });

  it('边界：模板插值路径（运行时构造）→ 跳过', () => {
    const dynamic = 'dynamic';
    expect(run(RULES.checkFileRefs, '参见 file:///$' + '{' + dynamic + '}')).toHaveLength(0);
  });
});

describe('规则 C · todo-stale（TODO/FIXME 过期）', () => {
  it('反例：带日期超 90 天 → error', () => {
    expect(errorRules(run(RULES.checkTodos, '// TODO(2020-01-01): 老待办'))).toContain(
      'todo-stale',
    );
  });

  it('正例：近期日期 → 无 error', () => {
    const fresh = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(errorRules(run(RULES.checkTodos, `// TODO(${fresh}): 新待办`))).toHaveLength(0);
  });

  it('边界：无日期 TODO → warning（不卡关）', () => {
    const problems = run(RULES.checkTodos, '// TODO: 补日期');
    expect(errorRules(problems)).toHaveLength(0);
    expect(problems.some((p) => p.rule === 'todo-no-date' && p.level === 'warning')).toBe(true);
  });
});

describe('规则 D · stale-command（pnpm 命令引用）', () => {
  it('反例：行内 `pnpm not-a-cmd` → error', () => {
    expect(errorRules(run(RULES.checkCommandRefs, '用 `pnpm not-a-cmd` 构建'))).toContain(
      'stale-command',
    );
  });

  it('反例：md 围栏内行首已删命令 → error', () => {
    const content = ['```sh', 'pnpm defunct-command', '```'].join('\n');
    expect(errorRules(run(RULES.checkCommandRefs, content))).toContain('stale-command');
  });

  it('正例：内置命令 / scripts 键 / .bin 工具 → 无命中', () => {
    const content = ['`pnpm test`', '`pnpm typecheck`', '`pnpm drizzle-kit generate`'].join('\n');
    expect(run(RULES.checkCommandRefs, content)).toHaveLength(0);
  });

  it('边界：旗标与描述性裸文本不误报', () => {
    const content = ['`pnpm -r build`', 'pnpm workspace 配置说明（裸文本）'].join('\n');
    expect(run(RULES.checkCommandRefs, content)).toHaveLength(0);
  });

  it('PNPM_BUILTIN 集合非空（防手滑清空导致全量误报）', () => {
    expect(PNPM_BUILTIN.size).toBeGreaterThan(20);
  });
});

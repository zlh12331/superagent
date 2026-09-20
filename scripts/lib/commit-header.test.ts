// scripts/lib/commit-header.test.ts
// 提交标题严格校验单测
// ──────────────────────────────────────────────────────────────
// 覆盖动机：该模块是「发版通道静默阻断」的唯一防线——commitlint 会放行双 type
// 标题（贪婪括号匹配），而 release-please 拒绝它并跳过提交（0 commits → 不开
// Release PR）。用例包含真实事故标题作为回归锚。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import commitlintConfig from '../../commitlint.config.js';
import { ALLOWED_TYPES, checkCommitHeader, STRICT_HEADER_PATTERN } from './commit-header';

describe('checkCommitHeader', () => {
  describe('回归锚：真实事故标题（2026-09-20 PR #56 阻断发版）', () => {
    it('双 type 拼接被拒绝，且诊断指明问题', () => {
      const result = checkCommitHeader(
        'fix(autostart)+build(release): 开机自启链路修复 + 多架构发布矩阵（Linux 6 / Windows 2 / macOS 2) (#56)',
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('两个 type');
    });

    it('同类变体同样被拒绝（feat+fix / 带空格 / 双括号）', () => {
      for (const bad of [
        'feat(ui)+fix(chat): 混合提交',
        'fix(a) + build(b): 带空格拼接',
        'fix(autostart)+build(release): 双 type',
      ]) {
        expect(checkCommitHeader(bad).ok, bad).toBe(false);
      }
    });
  });

  describe('合法标题', () => {
    it('标准形式通过', () => {
      for (const good of [
        'fix(autostart): 开机自启链路修复',
        'feat: 新增多架构发布',
        'chore(main): release 1.3.2',
        'build(release): 发布矩阵扩展',
        'docs(design): 补 27-spec 实施记录',
        'refactor(update): 抽出缓存模块',
        'test(scripts): 补提交标题校验用例',
        'perf(renderer): 减少重渲染',
        'style(ui): 统一缩进',
        'revert(agent): 回滚某次改动',
        'ci(quality): 调整 job 依赖',
      ]) {
        expect(checkCommitHeader(good).ok, good).toBe(true);
      }
    });

    it('带破坏性标记 ! 通过（scope 后与无 scope 两种）', () => {
      expect(checkCommitHeader('feat(api)!: 移除旧接口').ok).toBe(true);
      expect(checkCommitHeader('feat!: 移除旧接口').ok).toBe(true);
    });

    it('scope 含点/下划线/连字符/数字通过（如 27-spec、v2、a_b）', () => {
      expect(checkCommitHeader('docs(27-spec): 更新').ok).toBe(true);
      expect(checkCommitHeader('fix(a_b): 修复').ok).toBe(true);
      expect(checkCommitHeader('chore(v2): 升级').ok).toBe(true);
    });

    it('subject 含中文/空格/符号通过', () => {
      expect(checkCommitHeader('fix(x): 修复「无法关闭」弹窗').ok).toBe(true);
      expect(checkCommitHeader('fix(x): 处理 a+b 与 c/d').ok).toBe(true);
    });
  });

  describe('其他格式违规', () => {
    it('未知 type 被拒绝', () => {
      expect(checkCommitHeader('update(x): 未知类型').ok).toBe(false);
      expect(checkCommitHeader('breaking(x): 不存在的 type').ok).toBe(false);
    });

    it('缺冒号 / 缺空格 / 空 subject 被拒绝', () => {
      expect(checkCommitHeader('fix(autostart) 开机自启').ok).toBe(false);
      expect(checkCommitHeader('fix(autostart):无空格').ok).toBe(false);
      expect(checkCommitHeader('fix(autostart): ').ok).toBe(false);
      expect(checkCommitHeader('fix(autostart):').ok).toBe(false);
    });

    it('scope 含大写或特殊字符被拒绝', () => {
      expect(checkCommitHeader('fix(AutoStart): 大写 scope').ok).toBe(false);
      expect(checkCommitHeader('fix(auto start): 含空格 scope').ok).toBe(false);
      expect(checkCommitHeader('fix(): 空 scope').ok).toBe(false);
    });

    it('type 前有空格 / 多余前缀被拒绝', () => {
      expect(checkCommitHeader(' fix(x): 前导空格').ok).toBe(true); // trim 后合法
      expect(checkCommitHeader('[WIP] fix(x): 前缀').ok).toBe(false);
      expect(checkCommitHeader('FIX(x): 大写 type').ok).toBe(false);
    });

    it('空标题被拒绝', () => {
      expect(checkCommitHeader('').ok).toBe(false);
      expect(checkCommitHeader('   ').ok).toBe(false);
    });
  });

  describe('放行项（git 生成或规范的例外）', () => {
    it('Merge / Revert 合并提交放行', () => {
      expect(checkCommitHeader("Merge branch 'main' into feature").ok).toBe(true);
      expect(checkCommitHeader('Merge pull request #56 from x/y').ok).toBe(true);
      expect(checkCommitHeader('Revert "fix(x): 某改动"').ok).toBe(true);
    });

    it('fixup! / squash! 前缀放行（rebase 中间态）', () => {
      expect(checkCommitHeader('fixup! fix(x): 某改动').ok).toBe(true);
      expect(checkCommitHeader('squash! fix(x): 某改动').ok).toBe(true);
    });
  });

  describe('与 commitlint 配置的一致性（防两处 type 枚举漂移）', () => {
    it('ALLOWED_TYPES 与 commitlint.config.js 的 type-enum 完全一致', () => {
      const rules = (commitlintConfig as { rules?: Record<string, unknown> }).rules ?? {};
      const typeEnumRule = rules['type-enum'] as [number, string, string[]] | undefined;
      expect(typeEnumRule).toBeDefined();
      const configured = typeEnumRule?.[2] ?? [];
      expect([...ALLOWED_TYPES]).toEqual(configured);
    });

    it('严格模式与实际用到的一致性：正则能匹配每个白名单 type', () => {
      for (const type of ALLOWED_TYPES) {
        expect(STRICT_HEADER_PATTERN.test(`${type}(x): 标题`), type).toBe(true);
        expect(STRICT_HEADER_PATTERN.test(`${type}: 标题`), type).toBe(true);
      }
    });
  });
});

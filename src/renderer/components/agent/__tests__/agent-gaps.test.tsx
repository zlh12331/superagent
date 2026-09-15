// src/renderer/components/agent/__tests__/agent-gaps.test.tsx
// agent 域批次4 缺口补全：approval-preview 结构化预览组件
// （approval-utils 断言已收敛至 approval-utils.test.ts，此处不重复）
//
// 测试要点：
// 1. run_command / write_file / edit_file / git_add / git_commit / git_push
//    结构化渲染（组件化后经 StructuredPreview 入口 + ThemeProvider）
// 2. 无专属预览的类型返回 null

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { StructuredPreview } from '../approval-preview';

const t = i18n.t.bind(i18n);

function renderPreview(type: Parameters<typeof StructuredPreview>[0]['type'], input: unknown) {
  return render(
    <ThemeProvider>
      <StructuredPreview type={type} input={input} />
    </ThemeProvider>,
  );
}

describe('agent 批次4 缺口补全', () => {
  describe('approval-preview 结构化预览', () => {
    it('run_command：渲染命令 + 工作目录', () => {
      renderPreview('run_command', { command: 'npm test', cwd: '/proj' });
      expect(screen.getByText('npm test')).toBeDefined();
      expect(screen.getByText('/proj')).toBeDefined();
    });

    it('run_command 无 cwd：不渲染工作目录行', () => {
      renderPreview('run_command', { command: 'ls' });
      expect(screen.getByText('ls')).toBeDefined();
      expect(screen.queryByText('/proj')).toBeNull();
    });

    it('write_file：路径 + 内容 diff + append 标记', () => {
      renderPreview('write_file', {
        path: '/proj/a.ts',
        content: 'export const a = 1;',
        append: true,
      });
      expect(screen.getByText('/proj/a.ts')).toBeDefined();
      expect(screen.getByText(t('approval.appendMode'))).toBeDefined();
    });

    it('edit_file：路径 + replaceAll 标记', () => {
      renderPreview('edit_file', {
        path: '/proj/b.ts',
        oldString: 'a',
        newString: 'b',
        replaceAll: true,
      });
      expect(screen.getByText('/proj/b.ts')).toBeDefined();
      expect(screen.getByText(t('approval.replaceAll'))).toBeDefined();
    });

    it('git_add：paths 列表渲染', () => {
      renderPreview('git_add', { paths: ['/a/1.ts', '/a/2.ts'] });
      expect(screen.getByText('/a/1.ts')).toBeDefined();
      expect(screen.getByText('/a/2.ts')).toBeDefined();
      expect(screen.getByText(t('approval.stagePaths', { count: 2 }))).toBeDefined();
    });

    it('git_add 空 paths：全部改动', () => {
      renderPreview('git_add', {});
      expect(screen.getByText(t('approval.stageAll'))).toBeDefined();
    });

    it('git_commit：消息 + amend 标记', () => {
      renderPreview('git_commit', { message: 'feat: x', amend: true });
      expect(screen.getByText('feat: x')).toBeDefined();
      expect(screen.getByText(t('approval.commitAmend'))).toBeDefined();
      expect(screen.getByText(t('approval.unavailable'))).toBeDefined();
    });

    it('git_push：组合标记（setUpstream + force + 默认 remote）', () => {
      renderPreview('git_push', {
        remote: 'upstream',
        refspec: 'main',
        setUpstream: true,
        force: true,
      });
      expect(screen.getByText(/git push -u --force-with-lease upstream\/main/)).toBeDefined();
      expect(screen.getByText(t('approval.setUpstream'))).toBeDefined();
      expect(screen.getByText(t('approval.forcePush'))).toBeDefined();
    });

    it('git_push 默认值：origin + 当前分支 + normalPush', () => {
      renderPreview('git_push', {});
      expect(screen.getByText(/git push origin\/<current-branch>/)).toBeDefined();
      expect(screen.getByText(t('approval.normalPush'))).toBeDefined();
      expect(screen.getByText(t('approval.pushWarning'))).toBeDefined();
    });

    it('apply_patch / delete_file / install_package：无专属预览（null）', () => {
      for (const type of ['apply_patch', 'delete_file', 'install_package'] as const) {
        const { container } = renderPreview(type, {});
        expect(container.firstChild).toBeNull();
        container.remove();
      }
    });
  });

  describe('approval i18n 键契约', () => {
    // check:i18n 对动态模板前缀域（approval.types./chat./git. 等）豁免冗余与缺失检查，
    // 新增 ApprovalType 而漏加 i18n 键不会被静态审计发现——此处做运行时兜底：
    // i18next 缺键时返回键本身，故「翻译 ≠ 键」即键存在。
    // 协议键收进 approval.types 子段：协议域（snake_case）与 UI 键域（camelCase）分区。
    it('10 类型均有 approval.types.<type> 键', () => {
      const types = [
        'run_command',
        'write_file',
        'edit_file',
        'delete_file',
        'apply_patch',
        'install_package',
        'external_call',
        'git_add',
        'git_commit',
        'git_push',
      ] as const;
      for (const type of types) {
        const key = `approval.types.${type}`;
        expect(t(key), `${key} 缺失`).not.toBe(key);
      }
    });
  });
});

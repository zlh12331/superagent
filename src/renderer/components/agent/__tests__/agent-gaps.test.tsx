// src/renderer/components/agent/__tests__/agent-gaps.test.tsx
// agent 域批次4 缺口补全：approval-utils 纯函数 + approval-preview 渲染函数
//
// 测试要点：
// 1. approval-utils：字段安全读取（string/boolean/string[]）/ 图标与标签映射 /
//    变体徽章 / 危险判定 / 记住决策判定
// 2. approval-preview：run_command / write_file / edit_file / git_add / git_commit /
//    git_push 结构化渲染 + 其他类型 null

import { render, screen } from '@testing-library/react';
import {
  CloudUpload,
  FileDiff,
  FileEdit,
  FilePlus,
  FileX,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Package,
  Terminal,
} from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n/config';
import { renderGitPreview, renderStructuredPreview } from '../approval-preview';
import {
  canRememberDecision,
  getBooleanField,
  getField,
  getIconForType,
  getLabelKeyForType,
  getStringArrayField,
  getVariantForType,
  isDangerousType,
} from '../approval-utils';

const t = i18n.t.bind(i18n);

describe('agent 批次4 缺口补全', () => {
  describe('approval-utils 纯函数', () => {
    it('getField：正常/非对象/null/非字符串', () => {
      expect(getField({ command: 'npm test' }, 'command')).toBe('npm test');
      expect(getField('string', 'x')).toBeUndefined();
      expect(getField(null, 'x')).toBeUndefined();
      expect(getField({ count: 42 }, 'count')).toBeUndefined();
    });

    it('getBooleanField：true/false/非布尔', () => {
      expect(getBooleanField({ force: true }, 'force')).toBe(true);
      expect(getBooleanField({ force: false }, 'force')).toBe(false);
      expect(getBooleanField({ force: 'yes' }, 'force')).toBeUndefined();
      expect(getBooleanField(null, 'force')).toBeUndefined();
    });

    it('getStringArrayField：正常/非数组/含非字符串元素', () => {
      expect(getStringArrayField({ paths: ['/a', '/b'] }, 'paths')).toEqual(['/a', '/b']);
      expect(getStringArrayField({ paths: '/a' }, 'paths')).toBeUndefined();
      expect(getStringArrayField({ paths: ['/a', 42] }, 'paths')).toBeUndefined();
      expect(getStringArrayField(null, 'paths')).toBeUndefined();
    });

    it('getIconForType：10 类型映射 + 未知兜底', () => {
      expect(getIconForType('run_command')).toBe(Terminal);
      expect(getIconForType('write_file')).toBe(FilePlus);
      expect(getIconForType('edit_file')).toBe(FileEdit);
      expect(getIconForType('delete_file')).toBe(FileX);
      expect(getIconForType('apply_patch')).toBe(FileDiff);
      expect(getIconForType('install_package')).toBe(Package);
      expect(getIconForType('external_call')).toBe(Globe);
      expect(getIconForType('git_add')).toBe(GitBranch);
      expect(getIconForType('git_commit')).toBe(GitCommitHorizontal);
      expect(getIconForType('git_push')).toBe(CloudUpload);
      expect(getIconForType('unknown_type' as never)).toBe(Globe);
    });

    it('getLabelKeyForType：10 类型映射 + 未知兜底', () => {
      expect(getLabelKeyForType('run_command')).toBe('runCommand');
      expect(getLabelKeyForType('write_file')).toBe('writeFile');
      expect(getLabelKeyForType('edit_file')).toBe('editFile');
      expect(getLabelKeyForType('delete_file')).toBe('deleteFile');
      expect(getLabelKeyForType('apply_patch')).toBe('applyPatch');
      expect(getLabelKeyForType('install_package')).toBe('installDependency');
      expect(getLabelKeyForType('external_call')).toBe('externalCall');
      expect(getLabelKeyForType('git_add')).toBe('gitStage');
      expect(getLabelKeyForType('git_commit')).toBe('gitCommit');
      expect(getLabelKeyForType('git_push')).toBe('gitPush');
      expect(getLabelKeyForType('unknown_type' as never)).toBe('externalCall');
    });

    it('getVariantForType：5 类别 + 未知兜底', () => {
      expect(getVariantForType('run_command').className).toContain('warn');
      expect(getVariantForType('write_file').className).toContain('info-blue');
      expect(getVariantForType('edit_file').className).toContain('info-blue');
      expect(getVariantForType('apply_patch').className).toContain('info-blue');
      expect(getVariantForType('delete_file').className).toContain('error');
      expect(getVariantForType('install_package').className).toContain('magenta');
      expect(getVariantForType('external_call').className).toContain('accent-2');
      expect(getVariantForType('git_push').className).toContain('magenta');
      expect(getVariantForType('unknown_type' as never).className).toContain('muted');
    });

    it('isDangerousType：4 种危险 + 其余安全', () => {
      expect(isDangerousType('delete_file')).toBe(true);
      expect(isDangerousType('run_command')).toBe(true);
      expect(isDangerousType('install_package')).toBe(true);
      expect(isDangerousType('git_push')).toBe(true);
      expect(isDangerousType('write_file')).toBe(false);
      expect(isDangerousType('git_commit')).toBe(false);
    });

    it('canRememberDecision：仅 run_command/write_file/edit_file', () => {
      expect(canRememberDecision('run_command')).toBe(true);
      expect(canRememberDecision('write_file')).toBe(true);
      expect(canRememberDecision('edit_file')).toBe(true);
      expect(canRememberDecision('delete_file')).toBe(false);
      expect(canRememberDecision('git_push')).toBe(false);
      expect(canRememberDecision('external_call')).toBe(false);
    });
  });

  describe('approval-preview 渲染函数', () => {
    it('run_command：渲染命令 + 工作目录', () => {
      render(
        renderStructuredPreview('run_command', { command: 'npm test', cwd: '/proj' }, t, false),
      );
      expect(screen.getByText('npm test')).toBeDefined();
      expect(screen.getByText('/proj')).toBeDefined();
    });

    it('run_command 无 cwd：不渲染工作目录行', () => {
      render(renderStructuredPreview('run_command', { command: 'ls' }, t, false));
      expect(screen.getByText('ls')).toBeDefined();
      expect(screen.queryByText('/proj')).toBeNull();
    });

    it('write_file：路径 + 内容 diff + append 标记', () => {
      render(
        renderStructuredPreview(
          'write_file',
          { path: '/proj/a.ts', content: 'export const a = 1;', append: true },
          t,
          false,
        ),
      );
      expect(screen.getByText('/proj/a.ts')).toBeDefined();
      expect(screen.getByText(t('approval.appendMode'))).toBeDefined();
    });

    it('edit_file：路径 + replaceAll 标记', () => {
      render(
        renderStructuredPreview(
          'edit_file',
          { path: '/proj/b.ts', oldString: 'a', newString: 'b', replaceAll: true },
          t,
          false,
        ),
      );
      expect(screen.getByText('/proj/b.ts')).toBeDefined();
      expect(screen.getByText(t('approval.replaceAll'))).toBeDefined();
    });

    it('git_add：paths 列表渲染', () => {
      render(renderGitPreview('git_add', { paths: ['/a/1.ts', '/a/2.ts'] }, t));
      expect(screen.getByText('/a/1.ts')).toBeDefined();
      expect(screen.getByText('/a/2.ts')).toBeDefined();
      expect(screen.getByText(t('approval.stagePaths', { count: 2 }))).toBeDefined();
    });

    it('git_add 空 paths：全部改动', () => {
      render(renderGitPreview('git_add', {}, t));
      expect(screen.getByText(t('approval.stageAll'))).toBeDefined();
    });

    it('git_commit：消息 + amend 标记', () => {
      render(renderGitPreview('git_commit', { message: 'feat: x', amend: true }, t));
      expect(screen.getByText('feat: x')).toBeDefined();
      expect(screen.getByText(t('approval.commitAmend'))).toBeDefined();
      expect(screen.getByText(t('approval.unavailable'))).toBeDefined();
    });

    it('git_push：组合标记（setUpstream + force + 默认 remote）', () => {
      render(
        renderGitPreview(
          'git_push',
          { remote: 'upstream', refspec: 'main', setUpstream: true, force: true },
          t,
        ),
      );
      expect(screen.getByText(/git push -u --force-with-lease upstream\/main/)).toBeDefined();
      expect(screen.getByText(t('approval.setUpstream'))).toBeDefined();
      expect(screen.getByText(t('approval.forcePush'))).toBeDefined();
    });

    it('git_push 默认值：origin + 当前分支 + normalPush', () => {
      render(renderGitPreview('git_push', {}, t));
      expect(screen.getByText(/git push origin\/<current-branch>/)).toBeDefined();
      expect(screen.getByText(t('approval.normalPush'))).toBeDefined();
      expect(screen.getByText(t('approval.pushWarning'))).toBeDefined();
    });

    it('apply_patch / delete_file：不渲染额外预览（null）', () => {
      expect(renderStructuredPreview('apply_patch', {}, t, false)).toBeNull();
      expect(renderStructuredPreview('delete_file', {}, t, false)).toBeNull();
      expect(renderGitPreview('install_package', {}, t)).toBeNull();
    });
  });
});

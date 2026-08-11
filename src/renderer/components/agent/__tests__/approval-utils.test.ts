// src/renderer/components/agent/__tests__/approval-utils.test.ts
// approval-utils 纯函数单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. getIconForType / getLabelKeyForType / getVariantForType：全部类型映射 + 未知类型兜底
// 2. isDangerousType / canRememberDecision
// 3. getField / getBooleanField / getStringArrayField 类型守卫
// ──────────────────────────────────────────────────────────────

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

describe('approval-utils', () => {
  describe('getIconForType', () => {
    it('全部类型映射到对应图标', () => {
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
    });

    it('未知类型兜底为 Globe（入队数据异常不崩溃）', () => {
      expect(getIconForType('unknown_type' as never)).toBe(Globe);
    });
  });

  describe('getLabelKeyForType', () => {
    it('未知类型兜底为 externalCall', () => {
      expect(getLabelKeyForType('unknown_type' as never)).toBe('externalCall');
    });
  });

  describe('getVariantForType', () => {
    it('未知类型兜底为通用 slate', () => {
      expect(getVariantForType('unknown_type' as never)).toEqual({
        className: 'bg-slate-100 text-slate-700',
      });
    });
  });

  describe('isDangerousType', () => {
    it('危险类型：delete_file / run_command / install_package / git_push', () => {
      expect(isDangerousType('delete_file')).toBe(true);
      expect(isDangerousType('run_command')).toBe(true);
      expect(isDangerousType('install_package')).toBe(true);
      expect(isDangerousType('git_push')).toBe(true);
    });

    it('非危险类型', () => {
      expect(isDangerousType('write_file')).toBe(false);
      expect(isDangerousType('edit_file')).toBe(false);
      expect(isDangerousType('git_commit')).toBe(false);
    });
  });

  describe('canRememberDecision', () => {
    it('仅 run_command / write_file / edit_file 支持记住决策', () => {
      expect(canRememberDecision('run_command')).toBe(true);
      expect(canRememberDecision('write_file')).toBe(true);
      expect(canRememberDecision('edit_file')).toBe(true);
      expect(canRememberDecision('delete_file')).toBe(false);
      expect(canRememberDecision('git_push')).toBe(false);
    });
  });

  describe('字段类型守卫', () => {
    it('getField：读取字符串字段，非字符串返回 undefined', () => {
      expect(getField({ command: 'ls' }, 'command')).toBe('ls');
      expect(getField({ command: 42 }, 'command')).toBeUndefined();
      expect(getField(null, 'command')).toBeUndefined();
      expect(getField('str', 'command')).toBeUndefined();
    });

    it('getBooleanField：读取布尔字段', () => {
      expect(getBooleanField({ amend: true }, 'amend')).toBe(true);
      expect(getBooleanField({ amend: 'yes' }, 'amend')).toBeUndefined();
    });

    it('getStringArrayField：读取字符串数组字段', () => {
      expect(getStringArrayField({ paths: ['a', 'b'] }, 'paths')).toEqual(['a', 'b']);
      expect(getStringArrayField({ paths: [1] }, 'paths')).toBeUndefined();
      expect(getStringArrayField({ paths: 'a' }, 'paths')).toBeUndefined();
    });
  });
});

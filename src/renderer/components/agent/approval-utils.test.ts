// src/renderer/components/$1/approval-utils.test.ts
// approval-utils 单元测试（2026-09-15 表驱动重构后）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. getApprovalMeta：10 类型全量映射（icon/className/dangerous/canRemember）
// 2. 协议外类型的编译期拒绝（satisfies Record 穷尽性，运行时不可达）
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
  getApprovalMeta,
  getBooleanField,
  getField,
  getNonEmptyField,
  getStringArrayField,
} from './approval-utils';

describe('approval-utils', () => {
  describe('getApprovalMeta', () => {
    it('10 类型图标映射', () => {
      expect(getApprovalMeta('run_command').icon).toBe(Terminal);
      expect(getApprovalMeta('write_file').icon).toBe(FilePlus);
      expect(getApprovalMeta('edit_file').icon).toBe(FileEdit);
      expect(getApprovalMeta('delete_file').icon).toBe(FileX);
      expect(getApprovalMeta('apply_patch').icon).toBe(FileDiff);
      expect(getApprovalMeta('install_package').icon).toBe(Package);
      expect(getApprovalMeta('external_call').icon).toBe(Globe);
      expect(getApprovalMeta('git_add').icon).toBe(GitBranch);
      expect(getApprovalMeta('git_commit').icon).toBe(GitCommitHorizontal);
      expect(getApprovalMeta('git_push').icon).toBe(CloudUpload);
    });

    it('5 类别徽章语义类', () => {
      expect(getApprovalMeta('run_command').className).toContain('warn');
      expect(getApprovalMeta('write_file').className).toContain('info-blue');
      expect(getApprovalMeta('edit_file').className).toContain('info-blue');
      expect(getApprovalMeta('apply_patch').className).toContain('info-blue');
      expect(getApprovalMeta('delete_file').className).toContain('error');
      expect(getApprovalMeta('install_package').className).toContain('magenta');
      expect(getApprovalMeta('external_call').className).toContain('accent-2');
      expect(getApprovalMeta('git_add').className).toContain('magenta');
      expect(getApprovalMeta('git_commit').className).toContain('magenta');
      expect(getApprovalMeta('git_push').className).toContain('magenta');
    });

    it('isDangerous：4 种危险 + 其余安全', () => {
      expect(getApprovalMeta('delete_file').dangerous).toBe(true);
      expect(getApprovalMeta('run_command').dangerous).toBe(true);
      expect(getApprovalMeta('install_package').dangerous).toBe(true);
      expect(getApprovalMeta('git_push').dangerous).toBe(true);
      expect(getApprovalMeta('write_file').dangerous).toBe(false);
      expect(getApprovalMeta('git_commit').dangerous).toBe(false);
      expect(getApprovalMeta('external_call').dangerous).toBe(false);
    });

    it('canRemember：仅 run_command/write_file/edit_file', () => {
      expect(getApprovalMeta('run_command').canRemember).toBe(true);
      expect(getApprovalMeta('write_file').canRemember).toBe(true);
      expect(getApprovalMeta('edit_file').canRemember).toBe(true);
      expect(getApprovalMeta('delete_file').canRemember).toBe(false);
      expect(getApprovalMeta('git_push').canRemember).toBe(false);
      expect(getApprovalMeta('external_call').canRemember).toBe(false);
    });

    it('协议外类型编译期拒绝（satisfies 穷尽性，运行时不可达）', () => {
      // @ts-expect-error 'unknown_type' 不在 ApprovalType union，元数据表已在编译期穷尽
      expect(getApprovalMeta('unknown_type')).toBeUndefined();
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

    it('getNonEmptyField：空串按「无值」处理（getField 会返回空串）', () => {
      expect(getNonEmptyField({ command: 'ls' }, 'command')).toBe('ls');
      // 关键差异：空命令视为无值（run_command 审批卡据此隐藏「编辑后重提」）
      expect(getNonEmptyField({ command: '' }, 'command')).toBeUndefined();
      expect(getField({ command: '' }, 'command')).toBe('');
      // 与 getField 同源的守卫语义
      expect(getNonEmptyField({ command: 42 }, 'command')).toBeUndefined();
      expect(getNonEmptyField(null, 'command')).toBeUndefined();
      expect(getNonEmptyField({}, 'command')).toBeUndefined();
    });

    it('getStringArrayField：读取字符串数组字段', () => {
      expect(getStringArrayField({ paths: ['a', 'b'] }, 'paths')).toEqual(['a', 'b']);
      expect(getStringArrayField({ paths: [1] }, 'paths')).toBeUndefined();
      expect(getStringArrayField({ paths: 'a' }, 'paths')).toBeUndefined();
    });
  });
});

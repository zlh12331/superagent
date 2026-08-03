// scripts/scaffold/lib/naming.test.ts
import { describe, expect, it } from 'vitest';

import {
  camelToPascal,
  isValidDomain,
  isValidMethod,
  isValidPermission,
  isValidToolName,
  snakeToKebab,
  snakeToPascal,
} from './naming';

describe('isValidToolName', () => {
  it('接受 snake_case', () => {
    expect(isValidToolName('read_file')).toBe(true);
    expect(isValidToolName('git_commit')).toBe(true);
    expect(isValidToolName('a1_b2')).toBe(true);
  });

  it('拒绝非法命名', () => {
    expect(isValidToolName('readFile')).toBe(false);
    expect(isValidToolName('Read_File')).toBe(false);
    expect(isValidToolName('_read')).toBe(false);
    expect(isValidToolName('1_read')).toBe(false);
    expect(isValidToolName('read__file')).toBe(false);
    expect(isValidToolName('')).toBe(false);
  });
});

describe('isValidDomain / isValidMethod', () => {
  it('接受 camelCase 小写开头', () => {
    expect(isValidDomain('app')).toBe(true);
    expect(isValidDomain('codebase')).toBe(true);
    expect(isValidMethod('getStatus')).toBe(true);
    expect(isValidMethod('listRecentDirs')).toBe(true);
  });

  it('拒绝非法命名', () => {
    expect(isValidDomain('App')).toBe(false);
    expect(isValidDomain('my_domain')).toBe(false);
    expect(isValidDomain('1domain')).toBe(false);
  });
});

describe('snakeToPascal', () => {
  it('单段与多段转换', () => {
    expect(snakeToPascal('read_file')).toBe('ReadFile');
    expect(snakeToPascal('git')).toBe('Git');
    expect(snakeToPascal('my_new_tool')).toBe('MyNewTool');
  });
});

describe('snakeToKebab', () => {
  it('下划线转连字符', () => {
    expect(snakeToKebab('read_file')).toBe('read-file');
    expect(snakeToKebab('git_commit')).toBe('git-commit');
  });
});

describe('camelToPascal', () => {
  it('首字母大写', () => {
    expect(camelToPascal('app')).toBe('App');
    expect(camelToPascal('codebase')).toBe('Codebase');
    expect(camelToPascal('myDomain')).toBe('MyDomain');
  });
});

describe('isValidPermission', () => {
  it('仅接受 auto / ask', () => {
    expect(isValidPermission('auto')).toBe(true);
    expect(isValidPermission('ask')).toBe(true);
    expect(isValidPermission('manual')).toBe(false);
  });
});

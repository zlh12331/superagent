import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearUserReadGrants,
  grantUserReadPaths,
  matchUserGrantedReadPath,
  userReadGrantCount,
} from './user-grants';

const MAX_GRANTS = 200;

describe('user-grants（用户手势授权路径登记表）', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    clearUserReadGrants();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'code-agent-grants-')));
    filePath = join(dir, 'attachment.txt');
    writeFileSync(filePath, 'hello', 'utf8');
  });

  afterEach(() => {
    clearUserReadGrants();
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('登记后精确命中，返回 realpath 规范化的绝对路径', () => {
    expect(grantUserReadPaths([filePath])).toBe(1);
    expect(matchUserGrantedReadPath(filePath)).toBe(filePath);
    expect(userReadGrantCount()).toBe(1);
  });

  it('未登记的绝对路径不命中（越权面不因本表扩大）', () => {
    grantUserReadPaths([filePath]);
    const other = join(dir, 'other.txt');
    writeFileSync(other, 'x', 'utf8');
    expect(matchUserGrantedReadPath(other)).toBeNull();
  });

  it('命中判定是精确相等而非前缀：授权文件的同目录兄弟 / 子路径均不命中', () => {
    grantUserReadPaths([filePath]);
    expect(matchUserGrantedReadPath(dir)).toBeNull();
    const child = join(dirname(filePath), 'sub', 'x.txt');
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(child, 'x', 'utf8');
    expect(matchUserGrantedReadPath(child)).toBeNull();
  });

  it('相对路径不命中；带 .. 的路径按规范化落点判定', () => {
    grantUserReadPaths([filePath]);
    expect(matchUserGrantedReadPath('attachment.txt')).toBeNull();
    expect(matchUserGrantedReadPath(join(filePath, '..', 'attachment.txt'))).toBe(filePath);
    expect(matchUserGrantedReadPath(join(dir, '..', 'attachment.txt'))).toBeNull();
    expect(matchUserGrantedReadPath('')).toBeNull();
    expect(matchUserGrantedReadPath('   ')).toBeNull();
  });

  it('相对 / 空白路径不会被登记', () => {
    expect(grantUserReadPaths(['attachment.txt', '', '  '])).toBe(0);
    expect(userReadGrantCount()).toBe(0);
  });

  it('重复登记不新增条目、不计入新增数', () => {
    expect(grantUserReadPaths([filePath])).toBe(1);
    expect(grantUserReadPaths([filePath])).toBe(0);
    expect(userReadGrantCount()).toBe(1);
  });

  it('超出容量上限按登记顺序淘汰最旧项', () => {
    const first = join(dir, 'first.txt');
    writeFileSync(first, 'x', 'utf8');
    grantUserReadPaths([first]);

    const many: string[] = [];
    for (let i = 0; i < MAX_GRANTS; i += 1) {
      const p = join(dir, `pad-${i}.txt`);
      writeFileSync(p, 'x', 'utf8');
      many.push(p);
    }
    grantUserReadPaths(many);

    expect(userReadGrantCount()).toBe(MAX_GRANTS);
    expect(matchUserGrantedReadPath(first)).toBeNull();
    expect(matchUserGrantedReadPath(many[MAX_GRANTS - 1] ?? '')).not.toBeNull();
  });

  it('清空后此前授权全部失效', () => {
    grantUserReadPaths([filePath]);
    clearUserReadGrants();
    expect(userReadGrantCount()).toBe(0);
    expect(matchUserGrantedReadPath(filePath)).toBeNull();
  });
});

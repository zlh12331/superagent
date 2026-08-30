// src/main/infra/file/user-grants.test.ts
// 「用户手势授权」登记表单测：
// 1. 登记后可精确命中（返回 canonical 绝对路径）
// 2. 未登记路径 / 相对路径 / 空串不命中
// 3. 命中判定是「精确相等」而非前缀（不放开子树）
// 4. 容量上限淘汰最旧登记项，重复登记刷新为最新
// 5. clearUserReadGrants 清空（跨用例隔离进程级状态）

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

/** 授权表容量上限（与被测模块保持一致：淘汰行为依赖此常量） */
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
    // 目录可能被前一个用例删过，existsSync 兜底避免噪音
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
    // 目录本身不命中（前缀放开等于放开整棵子树）
    expect(matchUserGrantedReadPath(dir)).toBeNull();
    // 以授权路径为前缀的「另一个文件」不命中
    const child = join(dirname(filePath), 'sub', 'x.txt');
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(child, 'x', 'utf8');
    expect(matchUserGrantedReadPath(child)).toBeNull();
  });

  it('相对路径不命中；带 .. 的路径按规范化落点判定', () => {
    grantUserReadPaths([filePath]);
    expect(matchUserGrantedReadPath('attachment.txt')).toBeNull();
    // `A/attachment.txt/../attachment.txt` 规范化后即授权文件本身 → 命中
    expect(matchUserGrantedReadPath(join(filePath, '..', 'attachment.txt'))).toBe(filePath);
    // 规范化后落到授权目录的兄弟位置（不在授权表内）→ 拒绝
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

    // 填满到上限后再加一个：first（最早）应被淘汰
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

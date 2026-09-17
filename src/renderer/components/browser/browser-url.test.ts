// src/renderer/components/browser/__tests__/browser-url.test.ts
// 预览地址规范化单测（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 该函数是「用户输入 → 主进程 loadURL」之间的唯一规范化点，
// 边界行为（空串、空白、协议大小写、非 http 协议）必须锁住。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { normalizeUrl } from './browser-url';

describe('normalizeUrl', () => {
  it('已带 http/https 协议：原样返回（协议大小写不敏感）', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://localhost:3000/a?b=1#c')).toBe('http://localhost:3000/a?b=1#c');
    expect(normalizeUrl('HTTPS://Example.com')).toBe('HTTPS://Example.com');
  });

  it('缺协议：补 https://', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000');
  });

  it('首尾空白：裁剪后再判定', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
    expect(normalizeUrl('\thttps://a.com\n')).toBe('https://a.com');
  });

  it('空串 / 全空白：返回空串（调用方据此跳过导航，不发 IPC）', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });

  it('非 http 协议：被前缀成 https:// 普通地址，不会被当作可执行协议', () => {
    // 前缀化后主进程只按 http/https 加载，这类输入退化为一个必然解析失败的域名
    expect(normalizeUrl('javascript:alert(1)')).toBe('https://javascript:alert(1)');
    expect(normalizeUrl('file:///etc/passwd')).toBe('https://file:///etc/passwd');
  });
});

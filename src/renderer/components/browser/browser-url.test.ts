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
    expect(normalizeUrl('javascript:alert(1)')).toBe('https://javascript:alert(1)');
    expect(normalizeUrl('file:///etc/passwd')).toBe('https://file:///etc/passwd');
  });
});

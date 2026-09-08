// src/main/infra/ai/tools/url-guard.test.ts
// web_fetch SSRF 守卫单测（2026-09-06 安全审计）
// 覆盖：受限网段判定 / 主机名黑名单 / 出站 URL 检查（字面量 IP 路径不走 DNS）

import {
  checkUrlAllowed,
  isBlockedAddress,
  isBlockedHostname,
  isBlockedIPv4,
  isBlockedIPv6,
} from './url-guard';

describe('isBlockedIPv4（环回/私网/链路本地/保留段）', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['172.32.0.1', false],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('%s → %s', (ip, expected) => {
    expect(isBlockedIPv4(ip)).toBe(expected);
  });

  it('非法输入 fail closed', () => {
    expect(isBlockedIPv4('999.1.1.1')).toBe(true);
    expect(isBlockedIPv4('abc')).toBe(true);
    expect(isBlockedIPv4('1.2.3')).toBe(true);
  });
});

describe('isBlockedIPv6（环回/ULA/链路本地/组播/映射地址）', () => {
  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.1', true],
    ['2001:4860:4860::8888', false],
  ])('%s → %s', (ip, expected) => {
    expect(isBlockedIPv6(ip)).toBe(expected);
  });
});

describe('isBlockedHostname（本地名 / 元数据服务名）', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['foo.localhost', true],
    ['printer.local', true],
    ['metadata.google.internal', true],
    ['example.com', false],
    ['api.deepseek.com', false],
  ])('%s → %s', (host, expected) => {
    expect(isBlockedHostname(host)).toBe(expected);
  });
});

describe('isBlockedAddress（v4/v6 分派）', () => {
  it('IPv4 与 IPv6 均按各自规则判定', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });
});

describe('checkUrlAllowed（出站 URL 判定）', () => {
  it('拒绝环回 / 私网 / 链路本地字面量地址', async () => {
    await expect(checkUrlAllowed(new URL('http://127.0.0.1:9000/'))).resolves.toMatchObject({
      allowed: false,
    });
    await expect(
      checkUrlAllowed(new URL('http://169.254.169.254/latest/meta-data/')),
    ).resolves.toMatchObject({ allowed: false });
    await expect(checkUrlAllowed(new URL('http://192.168.1.1/'))).resolves.toMatchObject({
      allowed: false,
    });
    await expect(checkUrlAllowed(new URL('http://[::1]:11434/'))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('拒绝本地主机名（无需 DNS）', async () => {
    const result = await checkUrlAllowed(new URL('http://localhost:9000/'));
    expect(result.allowed).toBe(false);
    expect(result.allowed === false ? result.reason : '').toContain('localhost');
  });

  it('拒绝非 http/https 协议', async () => {
    await expect(checkUrlAllowed(new URL('ftp://example.com/'))).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('放行公网字面量地址（不触发 DNS 解析）', async () => {
    await expect(checkUrlAllowed(new URL('http://8.8.8.8/'))).resolves.toEqual({ allowed: true });
  });

  it('拒绝原因可读（含主机名与地址）', async () => {
    const result = await checkUrlAllowed(new URL('http://10.0.0.5/'));
    expect(result.allowed).toBe(false);
    expect(result.allowed === false ? result.reason : '').toContain('10.0.0.5');
  });
});

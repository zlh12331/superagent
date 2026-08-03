// scripts/scaffold/lib/args.test.ts
import { describe, expect, it } from 'vitest';

import { optionalValue, parseArgs, rejectPositionals, requireValue } from './args';

describe('parseArgs', () => {
  it('解析 --key value 与 --key=value 形式', () => {
    const parsed = parseArgs(['--domain', 'app', '--method=getInfo', '--kind', 'request']);
    expect(parsed.values.get('domain')).toBe('app');
    expect(parsed.values.get('method')).toBe('getInfo');
    expect(parsed.values.get('kind')).toBe('request');
  });

  it('解析布尔 flag（在白名单内）', () => {
    const parsed = parseArgs(['--force'], ['force']);
    expect(parsed.flags.has('force')).toBe(true);
  });

  it('收集位置参数', () => {
    const parsed = parseArgs(['hello', '--domain', 'app']);
    expect(parsed.positionals).toEqual(['hello']);
  });

  it('未知 flag 视为带值参数（由 requireValue 校验）', () => {
    const parsed = parseArgs(['--name', 'x']);
    expect(parsed.values.get('name')).toBe('x');
  });

  it('缺少值时抛错', () => {
    expect(() => parseArgs(['--domain'])).toThrow('缺少值');
  });

  it('--key= 空值抛错', () => {
    expect(() => parseArgs(['--domain='])).toThrow('缺少值');
  });
});

describe('requireValue / optionalValue', () => {
  it('缺失必填参数抛错', () => {
    expect(() => requireValue(parseArgs([]), 'domain')).toThrow('缺少必填参数 --domain');
  });

  it('可选参数使用缺省值', () => {
    expect(optionalValue(parseArgs([]), 'kind', 'request')).toBe('request');
    expect(optionalValue(parseArgs(['--kind', 'event']), 'kind', 'request')).toBe('event');
  });
});

describe('rejectPositionals', () => {
  it('存在裸参数时抛错', () => {
    expect(() => rejectPositionals(parseArgs(['foo']))).toThrow('不支持的裸参数');
  });

  it('无裸参数时静默通过', () => {
    expect(() => rejectPositionals(parseArgs(['--domain', 'app']))).not.toThrow();
  });
});

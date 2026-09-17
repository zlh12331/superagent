// src/renderer/components/settings/sections/__tests__/mcp-section.test.tsx
// parseHeadersText 纯函数测试（请求头文本解析：Key: Value 每行一条）

import { describe, expect, it } from 'vitest';
import { parseHeadersText } from './mcp-section';

describe('parseHeadersText', () => {
  it('空文本：空记录（无 headers 提交）', () => {
    const result = parseHeadersText('');
    expect(result.headers).toEqual({});
    expect(result.invalidLine).toBeNull();
    expect(Object.keys(result.headers ?? {})).toHaveLength(0);
  });

  it('单行 Key: Value 解析', () => {
    const result = parseHeadersText('Authorization: Bearer token-1');
    expect(result.invalidLine).toBeNull();
    expect(result.headers).toEqual({
      // biome-ignore lint/style/useNamingConvention: HTTP 标准头名
      Authorization: 'Bearer token-1',
    });
  });

  it('多行 + 空行忽略 + 值中冒号保留', () => {
    const result = parseHeadersText(
      'Authorization: Bearer abc\n\nX-Trace: a:b:c\n  X-Extra :  v1  ',
    );
    expect(result.headers).toEqual({
      // biome-ignore lint/style/useNamingConvention: HTTP 标准头名
      Authorization: 'Bearer abc',
      'X-Trace': 'a:b:c',
      'X-Extra': 'v1',
    });
  });

  it('缺冒号的行：返回 null 与首个非法行号', () => {
    const result = parseHeadersText('Authorization: Bearer abc\ninvalid-header-line');
    expect(result.headers).toBeNull();
    expect(result.invalidLine).toBe(2);
  });

  it('空 key 或空 value 均非法', () => {
    expect(parseHeadersText(': novalue').headers).toBeNull();
    expect(parseHeadersText('X-Key:').invalidLine).toBe(1);
  });
});

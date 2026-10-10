import { describe, expect, it } from 'vitest';
import { clampToolOutput, clampToolPartOutput, toolOutputLimitFor } from './tool-executor';

function textOfBytes(bytes: number): string {
  return 'a'.repeat(bytes);
}

describe('toolOutputLimitFor（窗口 → 字节上限）', () => {
  it('未提供窗口：用绝对上限 200KB（与引入窗口感知前的行为一致）', () => {
    expect(toolOutputLimitFor(undefined)).toBe(200 * 1024);
    expect(toolOutputLimitFor(0)).toBe(200 * 1024);
    expect(toolOutputLimitFor(-1)).toBe(200 * 1024);
  });

  it('大窗口（1M，DeepSeek v4）：仍是绝对上限 200KB（比例上限更高，取小者）', () => {
    expect(toolOutputLimitFor(1_000_000)).toBe(200 * 1024);
  });

  it('128K 窗口（GPT-4o）：仍是绝对上限（128_000 × 0.75 = 96KB < 200KB → 取 96KB）', () => {
    expect(toolOutputLimitFor(128_000)).toBe(Math.floor(128_000 * 3 * 0.25));
  });

  it('32K 窗口（本地 ollama）：收紧到 24KB——修复"单次输出占满上下文"', () => {
    const limit = toolOutputLimitFor(32_000);
    expect(limit).toBe(Math.floor(32_000 * 3 * 0.25));
    expect(limit).toBeLessThan(200 * 1024);
  });

  it('极小窗口：不低于下限 8KB（极端场景仍保证有可用输出）', () => {
    expect(toolOutputLimitFor(1000)).toBe(8 * 1024);
  });

  it('分档连续性：窗口越大上限单调不减', () => {
    const sizes = [1_000, 8_000, 32_000, 64_000, 128_000, 200_000, 1_000_000];
    const limits = sizes.map((s) => toolOutputLimitFor(s));
    for (let i = 1; i < limits.length; i += 1) {
      expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1] as number);
    }
  });
});

describe('clampToolOutput（按字节截断 + 标注）', () => {
  it('未超限：原样返回（零分配路径）', () => {
    const text = textOfBytes(1000);
    expect(clampToolOutput(text)).toBe(text);
    expect(clampToolOutput(text, 1_000_000)).toBe(text);
  });

  it('超限：保留头部 + 标注实际大小与当前上限', () => {
    const text = textOfBytes(300 * 1024);
    const clamped = clampToolOutput(text);
    expect(clamped.length).toBeLessThan(text.length);
    expect(clamped).toContain('已截断');
    expect(clamped).toContain('共 300KB');
    expect(clamped).toContain('200KB');
  });

  it('窗口感知：同一份输出在 32K 窗口下被截得更短，标注含实际生效上限', () => {
    const text = textOfBytes(100 * 1024);
    const wide = clampToolOutput(text, 1_000_000);
    const narrow = clampToolOutput(text, 32_000);
    expect(wide).toBe(text);
    expect(narrow).toContain('已截断');
    expect(narrow).toContain('23KB');
  });

  it('多字节安全：UTF-8 字符不被劈开（无替换字符）', () => {
    const text = '中'.repeat(100_000);
    const clamped = clampToolOutput(text, 32_000);
    const head = clamped.split('\n\n…')[0] as string;
    expect(head).not.toContain('\uFFFD');
    expect(Buffer.byteLength(head, 'utf8')).toBeLessThanOrEqual(32_000 * 3 * 0.25 + 3);
  });

  it('边界：恰好等于上限不截断，超 1 字节才截断', () => {
    const atLimit = textOfBytes(200 * 1024);
    expect(clampToolOutput(atLimit)).toBe(atLimit);
    const overLimit = textOfBytes(200 * 1024 + 1);
    expect(clampToolOutput(overLimit)).toContain('已截断');
  });
});

describe('clampToolPartOutput（SDK 流式 part 通道）', () => {
  it('非工具 part：原样返回（不引入分配）', () => {
    const part = { type: 'text-delta', delta: 'x' };
    expect(clampToolPartOutput(part)).toBe(part);
  });

  it('非对象 part：原样返回（防御 null/原始值）', () => {
    expect(clampToolPartOutput(null)).toBeNull();
    expect(clampToolPartOutput('str')).toBe('str');
    expect(clampToolPartOutput(42)).toBe(42);
  });

  it('tool-output-available：字符串 output 被截断（含窗口感知）', () => {
    const part = {
      type: 'tool-output-available',
      toolCallId: 'c1',
      output: textOfBytes(300 * 1024),
    };
    const clamped = clampToolPartOutput(part, 32_000) as { output: string };
    expect(clamped.output).toContain('已截断');
    expect(clamped.output).toContain('23KB');
  });

  it('tool-output-error：同样被截断（错误通道也是输出通道）', () => {
    const part = {
      type: 'tool-output-error',
      toolCallId: 'c1',
      output: textOfBytes(300 * 1024),
    };
    const clamped = clampToolPartOutput(part) as { output: string };
    expect(clamped.output).toContain('已截断');
  });

  it('output 非字符串（对象/结构化）：原样返回（不误伤）', () => {
    const part = { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } };
    expect(clampToolPartOutput(part)).toBe(part);
  });
});

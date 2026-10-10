import { describe, expect, it } from 'vitest';
import {
  clampOutputTokens,
  MIN_OUTPUT_TOKENS,
  OUTPUT_TOKEN_CEILING,
  outputClampMargin,
} from './token-limits';

describe('outputClampMargin（安全余量）', () => {
  it('小窗口：余量保底 10K', () => {
    expect(outputClampMargin(32_000)).toBe(10_000);
  });

  it('大窗口：5% 且不低于 10K', () => {
    expect(outputClampMargin(1_000_000)).toBe(50_000);
    expect(outputClampMargin(200_000)).toBe(10_000);
  });
});

describe('clampOutputTokens（输出预算钳制）', () => {
  it('窗口余量充足：按 ceiling 钳制', () => {
    expect(
      clampOutputTokens({
        ceiling: 16_000,
        modelMaxOutputTokens: undefined,
        contextWindowSize: 1_000_000,
        promptTokens: 5_000,
      }),
    ).toBe(16_000);
  });

  it('prompt 接近窗口：按余量钳制（保证 prompt + max_tokens ≤ window）', () => {
    expect(
      clampOutputTokens({
        ceiling: 32_000,
        modelMaxOutputTokens: undefined,
        contextWindowSize: 200_000,
        promptTokens: 180_000,
      }),
    ).toBe(10_000);
  });

  it('窗口几乎占满：下限 MIN_OUTPUT_TOKENS 保底', () => {
    expect(
      clampOutputTokens({
        ceiling: 32_000,
        modelMaxOutputTokens: undefined,
        contextWindowSize: 100_000,
        promptTokens: 95_000,
      }),
    ).toBe(MIN_OUTPUT_TOKENS);
  });

  it('用户显式 ceiling 低于下限：尊重用户（下限只钳 room 不钳 ceiling）', () => {
    expect(
      clampOutputTokens({
        ceiling: 100,
        modelMaxOutputTokens: undefined,
        contextWindowSize: 1_000_000,
        promptTokens: 0,
      }),
    ).toBe(100);
  });

  it('模型能力上限（maxOutputTokens）：高于全局默认时用模型上限', () => {
    expect(
      clampOutputTokens({
        ceiling: undefined,
        modelMaxOutputTokens: 384_000,
        contextWindowSize: 1_000_000,
        promptTokens: 0,
      }),
    ).toBe(384_000);
  });

  it('模型能力上限低于用户 ceiling：以模型上限为准', () => {
    expect(
      clampOutputTokens({
        ceiling: 100_000,
        modelMaxOutputTokens: 16_384,
        contextWindowSize: 128_000,
        promptTokens: 0,
      }),
    ).toBe(16_384);
  });

  it('ceiling 缺省：应用 OUTPUT_TOKEN_CEILING 封顶', () => {
    expect(
      clampOutputTokens({
        ceiling: undefined,
        modelMaxOutputTokens: undefined,
        contextWindowSize: 1_000_000,
        promptTokens: 0,
      }),
    ).toBe(OUTPUT_TOKEN_CEILING);
  });

  it('无窗口信息：仅应用能力上限（不窗口钳制）', () => {
    expect(
      clampOutputTokens({
        ceiling: 8_000,
        modelMaxOutputTokens: undefined,
        contextWindowSize: undefined,
        promptTokens: 0,
      }),
    ).toBe(8_000);
    expect(
      clampOutputTokens({
        ceiling: undefined,
        modelMaxOutputTokens: undefined,
        contextWindowSize: undefined,
        promptTokens: 0,
      }),
    ).toBe(OUTPUT_TOKEN_CEILING);
  });
});

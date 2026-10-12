import { fc } from '@fast-check/vitest';

import {
  clampOutputTokens,
  MIN_OUTPUT_TOKENS,
  OUTPUT_TOKEN_CEILING,
  outputClampMargin,
} from './token-limits';

const windowArb = fc.integer({ min: 1_000, max: 4_000_000 });
const promptArb = fc.integer({ min: 0, max: 2_000_000 });
const ceilingArb = fc.option(fc.integer({ min: 100, max: 512_000 }), { nil: undefined });
const modelCapArb = fc.option(fc.integer({ min: 1_000, max: 512_000 }), { nil: undefined });

describe('clampOutputTokens 属性不变量（fast-check）', () => {
  it('恒返回非负整数 token 预算', () => {
    fc.assert(
      fc.property(windowArb, promptArb, ceilingArb, modelCapArb, (window, prompt, ceiling, cap) => {
        const result = clampOutputTokens({
          ceiling,
          modelMaxOutputTokens: cap,
          contextWindowSize: window,
          promptTokens: prompt,
        });
        expect(result).not.toBeUndefined();
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  it('永不超有效上限：result ≤ min(ceiling ?? cap, cap)', () => {
    fc.assert(
      fc.property(windowArb, promptArb, ceilingArb, modelCapArb, (window, prompt, ceiling, cap) => {
        const capabilityCap = cap ?? OUTPUT_TOKEN_CEILING;
        const effectiveCeiling = Math.min(ceiling ?? capabilityCap, capabilityCap);
        const result = clampOutputTokens({
          ceiling,
          modelMaxOutputTokens: cap,
          contextWindowSize: window,
          promptTokens: prompt,
        });
        expect(result).toBeLessThanOrEqual(effectiveCeiling);
      }),
      { numRuns: 500 },
    );
  });

  it('有窗口信息时满足窗口余量不变量（400 防护核心）', () => {
    fc.assert(
      fc.property(windowArb, promptArb, ceilingArb, modelCapArb, (window, prompt, ceiling, cap) => {
        const result = clampOutputTokens({
          ceiling,
          modelMaxOutputTokens: cap,
          contextWindowSize: window,
          promptTokens: prompt,
        });
        const capabilityCap = cap ?? OUTPUT_TOKEN_CEILING;
        const effectiveCeiling = Math.min(ceiling ?? capabilityCap, capabilityCap);

        const margin = outputClampMargin(window);
        const room = window - prompt - margin;
        if (result !== undefined && effectiveCeiling >= MIN_OUTPUT_TOKENS) {
          if (prompt + (result as number) + margin <= window) {
            return;
          }
          expect(room).toBeLessThan(MIN_OUTPUT_TOKENS);
          expect(result).toBe(MIN_OUTPUT_TOKENS);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('下限保护：尊重用户显式小 ceiling 或 ≥ MIN_OUTPUT_TOKENS', () => {
    fc.assert(
      fc.property(windowArb, promptArb, ceilingArb, modelCapArb, (window, prompt, ceiling, cap) => {
        const result = clampOutputTokens({
          ceiling,
          modelMaxOutputTokens: cap,
          contextWindowSize: window,
          promptTokens: prompt,
        });
        const capabilityCap = cap ?? OUTPUT_TOKEN_CEILING;
        const effectiveCeiling = Math.min(ceiling ?? capabilityCap, capabilityCap);
        if (effectiveCeiling < MIN_OUTPUT_TOKENS) {
          expect(result).toBe(effectiveCeiling);
        } else {
          expect(result).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('无窗口信息：仅应用能力上限，不做窗口钳制', () => {
    fc.assert(
      fc.property(promptArb, ceilingArb, modelCapArb, (prompt, ceiling, cap) => {
        const capabilityCap = cap ?? OUTPUT_TOKEN_CEILING;
        const effectiveCeiling = Math.min(ceiling ?? capabilityCap, capabilityCap);
        const result = clampOutputTokens({
          ceiling,
          modelMaxOutputTokens: cap,
          contextWindowSize: undefined,
          promptTokens: prompt,
        });
        expect(result).toBe(effectiveCeiling);
      }),
      { numRuns: 500 },
    );
  });
});

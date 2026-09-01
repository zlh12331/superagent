// src/main/infra/ai/models/token-limits.property.test.ts
// fast-check 属性测试试点 1/2：clampOutputTokens 数学不变量
// ──────────────────────────────────────────────────────────────
// 试点背景（2026-08 讨论收敛）：仅对强纯函数引入属性测试，其余类型因边际
// 收益递减不追加。clampOutputTokens 是纯数值函数，天然适合属性验证——
// 手写用例只能覆盖 4-5 个边界点，属性测试暴力扫描整个输入域的不变量。
//
// 覆盖的不变量（不随实现细节变化的语义约束）：
// 1. 返回值恒为整数（token 预算非负数）
// 2. clamp 永不超过有效上限（ceiling/能力上限取 min）
// 3. 有窗口信息时：output + prompt + margin ≤ window（400 防护核心不变量）
//    —— 豁免：窗口余量不足时保底 MIN_OUTPUT_TOKENS（设计内行为，另列不变量 4）
// 4. 输出预算下限保护：结果要么尊重用户显式小 ceiling，要么 ≥ MIN_OUTPUT_TOKENS
// ──────────────────────────────────────────────────────────────

import { fc } from '@fast-check/vitest';

import {
  clampOutputTokens,
  MIN_OUTPUT_TOKENS,
  OUTPUT_TOKEN_CEILING,
  outputClampMargin,
} from './token-limits';

// 数值域：窗口 1K~4M，prompt 0~2M（覆盖正常窗口与窗口快满两态）
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
        // 核心不变量：prompt + output + margin ≤ window
        // 例外：用户显式 ceiling 小于 MIN（尊重用户），或窗口余量被 MIN 保底拉低
        const room = window - prompt - margin;
        if (result !== undefined && effectiveCeiling >= MIN_OUTPUT_TOKENS) {
          if (prompt + (result as number) + margin <= window) {
            return; // 已满足不变量
          }
          // 未满足时仅允许一种形态：room < MIN 且 result 被保底拉低到 MIN
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
        // 用户显式 ceiling < MIN：原样返回（尊重用户）
        if (effectiveCeiling < MIN_OUTPUT_TOKENS) {
          expect(result).toBe(effectiveCeiling);
        } else {
          // 否则结果必须 ≥ MIN_OUTPUT_TOKENS
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

// scripts/lib/compiler-output.test.ts
// React Compiler 产物调用点统计核反例 fixture 测试：三态（真失效/假阳性/正常）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { countCompilerCallSites } from './compiler-output';

/** 应用 chunk 的调用点形态（rolldown interop 实测） */
const APP_CHUNK = 'var import_compiler_runtime = require_compiler_runtime();';
/** vendor 定义形态（react 包自身，必须剔除） */
const VENDOR_CHUNK = 'function require_compiler_runtime(){ return requireReact(); }';

describe('countCompilerCallSites', () => {
  it('反例（编译器真失效）：0 调用点 → chunksWithCalls 0', () => {
    const s = countCompilerCallSites(['console.log("x")', VENDOR_CHUNK]);
    expect(s.chunksWithCalls).toBe(0);
    expect(s.totalCalls).toBe(0);
  });

  it('假阳性剔除：vendor 定义形态不计入调用点', () => {
    // 同一 chunk 同时含定义与 1 处调用 → 净调用 1（不是 2）
    const mixed = `${VENDOR_CHUNK} ${APP_CHUNK}`;
    const s = countCompilerCallSites([mixed]);
    expect(s.totalCalls).toBe(1);
    expect(s.chunksWithCalls).toBe(1);
  });

  it('正例：N 个应用 chunk → 全部计入', () => {
    const s = countCompilerCallSites([APP_CHUNK, APP_CHUNK, APP_CHUNK]);
    expect(s.chunksWithCalls).toBe(3);
    expect(s.totalCalls).toBe(3);
    expect(s.scannedChunks).toBe(3);
  });

  it('边界：含 INTEROP_NAME 字符串但无调用形态 → 不计入', () => {
    const s = countCompilerCallSites(['import "react-compiler-runtime"']);
    expect(s.chunksWithCalls).toBe(0);
  });
});

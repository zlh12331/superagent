// src/main/vitest.perf.config.ts
// main 进程性能基准独立配置
// 为什么需要独立配置：vitest.config.ts 的 exclude 会剔除 **/*.perf.test.ts，
// 而 Vitest 4 CLI 的 --exclude 只能与配置合并、无法移除已有排除项——
// 因此 `vitest run --root src/main perf` 匹配不到任何文件（曾长期静默失效）。
import { defineConfig } from 'vitest/config';

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.perf.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'out/**'],
    // 基准测试依赖时序，禁用文件级并发避免互相争用导致抖动
    fileParallelism: false,
    // 基准含 10000 条消息写入 + 多轮采样，默认 5s 超时不够
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 基准阈值本身即卡关（expect(median).toBeLessThan(...)），不叠覆盖率门槛
    coverage: { enabled: false },
  },
});

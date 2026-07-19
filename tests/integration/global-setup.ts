// tests/integration/global-setup.ts
// 集成测试全局 setup（vitest 4 globalSetup）
// 设计文档 §8.3 集成测试策略 / Phase 9 plan Task 3
//
// 职责：
// 1. 在所有测试文件运行前启动 PG 容器（仅执行一次，在主进程）
// 2. 容器启动后设置 process.env.DATABASE_URL，worker 进程通过此变量连接到容器
// 3. 返回 async function 在所有测试完成后执行关闭容器
// 4. Docker 不可用时捕获异常，输出警告但不抛错（避免阻塞测试运行）
//    测试文件通过 isContainerReady() 判断后 describe.skip 跳过
//
// 注意：
// - vitest 4 globalSetup 在主进程执行，worker 进程通过环境变量复用容器
// - 返回函数会在所有测试完成后执行，用于清理容器资源
// - Docker 不可用时不抛错，让 setup.ts + 测试文件用 isContainerReady() 优雅降级

import { startTestContainer, stopTestContainer } from './helpers/pg-container';

/**
 * vitest globalSetup 函数
 *
 * 在所有测试前启动容器，返回关闭函数在所有测试后执行
 *
 * Docker 不可用时仅输出警告，不抛错：
 * - 测试文件通过 isContainerReady() 判断后 describe.skip 跳过
 * - 这样 CI 环境无 Docker 时仍能跑 unit 测试，集成测试优雅跳过
 */
export async function setup(): Promise<() => Promise<void>> {
  try {
    await startTestContainer();
  } catch (error) {
    console.warn(
      `[integration] globalSetup 启动容器失败：${error instanceof Error ? error.message : String(error)}`,
    );
    console.warn('[integration] Docker 可能未运行，集成测试将被跳过（unit 测试不受影响）');
    // 不抛错，让 setup.ts + 测试文件用 isContainerReady() 判断
  }

  // 返回关闭函数：在所有测试完成后执行
  return async () => {
    await stopTestContainer();
  };
}

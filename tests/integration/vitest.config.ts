// tests/integration/vitest.config.ts
// 集成测试专用 Vitest 配置
// 设计文档 §8.3 集成测试策略 / Phase 9 plan Task 3
//
// 设计要点：
// 1. 独立于 src/main/vitest.config.ts（unit 配置），互不干扰
// 2. 使用真实 PG 容器（Testcontainers + pgvector/pgvector:pg17 镜像）
// 3. 单容器共享：globalSetup 启动 / globalSetup 返回函数关闭，所有 worker 进程复用
// 4. Docker 不可用时 globalSetup 不抛错，测试文件用 isContainerReady() 判断后 describe.skip
// 5. testTimeout 放宽到 60s（容器启动 + migration 耗时较长）
// 6. 通过 resolve.alias 全局替换 electron 模块（集成测试不依赖真实 Electron 运行时）
//
// 注意：
// - 这里偏离了 plan 文档"改造 src/main/vitest.config.ts 为 projects"的方案
//   原因：plan 方案需要修改现有 `test:main` 命令行为，风险较大；
//   采用"独立配置 + 不同 root"方案可保留 unit 测试 0 改动，集成测试也独立管理。
// - 集成测试运行命令：`pnpm test:integration`（vitest run --root tests/integration）
// - vitest 在 --root 目录下查找 vitest.config.{ts,js} 自动加载
// - vitest 4 globalSetup 在主进程执行，worker 进程通过 process.env.DATABASE_URL 复用容器
// - electron 模块替换：globalSetup 一启动就会加载 src/main/infra/prisma/client.ts，
//   client.ts 又加载 logger.ts，logger.ts import 'electron' 会失败（Node.js 无 Electron 上下文）
//   通过 vite resolve.alias 在所有 worker 与 globalSetup 启动前替换为 stub 文件，避免加载失败

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// stub 模块的绝对路径（tests/integration/helpers/）
const ELECTRON_STUB_PATH = fileURLToPath(new URL('./helpers/electron-stub.ts', import.meta.url));
const ELECTRON_LOG_STUB_PATH = fileURLToPath(
  new URL('./helpers/electron-log-stub.ts', import.meta.url),
);

// biome-ignore lint/style/noDefaultExport: vitest config 框架要求必须使用 export default
export default defineConfig({
  // 通过 alias 全局替换 electron 与 electron-log 模块
  // 集成测试环境无 Electron 运行时，import 'electron' 会触发 native 模块加载失败
  // electron-log 内部也会探测 electron 环境，stub 为内存实现避免依赖真实 Electron
  // 替换为 stub 文件，提供 logger.ts 与 config 所需的最小 app 对象与 log 接口
  resolve: {
    alias: {
      electron: ELECTRON_STUB_PATH,
      'electron-log': ELECTRON_LOG_STUB_PATH,
    },
  },
  test: {
    // 启用 globals：允许 describe/it/expect 无需显式 import（与 unit 配置一致）
    globals: true,
    // 测试文件位置：tests/integration 下所有 *.integration.test.ts
    include: ['**/*.integration.test.ts'],
    // globalSetup：在所有测试前启动容器，所有测试后关闭容器
    // 仅在主进程执行一次，启动后通过 process.env.DATABASE_URL 传递连接信息给 worker
    globalSetup: ['./global-setup.ts'],
    // setupFiles：每个测试文件运行前执行（在 worker 进程）
    // 创建 worker 进程的 PrismaClient 单例（连接到 globalSetup 设置的 DATABASE_URL）
    setupFiles: ['./setup.ts'],
    // 单测超时放宽到 60s（容器启动 + migration 耗时较长，正常应在 30s 内完成）
    testTimeout: 60_000,
    // hook 超时放宽到 60s（beforeAll 启动容器需要时间）
    hookTimeout: 60_000,
    // 不并发执行（避免多个 worker 进程并发，资源浪费）
    // 多文件按顺序执行，单文件内多个 it 仍可并发
    fileParallelism: false,
    // 覆盖率收集（设计文档 §8.6 覆盖率 CI 卡关）
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // 阈值卡关：与 unit 配置一致
      // 设计文档 §8.6：statements 80% / branches 75% / functions 80% / lines 80%
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      // 排除测试文件本身、helpers、配置文件、mock stub
      exclude: [
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.d.ts',
        'helpers/**',
        'setup.ts',
        'global-setup.ts',
      ],
    },
  },
});

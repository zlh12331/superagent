// tests/integration/setup.ts
// 集成测试 setup 文件（vitest 4 setupFiles，在每个测试文件运行前执行）
// 设计文档 §8.3 集成测试策略 / Phase 9 plan Task 3
//
// 职责：
// 1. 全局 mock electron 模块（logger 与 config 依赖 electron app 对象）
// 2. 全局 mock ai-usage 模块（避免写入 ai_usage_logs 表干扰断言）
// 3. 在每个测试文件运行前创建 worker 进程的 PrismaClient 单例
// 4. 重置主进程 PrismaClient 单例缓存（让 service 层调用 getPrismaClient() 时复用测试 client）
// 5. Docker 不可用时不创建 client，由测试文件用 isContainerReady() 判断后 describe.skip
//
// 注意：
// - setup.ts 是 setupFiles，每个测试文件运行前都会执行（在 worker 进程）
// - 与 global-setup.ts 区别：global-setup 在主进程执行一次，setup 在每个 worker 执行
// - getTestPrismaClient 是幂等的（worker 进程首次调用创建，后续调用返回缓存）
// - vi.mock 提升到模块加载前执行，必须在顶层声明（不能在 if 块内）
// - 即使容器未启动，vi.mock 仍需声明（避免测试文件加载时 import service 触发 electron 加载）

import { vi } from 'vitest';
import { getTestPrismaClient, isContainerReady } from './helpers/pg-container';

// 1. 全局 mock electron 模块
// 集成测试通过 service 层导入链会加载到 electron（logger 依赖 app.isPackaged）
// 在 Node.js 测试环境直接 require electron 会失败，必须 mock
// 参考 src/main/services/embedding.service.test.ts 的 mock 模式
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '',
  },
}));

// 2. 全局 mock ai-usage 模块
// embedding.service 内部会调用 logAiUsage 写入 ai_usage_logs 表
// 集成测试关注 RAG/Chat 业务流程，AI 用量日志会干扰断言（表中数据不稳定）
// mock 后 logAiUsage 变为空操作，ai_usage_logs 表始终为空
vi.mock('../../src/main/services/ai-usage', () => ({
  logAiUsage: vi.fn().mockResolvedValue(undefined),
}));

// 3. 模块加载时执行（每个 worker 进程首次加载本模块时）
// - 如果容器就绪：创建 PrismaClient 单例
// - 如果容器未就绪：跳过，由测试文件用 isContainerReady() 判断后 describe.skip
if (isContainerReady()) {
  // 调用 getTestPrismaClient 创建 worker 进程的 PrismaClient 单例
  // 同时通过 resetPrismaClient 重置主进程单例缓存（service 层会复用此 client）
  // 注意：不 await，让 client 在测试运行时按需连接（PrismaClient 懒连接）
  getTestPrismaClient();
} else {
  console.warn('[integration] setup.ts 检测到容器未就绪，集成测试将被跳过');
}

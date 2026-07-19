// tests/integration/helpers/electron-stub.ts
// Electron 模块 stub（仅集成测试用）
//
// 职责：
// 提供 logger.ts 与 config 模块所需的 electron app 对象最小实现
// 集成测试运行在纯 Node.js 环境，没有 Electron 运行时
// 通过 vitest.config.ts 的 resolve.alias 将 'electron' 指向此 stub
//
// 注意：
// - 不导出真实的 Electron 模块（避免触发 native 加载）
// - app.isPackaged = false 让 logger 走 debug 级别
// - app.getPath 返回空字符串，logger 不会真正写入文件
// - 不需要 mock IPC / BrowserWindow 等（集成测试不涉及渲染层）

// biome-ignore lint/style/noDefaultExport: vitest alias 要求 CommonJS 风格的 default export
export default {
  app: {
    isPackaged: false,
    getPath: () => '',
  },
};

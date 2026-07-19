// tests/integration/helpers/electron-log-stub.ts
// electron-log 模块 stub（仅集成测试用）
//
// 职责：
// 提供 logger.ts 所需的 electron-log default export 最小实现
// 集成测试不需要真实日志文件，所有日志通过 console 输出便于调试
//
// 注意：
// - logger.ts 调用 log.transports.file.level / log.transports.console.level 等配置项
// - logger.ts 调用 log.info / log.warn / log.error / log.debug 方法
// - 通过 vitest.config.ts 的 resolve.alias 将 'electron-log' 指向此 stub

// biome-ignore lint/style/noDefaultExport: vitest alias 要求 CommonJS 风格的 default export
export default {
  transports: {
    file: {
      level: 'info',
      fileName: 'main.log',
      maxSize: 10 * 1024 * 1024,
      format: '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}',
    },
    console: {
      level: 'debug',
      format: '{level} {text}',
    },
  },
  info: (...args: unknown[]) => console.info('[info]', ...args),
  warn: (...args: unknown[]) => console.warn('[warn]', ...args),
  error: (...args: unknown[]) => console.error('[error]', ...args),
  debug: (...args: unknown[]) => console.debug('[debug]', ...args),
  initialize: () => {
    // no-op：集成测试不需要初始化 electron-log
  },
};

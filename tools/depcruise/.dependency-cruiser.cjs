/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: '禁止循环依赖：import 环会导致初始化顺序不确定、测试困难',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    {
      name: 'infra-not-above',
      comment: 'infra（基础设施）只能被上层依赖，禁止反向依赖 ipc/service-container/index',
      severity: 'error',
      from: { path: '^src/main/infra' },
      to: { path: '^(src/main/ipc|src/main/service-container\\.ts|src/main/index\\.ts)' },
    },

    {
      name: 'utils-pure',
      comment:
        'utils（通用工具）禁止依赖任何业务模块（infra/ipc/业务编排/security/telemetry/config）',
      severity: 'error',
      from: { path: '^src/main/utils' },
      to: { path: '^src/main/(infra|ipc|service-container\\.ts|security|telemetry|config)' },
    },

    {
      name: 'shared-pure',
      comment: 'packages/shared（契约层）被所有进程依赖，自身禁止依赖应用代码',
      severity: 'error',
      from: { path: '^packages/shared' },
      to: { path: '^src/' },
    },

    {
      name: 'renderer-not-main',
      comment: '渲染层/桥接层禁止依赖主进程代码（只能走 IPC 契约）',
      severity: 'error',
      from: { path: '^(src/renderer|src/preload)' },
      to: { path: '^src/main' },
    },

    {
      name: 'main-not-renderer',
      comment: '主进程禁止依赖渲染层代码',
      severity: 'error',
      from: { path: '^src/main' },
      to: { path: '^src/renderer' },
    },

    {
      name: 'preload-shared-only',
      comment: 'preload（桥接层）只允许依赖契约层，禁止依赖 main/renderer 代码',
      severity: 'error',
      from: { path: '^src/preload' },
      to: { path: '^(src/main|src/renderer)' },
    },

    {
      name: 'preload-no-zod-entry',
      comment:
        'preload 禁止引入含 zod 运行时的 shared 入口（main/裸入口/definitions/derive 等）；沙箱 CJS 下 zod 会静默失败',
      severity: 'error',
      from: { path: '^src/preload' },
      to: {
        path: '^packages/shared/src/(main|index|ipc/(definitions|derive|api|payloads|response))',
      },
    },

    {
      name: 'integration-not-renderer',
      comment:
        '集成测试（tests/integration）只能依赖主进程/shared，禁止依赖渲染层与 preload（跨进程边界）',
      severity: 'error',
      from: { path: '^tests/integration' },
      to: { path: '^(src/renderer|src/preload)' },
    },
  ],
  options: {
    doNotFollow: {
      path: '(^node_modules|node_modules|^src/main/(node_modules|out|coverage)|^src/renderer/(node_modules|out)|^out/)',
    },
    tsConfig: {
      fileName: 'tsconfig.depcruise.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'default'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: '^(packages/shared/src/[^/]+|src/main/(infra|ipc|utils|config)/[^/]+)',
      },
    },
  },
};

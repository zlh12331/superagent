// .dependency-cruiser.cjs
// 架构极致·阶段 1：依赖方向 + 循环消除 机器闸
// ──────────────────────────────────────────────────────────────
// 分层规则（对齐 docs/top-project-standards.md ⑨ 架构极致依赖矩阵）：
//   index（入口）→ service-container（业务编排）→ infra（基础设施）
//   ipc（适配层）→ 注入式获取服务，不直接依赖业务编排
//   utils/config → 纯工具，禁止依赖业务层
//   shared → 契约层，禁止依赖任何应用代码
//   进程隔离：main / preload / renderer 互不越界
// 循环依赖：全局检测（发现环即失败）
// ──────────────────────────────────────────────────────────────

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── 循环依赖（全局）──────────────────────────────────────
    {
      name: 'no-circular',
      comment: '禁止循环依赖：import 环会导致初始化顺序不确定、测试困难',
      severity: 'error',
      from: {},
      to: { circular: true },
    },

    // ── 分层：infra 禁止依赖上层（ipc / 业务编排 / 入口）─────
    {
      name: 'infra-not-above',
      comment: 'infra（基础设施）只能被上层依赖，禁止反向依赖 ipc/service-container/index',
      severity: 'error',
      from: { path: '^src/main/infra' },
      to: { path: '^(src/main/ipc|src/main/service-container\\.ts|src/main/index\\.ts)' },
    },

    // ── 分层：utils 必须纯净 ─────────────────────────────────
    {
      name: 'utils-pure',
      comment:
        'utils（通用工具）禁止依赖任何业务模块（infra/ipc/业务编排/security/telemetry/config）',
      severity: 'error',
      from: { path: '^src/main/utils' },
      to: { path: '^src/main/(infra|ipc|service-container\\.ts|security|telemetry|config)' },
    },

    // ── 契约层：shared 禁止依赖应用代码 ──────────────────────
    {
      name: 'shared-pure',
      comment: 'packages/shared（契约层）被所有进程依赖，自身禁止依赖应用代码',
      severity: 'error',
      from: { path: '^packages/shared' },
      to: { path: '^src/' },
    },

    // ── 进程隔离：renderer / preload 禁止依赖 main ───────────
    {
      name: 'renderer-not-main',
      comment: '渲染层/桥接层禁止依赖主进程代码（只能走 IPC 契约）',
      severity: 'error',
      from: { path: '^(src/renderer|src/preload)' },
      to: { path: '^src/main' },
    },

    // ── 进程隔离：main 禁止依赖 renderer ─────────────────────
    {
      name: 'main-not-renderer',
      comment: '主进程禁止依赖渲染层代码',
      severity: 'error',
      from: { path: '^src/main' },
      to: { path: '^src/renderer' },
    },

    // ── 进程隔离：preload 只允许依赖 shared ──────────────────
    {
      name: 'preload-shared-only',
      comment: 'preload（桥接层）只允许依赖契约层，禁止依赖 main/renderer 代码',
      severity: 'error',
      from: { path: '^src/preload' },
      to: { path: '^(src/main|src/renderer)' },
    },

    // ── preload 零 zod 边界（P2 修复）─────────────────────────
    // sandbox: true 下 preload 是 CJS，引入纯 ESM 的 zod 会静默失败导致
    // window.api 为 undefined——此前这条边界只存在于注释约定，无任何机器闸。
    // 白名单外 shared 子路径（main / 裸入口 / definitions 等含 zod 运行时）
    // 一律禁止；允许的只有 /ipc/meta、/ipc/channels、/preload、/renderer(类型)。
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

    // ── 测试边界：集成测试禁止依赖渲染层 / preload（跨进程边界）──
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
    // 不进入 node_modules / 构建产物 / 类型声明
    doNotFollow: {
      path: '(^node_modules|node_modules|^src/main/(node_modules|out|coverage)|^src/renderer/(node_modules|out)|^out/)',
    },
    // 解析 tsconfig 路径别名（@code-agent/* 等）
    tsConfig: {
      fileName: 'tsconfig.json',
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

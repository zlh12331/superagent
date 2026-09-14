// src/main/infra/memory-hub/engine-env.ts
// 记忆引擎子进程环境构造（纯函数，独立于进程启动代码便于单测）
// ──────────────────────────────────────────────────────────────
// 为什么单独成文件：engine-process.ts 依赖 electron 的 utilityProcess，单测需 mock
// 整个 electron；环境构造是纯字符串处理，独立后可零依赖单测，锁定下面这条回归。
//
// ⚠️ tsx 注入必须走 NODE_OPTIONS，**不能放进 utilityProcess 的 execArgv**：
//   2026-09-14 探针对照实测——execArgv 传 ['--import','tsx'] 与传空数组的失败信息
//   完全相同，均为 `ERR_MODULE_NOT_FOUND: .../src/core/tdai-core.js`，说明 Electron
//   utilityProcess 不透传该参数；改用 NODE_OPTIONS 后子进程正常跑到 /health 就绪。
//
//   后果链（当年未被察觉的原因）：tsx 未加载 → Node 以原生 ESM 语义解析上游 TS 源码
//   里的 `./x.js`（TS 惯例，实际文件是 .ts）→ 解析失败 → 子进程约 150ms 以退出码 1
//   死掉 → 引擎静默降级为空实现。stderr 为空（失败发生在 loader 缺失阶段），
//   只能凭"启动即退出"现象定位；E2E 只测面板 UI，故未拦住。
//
//   旧实现（utilityProcess 迁移前的 spawn）用位置参数
//   `electron --import tsx launcher.mjs` 传参，故未暴露此问题——迁移时改 execArgv
//   引入了回归。本模块的常量值有单测锁定。
// ──────────────────────────────────────────────────────────────

/** tsx 加载器经 NODE_OPTIONS 传递的取值 */
export const TSX_NODE_OPTIONS_VALUE = '--import tsx';

/**
 * 构造引擎子进程环境
 *
 * useTsx 时覆盖 NODE_OPTIONS 以加载 tsx loader；否则原样返回（调用方已显式置空，
 * 避免继承开发期的全局 NODE_OPTIONS 干扰引擎进程）。
 *
 * @param base 调用方构造的基础环境（含 MEMORY_HUB_ENTRY / TDAI_* 等固定键）
 * @param useTsx 是否以 tsx 直跑上游 TS 源码（打包产物为 JS 时为 false）
 */
export function buildEngineEnv(base: NodeJS.ProcessEnv, useTsx: boolean): NodeJS.ProcessEnv {
  if (!useTsx) {
    return { ...base };
  }
  // biome-ignore lint/style/useNamingConvention: 标准环境变量名
  return { ...base, NODE_OPTIONS: TSX_NODE_OPTIONS_VALUE };
}

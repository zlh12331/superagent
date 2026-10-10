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

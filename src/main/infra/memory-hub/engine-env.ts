// engine-env.ts：引擎子进程环境构造——tsx 直跑（dev 无构建产物时）注入 NODE_OPTIONS
export const TSX_NODE_OPTIONS_VALUE = '--import tsx';

/** base 上按需叠加 tsx 钩子（useTsx=false 时原样返回，不污染环境） */
export function buildEngineEnv(base: NodeJS.ProcessEnv, useTsx: boolean): NodeJS.ProcessEnv {
  if (!useTsx) {
    return { ...base };
  }
  // biome-ignore lint/style/useNamingConvention: 标准环境变量名
  return { ...base, NODE_OPTIONS: TSX_NODE_OPTIONS_VALUE };
}

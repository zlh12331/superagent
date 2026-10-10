export const TSX_NODE_OPTIONS_VALUE = '--import tsx';

export function buildEngineEnv(base: NodeJS.ProcessEnv, useTsx: boolean): NodeJS.ProcessEnv {
  if (!useTsx) {
    return { ...base };
  }
  // biome-ignore lint/style/useNamingConvention: 标准环境变量名
  return { ...base, NODE_OPTIONS: TSX_NODE_OPTIONS_VALUE };
}

// preload.ts：preload 专用出口（@code-agent/shared/preload）—— 零依赖的 IPC 元数据与响应/错误类型
//
// 为什么独立出口：preload 运行在 sandbox: true 下并以 CJS 构建，引入纯 ESM 包（如 zod）会静默失败
// （window.api 变 undefined）；故本出口只再导出无第三方依赖的模块——constants/errors、ipc/meta、ipc/response。
// 边界：新增导出前先确认其依赖链不含第三方运行时依赖。

export type { IpcError } from './constants/errors';
export type { IpcMeta, MetaEntry } from './ipc/meta';
export { event, IPC_META, request } from './ipc/meta';
export type { IpcResponse } from './ipc/response';

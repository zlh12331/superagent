// index.ts：@code-agent/shared 的包主入口（package.json exports["."]）——常量 / IPC 契约 / zod schema 的再导出，另含手写版本常量
// 边界：本入口只再导出其中一部分，并非全量——按进程拆分的出口另有 ./main、./renderer、./preload；
// 本入口再导出 schemas 各模块，随之传递依赖 zod，preload（CJS + 沙箱）不得从主入口导入，须走零 zod 的子路径（./preload、./ipc/meta 等）
// 排列：整文件按模块路径字母序（biome check 会重排，新增行按序插入即可）

export * from './constants/defaults';
export * from './constants/errors';
export * from './constants/protocol';

// IPC 契约：定义表体系——meta（纯字符串，preload 侧可安全引入）→ definitions（meta + zod）→ derive（类型推导），
// 另有 api / channels / payloads / response 提供 preload API、通道常量与请求响应类型
export * from './ipc/api';
export * from './ipc/channels';
export * from './ipc/definitions';
export * from './ipc/derive';
export * from './ipc/meta';
export * from './ipc/payloads';
export * from './ipc/response';

// zod schema：入参/出参校验的单一真源（主进程 IPC 定义表引用，见 src/main/utils/wrap.ts），避免类型与校验双向漂移
export * from './schemas/agent';
export * from './schemas/agent-ask';
export * from './schemas/agent-events';
export * from './schemas/app';
export * from './schemas/chat';
export * from './schemas/codebase';
export * from './schemas/devtools';
export * from './schemas/dialog';
export * from './schemas/file';
export * from './schemas/git';
export * from './schemas/goal';
export * from './schemas/im';
export * from './schemas/invalidation';
export * from './schemas/mcp';
export * from './schemas/memory';
export * from './schemas/models';
export * from './schemas/remote';
export * from './schemas/search';
export * from './schemas/session';
export * from './schemas/settings';
export * from './schemas/skill';
export * from './schemas/system';
export * from './schemas/task';
export * from './schemas/terminal';
export * from './schemas/thinking';
export * from './schemas/tool';
export * from './schemas/update';
export * from './schemas/whitelist';

/**
 * 本包手写的版本号常量，与 packages/shared/package.json 的 version 不同源（勿当作应用版本使用）。
 * 包内仅冒烟用例 packages/shared/src/__tests__/smoke.test.ts 锁定其字面量，改动需同步该断言。
 */
export const SHARED_VERSION = '0.1.0' as const;

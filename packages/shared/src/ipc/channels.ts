// channels.ts：IPC 通道常量表——IPC_CHANNELS 由 meta.ts 的 IPC_META 经 deriveChannels 派生，
// 本文件不手写常量：新增/改通道只改 meta.ts（definitions.ts 补 schema），通道自动同步

import { deriveChannels } from './derive';
import { IPC_META } from './meta';

/**
 * IPC Channel 常量表（自动生成）
 *
 * 值为协议契约字符串，命名三模式（docs/design/19-ipc-spec.md §一）：
 * `{domain}:{action}` 请求-响应、`{domain}:stream:{event}` 流式、`{domain}:event:{name}` 状态推送。
 * 所有 ipcMain.handle / ipcRenderer.on / webContents.send 必须取此表的字段：键为字面量，
 * 拼写错误编译期报错；裸字符串写错则只在运行时报「没有对应 handler」。
 *
 * 运行时不引入 zod（schema 在 definitions.ts），故 preload 沙箱可经 `@code-agent/shared/ipc/channels` 子路径导入。
 */
export const IPC_CHANNELS = deriveChannels(IPC_META);

/**
 * IPC Channel 值的联合类型（供 channel 参数/字段标注）
 *
 * 当前不等价于字面量联合：deriveChannels 返回签名把值标注为 string，union 未收窄。
 * 拼写保护来自 IPC_CHANNELS 的字面量键，不来自本类型。
 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

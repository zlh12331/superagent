// packages/shared/src/ipc/payloads.ts
// IPC 请求/响应/事件 payload 类型映射
// 设计文档 §5.3 完整 Channel 清单
//
// 每个请求-响应 channel 定义 Req（请求入参）和 Res（响应数据）类型
// 流式/事件 channel 定义 Payload 类型
//
// 说明：业务相关 payload（project/chapter/character/worldview/chat/rag/agent/settings）
// 已随业务层一并删除，仅保留应用级 payload 作为 Electron 模板基础设施。

/**
 * 应用状态（health check）
 *
 * 说明：原 PG/Ollama/DB 状态字段已随数据库层删除，
 * 当前仅保留应用运行状态标记，便于渲染层做基本健康检查。
 */
export interface AppStatus {
  /** 应用是否已就绪（true 表示主进程初始化完成） */
  readonly ready: boolean;
}

/** 请求-响应 channel 类型映射：Req → Res */
export interface IpcRequestMap {
  // 应用级
  'app:getStatus': { req: void; res: AppStatus };
  'app:openExternal': { req: { url: string }; res: { ok: boolean } };
}

/**
 * 流式/事件 channel payload 映射
 *
 * 当前为空映射（业务事件已随数据库层删除）。
 * 使用 Record<string, never> 而非空 interface，
 * 避免 Biome noEmptyInterface 警告且更便于后续按字面量扩展。
 *
 * 扩展示例：export type IpcEventMap = { 'app:event:ready': void };
 */
export type IpcEventMap = Record<string, never>;

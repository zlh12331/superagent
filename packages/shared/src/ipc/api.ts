// packages/shared/src/ipc/api.ts
// IpcApi 接口：window.api 形状定义
// 设计文档 §5.4 类型契约单一来源
//
// Preload 实现 IpcApi，渲染层消费 IpcApi（通过 window.api）
// 全局 Window 接口扩展在此声明，渲染层无需重复声明
//
// 说明：业务相关 API（project/chapter/character/worldview/chat/rag/agent/settings）
// 已随业务层一并删除，仅保留应用级 API 作为 Electron 模板基础设施。

import type { IpcRequestMap } from './payloads';
import type { IpcResponse } from './response';

/**
 * 提取请求-响应 channel 的方法签名
 *
 * 入参类型：IpcRequestMap[Channel]['req']（void 时省略参数）
 * 返回类型：Promise<IpcResponse<IpcRequestMap[Channel]['res']>>
 */
type IpcInvokeMethod<Channel extends keyof IpcRequestMap> =
  IpcRequestMap[Channel]['req'] extends void
    ? () => Promise<IpcResponse<IpcRequestMap[Channel]['res']>>
    : (input: IpcRequestMap[Channel]['req']) => Promise<IpcResponse<IpcRequestMap[Channel]['res']>>;

/**
 * 提取事件 channel 的订阅方法签名
 *
 * 注意：当前 IpcEventMap 为空，此类型暂未使用，保留以便未来扩展事件订阅 API。
 * 启用事件订阅时在 IpcApi 对应域中按需使用即可。
 *
 * 使用 export type 而非 biome-ignore：biome-ignore 无法抑制 TS6196（TS 编译器自带的未使用错误），
 * 通过 export 使类型成为模块导出，可同时消除 Biome 与 TS 的未使用告警。
 */
export type IpcSubscribeMethod<Channel extends keyof import('./payloads').IpcEventMap> = (
  callback: (payload: import('./payloads').IpcEventMap[Channel]) => void,
) => () => void;

/**
 * IpcApi 接口：window.api 完整形状
 *
 * 当前仅包含应用级 API，后续如需扩展业务域，按域分组添加。
 */
export interface IpcApi {
  /** 应用级 API */
  app: {
    /** 获取应用运行状态（health check） */
    getStatus: IpcInvokeMethod<'app:getStatus'>;
    /** 通过系统浏览器打开外链 */
    openExternal: IpcInvokeMethod<'app:openExternal'>;
  };
}

/** 全局 Window 接口扩展（渲染层通过 window.api 访问） */
declare global {
  interface Window {
    api: IpcApi;
  }
}

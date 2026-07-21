// packages/shared/src/ipc/api.ts
// IpcApi 接口：window.api 形状定义
// 设计文档 §5.4 类型契约单一来源
//
// Preload 实现 IpcApi，渲染层消费 IpcApi（通过 window.api）
// 全局 Window 接口扩展在此声明，渲染层无需重复声明
//
// 说明：
// - 业务相关 API（project/chapter/character/worldview/rag/agent/settings）
//   已随数据库层一并删除
// - 当前包含应用级 API + chat 域 API（基于 Vercel AI SDK v7）
//   chat 域 API 同时提供请求-响应方法（send / stop）和事件订阅方法
//   （subscribePart / subscribeEnd / subscribeError）

import type { IpcEventMap, IpcRequestMap } from './payloads';
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
 * 入参：回调函数，收到 payload 时调用
 * 返回：取消订阅函数（调用后不再接收事件）
 */
type IpcSubscribeMethod<Channel extends keyof IpcEventMap> = (
  callback: (payload: IpcEventMap[Channel]) => void,
) => () => void;

/**
 * IpcApi 接口：window.api 完整形状
 *
 * 当前包含：
 * - app：应用级 API（getStatus / openExternal）
 * - chat：聊天域 API（基于 Vercel AI SDK v7）
 *   - send：发起对话，返回 sessionId
 *   - stop：中断指定 sessionId 的对话
 *   - subscribePart：订阅流式 part 事件（UIMessageStreamPart）
 *   - subscribeEnd：订阅流正常结束事件
 *   - subscribeError：订阅流异常结束事件
 */
export interface IpcApi {
  /** 应用级 API */
  app: {
    /** 获取应用运行状态（health check） */
    getStatus: IpcInvokeMethod<'app:getStatus'>;
    /** 通过系统浏览器打开外链 */
    openExternal: IpcInvokeMethod<'app:openExternal'>;
  };

  /** 聊天域 API（Vercel AI SDK v7） */
  chat: {
    /** 发起对话：传入消息历史，返回 sessionId（渲染层用此 id 订阅后续流式事件） */
    send: IpcInvokeMethod<'chat:send'>;
    /** 中断指定 sessionId 的对话（已结束则返回 stopped=false） */
    stop: IpcInvokeMethod<'chat:stop'>;
    /** 订阅流式 part 事件：每收到一个 UIMessageStreamPart 触发一次回调 */
    subscribePart: IpcSubscribeMethod<'chat:stream:part'>;
    /** 订阅流正常结束事件：所有 part 发送完毕后触发一次 */
    subscribeEnd: IpcSubscribeMethod<'chat:stream:end'>;
    /** 订阅流异常结束事件：发生错误时触发一次（含 code + message） */
    subscribeError: IpcSubscribeMethod<'chat:stream:error'>;
  };
}

/** 全局 Window 接口扩展（渲染层通过 window.api 访问） */
declare global {
  interface Window {
    api: IpcApi;
  }
}

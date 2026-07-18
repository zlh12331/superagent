// packages/shared/src/ipc/api.ts
// IpcApi 接口：window.api 形状定义
// 设计文档 §5.4 类型契约单一来源
//
// Preload 实现 IpcApi，渲染层消费 IpcApi（通过 window.api）
// 全局 Window 接口扩展在此声明，渲染层无需重复声明

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

/** 提取事件 channel 的订阅方法签名 */
type IpcSubscribeMethod<Channel extends keyof IpcEventMap> = (
  callback: (payload: IpcEventMap[Channel]) => void,
) => () => void;

/**
 * IpcApi 接口：window.api 完整形状
 *
 * 按业务域分组，每个域包含该域所有 channel 的方法
 */
export interface IpcApi {
  project: {
    create: IpcInvokeMethod<'project:create'>;
    list: IpcInvokeMethod<'project:list'>;
    get: IpcInvokeMethod<'project:get'>;
    update: IpcInvokeMethod<'project:update'>;
    delete: IpcInvokeMethod<'project:delete'>;
    archive: IpcInvokeMethod<'project:archive'>;
  };
  chapter: {
    create: IpcInvokeMethod<'chapter:create'>;
    list: IpcInvokeMethod<'chapter:list'>;
    get: IpcInvokeMethod<'chapter:get'>;
    update: IpcInvokeMethod<'chapter:update'>;
    reorder: IpcInvokeMethod<'chapter:reorder'>;
    delete: IpcInvokeMethod<'chapter:delete'>;
  };
  character: {
    create: IpcInvokeMethod<'character:create'>;
    list: IpcInvokeMethod<'character:list'>;
    update: IpcInvokeMethod<'character:update'>;
    delete: IpcInvokeMethod<'character:delete'>;
    getRelations: IpcInvokeMethod<'character:getRelations'>;
    addRelation: IpcInvokeMethod<'character:addRelation'>;
  };
  worldview: {
    create: IpcInvokeMethod<'worldview:create'>;
    tree: IpcInvokeMethod<'worldview:tree'>;
    update: IpcInvokeMethod<'worldview:update'>;
    delete: IpcInvokeMethod<'worldview:delete'>;
  };
  chat: {
    createSession: IpcInvokeMethod<'chat:createSession'>;
    listSessions: IpcInvokeMethod<'chat:listSessions'>;
    getMessages: IpcInvokeMethod<'chat:getMessages'>;
    sendMessage: IpcInvokeMethod<'chat:sendMessage'>;
    stopGeneration: IpcInvokeMethod<'chat:stopGeneration'>;
    onStreamChunk: IpcSubscribeMethod<'chat:stream:chunk'>;
    onStreamEnd: IpcSubscribeMethod<'chat:stream:end'>;
    onStreamError: IpcSubscribeMethod<'chat:stream:error'>;
  };
  rag: {
    ingestDocument: IpcInvokeMethod<'rag:ingestDocument'>;
    search: IpcInvokeMethod<'rag:search'>;
    listDocuments: IpcInvokeMethod<'rag:listDocuments'>;
    deleteDocument: IpcInvokeMethod<'rag:deleteDocument'>;
  };
  agent: {
    generateChapter: IpcInvokeMethod<'agent:generateChapter'>;
    rewrite: IpcInvokeMethod<'agent:rewrite'>;
    expandOutline: IpcInvokeMethod<'agent:expandOutline'>;
  };
  settings: {
    get: IpcInvokeMethod<'settings:get'>;
    set: IpcInvokeMethod<'settings:set'>;
    setApiKey: IpcInvokeMethod<'settings:setApiKey'>;
    testApiKey: IpcInvokeMethod<'settings:testApiKey'>;
  };
  app: {
    getStatus: IpcInvokeMethod<'app:getStatus'>;
    openExternal: IpcInvokeMethod<'app:openExternal'>;
    onPgStatusChange: IpcSubscribeMethod<'app:event:pgStatus'>;
    onOllamaStatusChange: IpcSubscribeMethod<'app:event:ollamaStatus'>;
    onOllamaPullProgress: IpcSubscribeMethod<'app:event:ollamaPullProgress'>;
  };
}

/** 全局 Window 接口扩展（渲染层通过 window.api 访问） */
declare global {
  interface Window {
    api: IpcApi;
  }
}

// packages/shared/src/ipc/payloads.ts
// IPC 请求/响应/事件 payload 类型映射
// 设计文档 §5.3 完整 Channel 清单
//
// 每个请求-响应 channel 定义 Req（请求入参）和 Res（响应数据）类型
// 流式/事件 channel 定义 Payload 类型

import type {
  ChapterCreateInput,
  ChapterUpdateInput,
  CharacterCreateInput,
  CharacterRelationInput,
  CharacterUpdateInput,
  ChatSendMessageInput,
  ChatSessionCreateInput,
  ChatStreamChunkPayload,
  ChatStreamEndPayload,
  ChatStreamErrorPayload,
  ProjectCreateInput,
  ProjectSettingUpdateInput,
  ProjectUpdateInput,
  RagIngestDocumentInput,
  RagSearchInput,
  RagSearchResultItem,
  TestApiKeyInput,
  WorldviewCreateInput,
  WorldviewUpdateInput,
} from '../schemas';
import type {
  Chapter,
  Character,
  ChatMessage,
  ChatSession,
  Project,
  ProjectSetting,
  RagDocument,
  Worldview,
} from '../types/models';

/** 应用状态（health check） */
export interface AppStatus {
  readonly pgStatus: 'starting' | 'running' | 'stopped' | 'crashed';
  readonly ollamaStatus: 'starting' | 'running' | 'stopped' | 'not_installed';
  readonly ollamaModelReady: boolean;
  readonly dbConnected: boolean;
}

/** Ollama 模型拉取进度事件 payload */
export interface OllamaPullProgressPayload {
  readonly model: string;
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
}

/** 请求-响应 channel 类型映射：Req → Res */
export interface IpcRequestMap {
  // 项目
  'project:create': { req: ProjectCreateInput; res: Project };
  'project:list': { req: void; res: Project[] };
  'project:get': { req: { id: string }; res: Project };
  'project:update': { req: ProjectUpdateInput; res: Project };
  'project:delete': { req: { id: string }; res: { id: string } };
  'project:archive': { req: { id: string }; res: Project };

  // 章节
  'chapter:create': { req: ChapterCreateInput; res: Chapter };
  'chapter:list': { req: { projectId: string }; res: Chapter[] };
  'chapter:get': { req: { id: string }; res: Chapter };
  'chapter:update': { req: ChapterUpdateInput; res: Chapter };
  'chapter:reorder': {
    req: { projectId: string; orderedIds: string[] };
    res: { id: string; sortOrder: number }[];
  };
  'chapter:delete': { req: { id: string }; res: { id: string } };

  // 人物
  'character:create': { req: CharacterCreateInput; res: Character };
  'character:list': { req: { projectId: string }; res: Character[] };
  'character:update': { req: CharacterUpdateInput; res: Character };
  'character:delete': { req: { id: string }; res: { id: string } };
  'character:getRelations': { req: { projectId: string }; res: CharacterRelationInput[] };
  'character:addRelation': { req: CharacterRelationInput; res: CharacterRelationInput };

  // 世界观
  'worldview:create': { req: WorldviewCreateInput; res: Worldview };
  'worldview:tree': { req: { projectId: string }; res: Worldview[] };
  'worldview:update': { req: WorldviewUpdateInput; res: Worldview };
  'worldview:delete': { req: { id: string }; res: { id: string } };

  // 对话
  'chat:createSession': { req: ChatSessionCreateInput; res: ChatSession };
  'chat:listSessions': { req: { projectId: string }; res: ChatSession[] };
  'chat:getMessages': { req: { sessionId: string }; res: ChatMessage[] };
  'chat:sendMessage': { req: ChatSendMessageInput; res: { ackId: string } };
  'chat:stopGeneration': { req: { sessionId: string }; res: { stopped: boolean } };

  // RAG
  'rag:ingestDocument': {
    req: RagIngestDocumentInput;
    res: { documentId: string; chunksCount: number };
  };
  'rag:search': { req: RagSearchInput; res: RagSearchResultItem[] };
  'rag:listDocuments': { req: { projectId: string }; res: RagDocument[] };
  'rag:deleteDocument': { req: { id: string }; res: { id: string } };

  // Agent
  'agent:generateChapter': {
    req: { projectId: string; prevChapterId?: string; prompt?: string };
    res: { ackId: string };
  };
  'agent:rewrite': { req: { chapterId: string; instruction: string }; res: { ackId: string } };
  'agent:expandOutline': { req: { projectId: string; outline: string }; res: { ackId: string } };

  // 设置
  'settings:get': { req: { projectId: string }; res: ProjectSetting };
  'settings:set': { req: ProjectSettingUpdateInput; res: ProjectSetting };
  'settings:setApiKey': {
    req: { provider: 'deepseek' | 'ollama'; apiKey: string };
    res: { ok: boolean };
  };
  'settings:testApiKey': { req: TestApiKeyInput; res: { ok: boolean; latencyMs?: number } };

  // 应用级
  'app:getStatus': { req: void; res: AppStatus };
  'app:openExternal': { req: { url: string }; res: { ok: boolean } };
}

/** 流式/事件 channel payload 映射 */
export interface IpcEventMap {
  'chat:stream:chunk': ChatStreamChunkPayload;
  'chat:stream:end': ChatStreamEndPayload;
  'chat:stream:error': ChatStreamErrorPayload;
  'app:event:pgStatus': AppStatus['pgStatus'];
  'app:event:ollamaStatus': AppStatus['ollamaStatus'];
  'app:event:ollamaPullProgress': OllamaPullProgressPayload;
}

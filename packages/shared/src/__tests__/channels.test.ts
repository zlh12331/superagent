// packages/shared/src/__tests__/channels.test.ts
// IPC_CHANNELS 完整性测试
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc/channels';

describe('IPC_CHANNELS', () => {
  it('所有 channel 字符串符合命名规范 {domain}:{action} 或 {domain}:{stream|event}:{name}', () => {
    // 命名规范：{domain}（纯小写）:{action}（camelCase）或 {domain}:{stream|event}:{name}
    // action / name 段允许 camelCase（如 getRelations、createSession），故用 [a-zA-Z]+
    const pattern = /^[a-z]+:[a-zA-Z]+(?::[a-zA-Z]+)?$/;
    // 仅校验值，键不需要
    for (const [, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel).toMatch(pattern);
    }
  });

  it('channel 值全局唯一（无重复）', () => {
    const values = Object.values(IPC_CHANNELS);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('包含设计文档 §5.3 规定的所有 channel', () => {
    // 抽查关键 channel
    expect(IPC_CHANNELS.PROJECT_CREATE).toBe('project:create');
    expect(IPC_CHANNELS.CHAPTER_LIST).toBe('chapter:list');
    expect(IPC_CHANNELS.CHARACTER_ADD_RELATION).toBe('character:addRelation');
    expect(IPC_CHANNELS.CHAT_SEND_MESSAGE).toBe('chat:sendMessage');
    expect(IPC_CHANNELS.CHAT_STREAM_CHUNK).toBe('chat:stream:chunk');
    expect(IPC_CHANNELS.RAG_INGEST_DOCUMENT).toBe('rag:ingestDocument');
    expect(IPC_CHANNELS.AGENT_GENERATE_CHAPTER).toBe('agent:generateChapter');
    expect(IPC_CHANNELS.SETTINGS_SET_API_KEY).toBe('settings:setApiKey');
    expect(IPC_CHANNELS.APP_GET_STATUS).toBe('app:getStatus');
    expect(IPC_CHANNELS.APP_EVENT_OLLAMA_PULL_PROGRESS).toBe('app:event:ollamaPullProgress');
  });
});

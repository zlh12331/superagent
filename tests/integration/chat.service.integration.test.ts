// tests/integration/chat.service.integration.test.ts
// chat.service 集成测试：真实 PG + Prisma migration + 级联删除验证
// Phase 9 plan Task 4 / 设计文档 §8.3 集成测试策略
//
// 测试场景（覆盖删除会话全链路）：
// 1. 创建项目 → 创建会话 → 发送消息 → saveAssistantMessage → 查询消息列表（验证顺序与角色）
// 2. 删除会话 → 验证消息被级联删除（Prisma schema onDelete: Cascade）
// 3. 删除不存在的会话 → 抛 AppError(NOT_FOUND)
// 4. stopChatGeneration 无活跃流 → 返回 { stopped: false }
//
// 设计要点：
// - 不 mock 任何模块，全链路真实 DB（验证 Prisma migration 与 schema 一致性）
// - 通过 setup.ts 的 getTestPrismaClient() 重置主进程单例缓存，service 调用 getPrismaClient()
//   会拿到测试容器的连接（与 pg-container.ts 中 resetPrismaClient() 配合）
// - StreamBridge 是真实单例，测试中没有活跃流时 has() 返回 false，不影响测试
// - beforeEach 调用 resetDatabase() 清空所有业务表，保证用例隔离
// - 用例间通过唯一 projectId 隔离（避免与其他测试文件冲突，虽然 fileParallelism=false）
//
// 注意：
// - chatSession.create 需要 projectId 外键，必须先创建 project
// - chatMessage.create 需要 sessionId 外键，必须先创建 session
// - Prisma 7 schema 中 ChatMessage.sessionId 配置 onDelete: Cascade，
//   删除 session 时所有 messages 自动级联删除

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTestPrismaClient, isContainerReady } from './helpers/pg-container';
import { resetDatabase } from './helpers/reset-db';

// 容器未就绪时整体跳过
describe.skipIf(!isContainerReady())('chat.service 集成测试', () => {
  /** 测试用 project ID（每个 it 独立创建 project，避免相互依赖） */
  let prisma: ReturnType<typeof getTestPrismaClient>;

  beforeEach(async () => {
    prisma = getTestPrismaClient();
    await resetDatabase();
  });

  /**
   * 创建测试用 project（chatSession.create 需要 projectId 外键）
   *
   * @returns 创建好的 project ID
   */
  async function createTestProject(id: string): Promise<string> {
    await prisma.project.create({
      data: {
        id,
        name: `测试项目-${id}`,
        status: 'ACTIVE',
        metadata: {},
        updatedAt: new Date(),
      },
    });
    return id;
  }

  it('创建会话 → 发送消息 → 查询消息列表（验证角色与顺序）', async () => {
    // 动态导入避免模块加载时立即创建 PrismaClient（setup.ts 已创建单例）
    const { createChatSession, sendChatMessage, saveAssistantMessage, getChatMessages } =
      await import('../../src/main/services/chat.service');

    // 1. 创建 project 与 session
    await createTestProject('chat-it-1');
    const session = await createChatSession({
      projectId: 'chat-it-1',
      title: '集成测试会话',
    });
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('集成测试会话');
    expect(session.projectId).toBe('chat-it-1');

    // 2. 发送用户消息（sendChatMessage 持久化 user 消息，返回 ackId）
    const { ackId } = await sendChatMessage({
      sessionId: session.id,
      content: '你好，请帮我写一段开头',
    });
    expect(ackId).toBeTruthy();

    // 3. 持久化 assistant 消息（模拟 agent.service 流结束后调用）
    const assistantMsg = await saveAssistantMessage(
      session.id,
      '好的，这是一段开头：晨光破晓，少年推开石门……',
    );
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toContain('晨光破晓');

    // 4. 查询消息列表，验证顺序（按 createdAt 升序）与角色
    const messages = await getChatMessages(session.id);
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('你好，请帮我写一段开头');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toContain('晨光破晓');
    // tokens 用 content.length 估算
    expect(messages[0]?.tokens).toBe('你好，请帮我写一段开头'.length);
  });

  it('删除会话 → 验证消息被级联删除（onDelete: Cascade）', async () => {
    const {
      createChatSession,
      sendChatMessage,
      saveAssistantMessage,
      getChatMessages,
      deleteChatSession,
      listChatSessions,
    } = await import('../../src/main/services/chat.service');

    // 1. 准备数据：project + session + 2 条消息
    await createTestProject('chat-it-2');
    const session = await createChatSession({
      projectId: 'chat-it-2',
      title: '将被删除的会话',
    });
    await sendChatMessage({ sessionId: session.id, content: '消息 1' });
    await saveAssistantMessage(session.id, '回复 1');

    // 验证消息已写入
    const beforeDelete = await getChatMessages(session.id);
    expect(beforeDelete.length).toBe(2);

    // 验证会话出现在列表中
    const sessionsBefore = await listChatSessions('chat-it-2');
    expect(sessionsBefore.length).toBe(1);
    expect(sessionsBefore[0]?.id).toBe(session.id);

    // 2. 删除会话
    const result = await deleteChatSession(session.id);
    expect(result.id).toBe(session.id);

    // 3. 验证会话已被删除（列表为空）
    const sessionsAfter = await listChatSessions('chat-it-2');
    expect(sessionsAfter.length).toBe(0);

    // 4. 验证消息被级联删除（chat_messages 表中该 session 的消息全部消失）
    // 注意：getChatMessages 不会因 session 不存在而抛错，只返回空数组
    const afterDelete = await getChatMessages(session.id);
    expect(afterDelete.length).toBe(0);

    // 5. 直接查 DB 验证 chat_messages 表无残留
    const dbCount = await prisma.chatMessage.count({
      where: { sessionId: session.id },
    });
    expect(dbCount).toBe(0);
  });

  it('删除不存在的会话 → 抛 AppError(NOT_FOUND)', async () => {
    const { deleteChatSession } = await import('../../src/main/services/chat.service');

    // 不存在的会话 ID（随机 UUID 格式）
    const nonExistentId = 'non-existent-session-id-12345';

    // 验证抛出 AppError 且错误码为 NOT_FOUND
    await expect(deleteChatSession(nonExistentId)).rejects.toThrow(AppError);
    await expect(deleteChatSession(nonExistentId)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('stopChatGeneration 无活跃流 → 返回 { stopped: false }', async () => {
    // 此用例验证 chat.service 中 stopChatGeneration 的占位行为
    // 集成测试不依赖真实 Ollama / openai-client，所以不可能有活跃流
    const { stopChatGeneration } = await import('../../src/main/services/chat.service');

    const result = await stopChatGeneration('no-active-stream-session');
    expect(result.stopped).toBe(false);
  });

  it('删除 project → 验证 session 与 message 被级联删除', async () => {
    // 额外验证：删除 project 时，关联的 session 与 message 也被级联删除
    // Prisma schema: chat_sessions.projectId onDelete: Cascade
    const { createChatSession, sendChatMessage, getChatMessages } = await import(
      '../../src/main/services/chat.service'
    );

    // 1. 准备数据
    await createTestProject('chat-it-3');
    const session = await createChatSession({
      projectId: 'chat-it-3',
      title: '随项目删除的会话',
    });
    await sendChatMessage({ sessionId: session.id, content: '消息' });

    // 2. 删除 project（直接 DB 操作，service 暂未提供 deleteProject）
    await prisma.project.delete({ where: { id: 'chat-it-3' } });

    // 3. 验证 session 与 message 都被级联删除
    const sessionCount = await prisma.chatSession.count({
      where: { projectId: 'chat-it-3' },
    });
    expect(sessionCount).toBe(0);

    const messageCount = await prisma.chatMessage.count({
      where: { sessionId: session.id },
    });
    expect(messageCount).toBe(0);

    // getChatMessages 应返回空数组（不抛错）
    const messages = await getChatMessages(session.id);
    expect(messages.length).toBe(0);
  });
});

// src/main/infra/remote/remote-agent-bridge.test.ts
// 远程控制 → Agent 桥接单测：审批模式门控 / 串行控制 / 多轮上下文 / 结果回传
// ──────────────────────────────────────────────────────────────
// 依赖全部注入 stub（无网络、无 DB、无真实 agent）：远程控制服务只用作
// onCommand 挂载点，回合完成由测试手动发射 TurnEvent 驱动。
// ──────────────────────────────────────────────────────────────

import type { ApprovalMode } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentService } from '../ai/agent/agent-service';
import type { IPermissionService } from '../ai/tools/permission-service';
import type { ISessionService } from '../storage/session-service';
import { RemoteAgentBridge } from './remote-agent-bridge';
import type {
  IRemoteControlService,
  RemoteCommand,
  RemoteCommandEmitter,
  RemoteCommandResult,
  RemoteTurnEvent,
} from './remote-control';

// 沙箱目录取 app.getPath('userData')/remote-workspace（使用点求值，W9）
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/tmp/test-userdata/${name}`,
  },
}));

/** 桥接监听器签名（阶段 3 起带增量事件通道） */
type CommandHandler = (
  command: RemoteCommand,
  emit: RemoteCommandEmitter,
) => Promise<RemoteCommandResult>;

const NOOP_EMIT: RemoteCommandEmitter = () => {};

/** startAgent 入参形状（测试断言子集） */
interface StartAgentCall {
  readonly messages: ReadonlyArray<{ role: string; content: unknown }>;
  readonly sessionId: string;
  readonly workingDir: string;
  readonly maxSteps: number;
  readonly webContents?: unknown;
}

/** 回合事件形状（测试构造用） */
interface EmitEvent {
  readonly type: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly message?: string;
  readonly reason?: string;
}

/** 桥接依赖的轻量 stub（手写最小实现，不引 mock 框架） */
function createStubs(options: { history?: readonly unknown[] } = {}) {
  const commandHandlers: CommandHandler[] = [];
  const turnListeners: Array<(event: EmitEvent) => void> = [];
  const startAgentCalls: StartAgentCall[] = [];
  const appended: Array<{ sessionId: string; messages: readonly unknown[] }> = [];

  const mockGetApprovalMode = vi.fn((): ApprovalMode => 'auto');
  const mockCreate = vi.fn(async (_options: unknown) => 'session-1');
  const mockGet = vi.fn(async (id: string) => ({
    session: { id },
    messages: options.history ?? [],
  }));
  const mockAppendMessage = vi.fn(
    async (opts: { sessionId: string; messages: readonly unknown[] }) => {
      appended.push({ sessionId: opts.sessionId, messages: opts.messages });
      return opts.messages.length;
    },
  );
  const mockOnCommand = vi.fn((handler: CommandHandler) => {
    commandHandlers.push(handler);
    return () => {
      const index = commandHandlers.indexOf(handler);
      if (index >= 0) commandHandlers.splice(index, 1);
    };
  });

  const stubs = {
    remoteControl: {
      start: vi.fn(async () => 'token'),
      stop: vi.fn(async () => {}),
      isRunning: () => true,
      getSessionToken: () => 'token',
      getPort: () => 45918,
      getInstanceName: () => 'test-desktop',
      getActivity: () => ({ activeCommands: 0, lastCommandAt: null }),
      onCommand: mockOnCommand,
    } as unknown as IRemoteControlService,
    agentService: {
      startAgent: vi.fn(async (opts: StartAgentCall) => {
        startAgentCalls.push(opts);
        return opts.sessionId;
      }),
      onTurnEvent: vi.fn((listener: (event: EmitEvent) => void) => {
        turnListeners.push(listener);
        return () => {
          const index = turnListeners.indexOf(listener);
          if (index >= 0) turnListeners.splice(index, 1);
        };
      }),
    } as unknown as IAgentService,
    permissionService: {
      getApprovalMode: mockGetApprovalMode,
    } as unknown as IPermissionService,
    sessionService: {
      create: mockCreate,
      get: mockGet,
      appendMessage: mockAppendMessage,
    } as unknown as ISessionService,
    commandHandlers,
    turnListeners,
    startAgentCalls,
    appended,
    mockGetApprovalMode,
    mockCreate,
    mockGet,
    mockAppendMessage,
  };
  return stubs;
}

type Stubs = ReturnType<typeof createStubs>;

function command(overrides: Partial<RemoteCommand> = {}): RemoteCommand {
  return { sessionToken: 'token', text: '跑测试', clientId: 'mobile-1', ...overrides };
}

/** 发射回合事件（桥接按 sessionId 过滤） */
function emitTurn(stubs: Stubs, event: EmitEvent): void {
  for (const listener of [...stubs.turnListeners]) {
    listener(event);
  }
}

/** 调用桥接处理器（可注入 emitter 断言增量帧；缺省 noop） */
function callHandler(
  stubs: Stubs,
  cmd: RemoteCommand,
  emitEvents?: RemoteCommandEmitter,
): Promise<RemoteCommandResult> {
  const [handler] = stubs.commandHandlers;
  if (handler === undefined) throw new Error('桥接未挂载 onCommand');
  return handler(cmd, emitEvents ?? NOOP_EMIT);
}

/** 驱动一条命令直到拿到回传结果（自动补完 START/END 事件） */
async function runCommand(
  stubs: Stubs,
  text: string,
  options: { assistantText?: string; reason?: string; emit?: RemoteCommandEmitter } = {},
): Promise<RemoteCommandResult> {
  const pending = callHandler(stubs, command({ text }), options.emit);
  await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));
  emitTurn(stubs, { type: TurnEventType.TURN_START, sessionId: 'session-1', turnId: 'turn-1' });
  if (options.assistantText !== undefined) {
    emitTurn(stubs, {
      type: TurnEventType.TEXT_DELTA,
      sessionId: 'session-1',
      text: options.assistantText,
    });
  }
  emitTurn(stubs, {
    type: TurnEventType.TURN_END,
    sessionId: 'session-1',
    reason: options.reason ?? 'completed',
  });
  return pending;
}

describe('RemoteAgentBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mount 后订阅 onCommand，unmount 解除订阅（幂等）', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();
    bridge.mount(); // 幂等：不重复订阅
    expect(stubs.commandHandlers).toHaveLength(1);

    bridge.unmount();
    bridge.unmount(); // 幂等
    expect(stubs.commandHandlers).toHaveLength(0);
  });

  it('auto 模式：无头执行回合并回传正文（sessionId 取 create 返回值）', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const result = await runCommand(stubs, '跑测试', { assistantText: '34 个文件全部通过' });
    expect(result).toEqual({ accepted: true, reply: '34 个文件全部通过', reason: 'completed' });

    // 会话 id 必须是 sessionService.create 的返回值（create 内部自行生成 id）
    expect(stubs.startAgentCalls).toHaveLength(1);
    const call = stubs.startAgentCalls[0];
    if (call === undefined) throw new Error('startAgent 未被调用');
    expect(call.sessionId).toBe('session-1');
    expect(call.workingDir).toContain('remote-workspace');
    expect(call.maxSteps).toBe(20);
    // 无头：不传 webContents（流式推送跳过）
    expect(call.webContents).toBeUndefined();
    // 桥接不再自行落库（2026-09-08 修复 S1）：AgentService 是唯一写入方
    expect(stubs.mockAppendMessage).not.toHaveBeenCalled();
  });

  it('ask 模式：拒绝执行并回传可读提示（不启动 agent）', async () => {
    const stubs = createStubs();
    stubs.mockGetApprovalMode.mockReturnValue('ask');
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const result = await callHandler(stubs, command({ text: '危险操作' }));
    expect(result?.accepted).toBe(true);
    expect(result?.reply).toContain('ask');
    expect(stubs.startAgentCalls).toHaveLength(0);
    expect(stubs.mockCreate).not.toHaveBeenCalled();
  });

  it('多轮上下文：第二条命令携带首轮历史，且复用同一会话', async () => {
    const stubs = createStubs({ history: [{ role: 'user', content: '上一条' }] });
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    await runCommand(stubs, '第一条', { assistantText: '回答一' });
    await runCommand(stubs, '第二条', { assistantText: '回答二' });

    // 会话只建一次（clientId → sessionId 映射复用）
    expect(stubs.mockCreate).toHaveBeenCalledTimes(1);
    expect(stubs.mockGet).toHaveBeenCalledWith('session-1');
    const second = stubs.startAgentCalls[1];
    expect(second?.messages.map((m) => m.content)).toEqual(['上一条', '第二条']);
  });

  it('同一 clientId 串行：执行中的新命令回传排队提示', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const first = callHandler(stubs, command({ text: '长任务' }));
    await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));

    const busy = await callHandler(stubs, command({ text: '插队' }));
    expect(busy).toEqual({ accepted: true, reply: expect.stringContaining('上一条命令仍在执行') });

    emitTurn(stubs, { type: TurnEventType.TURN_END, sessionId: 'session-1', reason: 'completed' });
    await first;
    // 首回合结束后同一客户端可继续执行
    const third = callHandler(stubs, command({ text: '后续' }));
    await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));
    emitTurn(stubs, { type: TurnEventType.TURN_END, sessionId: 'session-1', reason: 'completed' });
    expect((await third).accepted).toBe(true);
  });

  it('他人会话事件不串台：仅本 session 的 TURN_END 结束本回合', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const pending = callHandler(stubs, command({ text: '任务' }));
    await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));

    // 桌面端并发会话的结束事件 + 文本增量必须被丢弃
    emitTurn(stubs, {
      type: TurnEventType.TEXT_DELTA,
      sessionId: 'other-session',
      text: '串台内容',
    });
    emitTurn(stubs, {
      type: TurnEventType.TURN_END,
      sessionId: 'other-session',
      reason: 'completed',
    });
    emitTurn(stubs, { type: TurnEventType.TEXT_DELTA, sessionId: 'session-1', text: '正确内容' });
    emitTurn(stubs, { type: TurnEventType.TURN_END, sessionId: 'session-1', reason: 'completed' });

    expect(await pending).toEqual({ accepted: true, reply: '正确内容', reason: 'completed' });
  });

  it('非 completed 结束：回传带状态标注；工具事件计入摘要', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const pending = callHandler(stubs, command({ text: '任务' }));
    await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));
    emitTurn(stubs, { type: TurnEventType.TURN_START, sessionId: 'session-1', turnId: 'turn-1' });
    emitTurn(stubs, { type: TurnEventType.TOOL_CALL, sessionId: 'session-1', toolName: 'bash' });
    emitTurn(stubs, { type: TurnEventType.TURN_END, sessionId: 'session-1', reason: 'max-steps' });

    const result = await pending;
    expect(result?.reply).toContain('🔧 bash');
    expect(result?.reply).toContain('达步数上限');
    expect(result?.reason).toBe('max-steps');
  });

  it('纯工具回合（无文本输出）：回传占位说明而非空串', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const result = await runCommand(stubs, '只跑工具');
    expect(result?.reply).toBe('（本轮无文本输出）');
  });

  it('超长输出截断（防撑爆响应体）', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();

    const result = await runCommand(stubs, '长输出', { assistantText: 'x'.repeat(25_000) });
    expect(result?.reply ?? '').toHaveLength(20_000 + '\n…（内容已截断）'.length);
    expect(result?.reply).toContain('内容已截断');
  });

  it('桥接不参与落库：回传结果与 appendMessage 无关（2026-09-08 修复 S1）', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();
    // 即便 appendMessage 会失败，桥接也不再调用它（落库归 AgentService）
    stubs.mockAppendMessage.mockRejectedValue(new Error('SESSION_NOT_FOUND'));

    const pending = callHandler(stubs, command({ text: '任务' }));
    await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));
    emitTurn(stubs, { type: TurnEventType.TEXT_DELTA, sessionId: 'session-1', text: '结果' });
    emitTurn(stubs, { type: TurnEventType.TURN_END, sessionId: 'session-1', reason: 'completed' });
    const result = await pending;
    expect(result.reply).toBe('结果');
    expect(stubs.mockAppendMessage).not.toHaveBeenCalled();
  });

  it('历史回读失败：降级为单轮执行（不拒绝命令）', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();
    stubs.mockGet.mockRejectedValue(new Error('SESSION_NOT_FOUND'));

    const result = await runCommand(stubs, '任务', { assistantText: '仍然可用' });
    expect(result).toEqual({ accepted: true, reply: '仍然可用', reason: 'completed' });
    const call = stubs.startAgentCalls[0];
    expect(call?.messages.map((m) => m.content)).toEqual(['任务']);
  });

  it('startAgent 抛错：回传失败提示（不抛给传输层）', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();
    (stubs.agentService.startAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('模型不可用'),
    );

    const result = await callHandler(stubs, command({ text: '任务' }));
    expect(result).toEqual({ accepted: true, reply: '❌ 执行异常，请查看桌面端日志。' });
  });

  it('阶段 3 增量回推：文本/工具/错误按序外推，他人会话事件不外泄', async () => {
    const stubs = createStubs();
    const bridge = new RemoteAgentBridge(
      stubs.remoteControl,
      stubs.agentService,
      stubs.permissionService,
      stubs.sessionService,
    );
    bridge.mount();
    const emitted: RemoteTurnEvent[] = [];

    const pending = callHandler(stubs, command({ text: '任务' }), (event) => {
      emitted.push(event);
    });
    await vi.waitFor(() => expect(stubs.turnListeners.length).toBeGreaterThan(0));
    emitTurn(stubs, { type: TurnEventType.TEXT_DELTA, sessionId: 'other-session', text: '串台' });
    emitTurn(stubs, { type: TurnEventType.TEXT_DELTA, sessionId: 'session-1', text: '你好' });
    emitTurn(stubs, {
      type: TurnEventType.TOOL_CALL,
      sessionId: 'session-1',
      toolName: 'read_file',
    });
    emitTurn(stubs, { type: TurnEventType.ERROR, sessionId: 'session-1', message: '工具失败' });
    emitTurn(stubs, { type: TurnEventType.TURN_END, sessionId: 'session-1', reason: 'completed' });
    await pending;

    expect(emitted).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'tool', toolName: 'read_file' },
      { type: 'error', message: '工具失败' },
    ]);
  });
});

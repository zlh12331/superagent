// src/main/notification.test.ts
// 回合通知设置门控的单测（33 号系统通知设置）
// ──────────────────────────────────────────────────────────────
// 覆盖 docs/design/33-notification-settings-spec.md 验收标准 V1-V4/V7：
// - V1 缺省（无设置行）→ 维持既有恒通知行为（fail-open 兜底全开）
// - V2 总开关关 → 全不弹；V3 只关完成组；V4 只关出错组
// - V7 前台有焦点窗口 → 无论开关一律不弹（既有规则优先）
// - 反例 2：损坏值（非对象 / 部分字段损坏）→ fail-open / 字段级默认
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  /** 伪通知实例集合（构造即入列，断言 show 与 body） */
  const notifications: { body: string; shown: boolean }[] = [];
  /** 伪焦点窗口集合（isAppInForeground 的输入；空 = 全部后台） */
  const focusedWindows: boolean[] = [];
  return { notifications, focusedWindows };
});

vi.mock('electron', () => {
  class FakeNotification {
    body: string;
    shown = false;
    constructor(opts: { title: string; body: string }) {
      this.body = opts.body;
      mocks.notifications.push(this);
    }
    on(): void {}
    show(): void {
      this.shown = true;
    }
  }
  return {
    // 字符串键：规避 useNamingConvention 对 PascalCase 属性名的检查（window-show.test 同法）
    ['BrowserWindow']: {
      getAllWindows: () =>
        mocks.focusedWindows.map((focused) => ({
          isDestroyed: () => false,
          isMinimized: () => false,
          isFocused: () => focused,
        })),
    },
    ['Notification']: Object.assign(FakeNotification, { isSupported: () => true }),
  };
});

vi.mock('./infra/storage/settings-pref', () => ({
  readSetting: vi.fn(),
}));

vi.mock('./window-show', () => ({
  showMainWindow: vi.fn(),
}));

vi.mock('./utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { type TurnEndEvent, type TurnEvent, TurnEventType } from '@code-agent/shared/main';
import { readSetting } from './infra/storage/settings-pref';
import { mountApprovalNotifications, mountTurnNotifications } from './notification';

type TurnReason = TurnEndEvent['reason'];

/** 组装 TURN_END 事件（订阅回调只消费 type/reason/durationMs） */
function turnEnd(reason: TurnReason): TurnEvent {
  return {
    type: TurnEventType.TURN_END,
    reason,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    timestamp: 0,
    durationMs: 65_000,
  };
}

/** 挂载并捕获回合事件 listener（模拟 AgentService 订阅缝） */
function mountAndCapture(): (event: TurnEvent) => void {
  let listener: ((event: TurnEvent) => void) | undefined;
  mountTurnNotifications({
    onTurnEvent: (l: (event: TurnEvent) => void) => {
      listener = l;
      return () => {};
    },
  } as never);
  if (listener === undefined) {
    throw new Error('mountTurnNotifications 未订阅 onTurnEvent');
  }
  return listener;
}

function setSettingValue(value: unknown): void {
  vi.mocked(readSetting).mockReturnValue(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notifications.length = 0;
  mocks.focusedWindows.length = 0;
});

describe('mountTurnNotifications 通知设置门控', () => {
  it('V1 无设置（undefined）→ completed 照常弹（fail-open 向既有行为）', () => {
    setSettingValue(undefined);
    const emit = mountAndCapture();

    emit(turnEnd('completed'));

    expect(mocks.notifications).toHaveLength(1);
    expect(mocks.notifications[0]?.shown).toBe(true);
  });

  it('V2 总开关关（enabled=false）→ 四种终止一律不弹', () => {
    setSettingValue({ enabled: false, onTurnFinished: true, onTurnFailed: true });
    const emit = mountAndCapture();

    emit(turnEnd('completed'));
    emit(turnEnd('aborted'));
    emit(turnEnd('max-steps'));
    emit(turnEnd('error'));

    expect(mocks.notifications).toHaveLength(0);
  });

  it('V3 只关完成组（onTurnFinished=false）→ completed/aborted/max-steps 不弹、error 仍弹', () => {
    setSettingValue({ enabled: true, onTurnFinished: false, onTurnFailed: true });
    const emit = mountAndCapture();

    emit(turnEnd('completed'));
    emit(turnEnd('aborted'));
    emit(turnEnd('max-steps'));
    expect(mocks.notifications).toHaveLength(0);

    emit(turnEnd('error'));
    expect(mocks.notifications).toHaveLength(1);
  });

  it('V4 只关出错组（onTurnFailed=false）→ error 不弹、completed 仍弹', () => {
    setSettingValue({ enabled: true, onTurnFinished: true, onTurnFailed: false });
    const emit = mountAndCapture();

    emit(turnEnd('error'));
    expect(mocks.notifications).toHaveLength(0);

    emit(turnEnd('completed'));
    expect(mocks.notifications).toHaveLength(1);
  });

  it('V7 前台有焦点窗口 → 即使设置全开也不弹（既有规则优先级不变）', () => {
    setSettingValue({ enabled: true, onTurnFinished: true, onTurnFailed: true });
    mocks.focusedWindows.push(true);
    const emit = mountAndCapture();

    emit(turnEnd('completed'));

    expect(mocks.notifications).toHaveLength(0);
  });

  it('损坏值（非对象）→ fail-open 照常弹（同缺失语义）', () => {
    setSettingValue('garbage');
    const emit = mountAndCapture();

    emit(turnEnd('completed'));

    expect(mocks.notifications).toHaveLength(1);
  });

  it('部分损坏（onTurnFinished 非布尔）→ 该字段按默认 true 补齐，completed 照常弹', () => {
    setSettingValue({ enabled: true, onTurnFinished: 'yes', onTurnFailed: true });
    const emit = mountAndCapture();

    emit(turnEnd('completed'));

    expect(mocks.notifications).toHaveLength(1);
  });
});

/** 审批生命周期回调集合（mountApprovalNotifications 订阅缝的捕获形状） */
interface CapturedLifecycle {
  onRequested: (payload: { sessionId: string; approvalId: string; toolName: string }) => void;
  onResolved: (payload: { sessionId: string; approvalId: string }) => void;
}

/** 挂载并捕获审批生命周期 listener（模拟 PermissionService 订阅缝） */
function mountApprovalAndCapture(): CapturedLifecycle {
  let listener: CapturedLifecycle | undefined;
  mountApprovalNotifications({
    onApprovalLifecycle: (l: CapturedLifecycle) => {
      listener = l;
      return () => {};
    },
  } as never);
  if (listener === undefined) {
    throw new Error('mountApprovalNotifications 未订阅 onApprovalLifecycle');
  }
  return listener;
}

describe('mountApprovalNotifications 通知设置门控（36-A）', () => {
  it('V1 无字段（缺失 onApprovalRequested）→ 审批照常弹（fail-open）且 body 含工具名', () => {
    setSettingValue({ enabled: true, onTurnFinished: true, onTurnFailed: true });
    const lifecycle = mountApprovalAndCapture();

    lifecycle.onRequested({ sessionId: 's1', approvalId: 'a1', toolName: 'run_command' });

    expect(mocks.notifications).toHaveLength(1);
    expect(mocks.notifications[0]?.body).toContain('run_command');
  });

  it('V2 总开关关 → 审批不弹', () => {
    setSettingValue({
      enabled: false,
      onTurnFinished: true,
      onTurnFailed: true,
      onApprovalRequested: true,
    });
    const lifecycle = mountApprovalAndCapture();

    lifecycle.onRequested({ sessionId: 's1', approvalId: 'a1', toolName: 'run_command' });

    expect(mocks.notifications).toHaveLength(0);
  });

  it('V3 只关审批开关 → 审批不弹；开关恢复后照常弹（即时读无缓存）', () => {
    setSettingValue({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: true,
      onApprovalRequested: false,
    });
    const lifecycle = mountApprovalAndCapture();

    lifecycle.onRequested({ sessionId: 's1', approvalId: 'a1', toolName: 'run_command' });
    expect(mocks.notifications).toHaveLength(0);

    setSettingValue({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: true,
      onApprovalRequested: true,
    });
    lifecycle.onRequested({ sessionId: 's1', approvalId: 'a2', toolName: 'write_file' });
    expect(mocks.notifications).toHaveLength(1);
  });

  it('V4 前台有焦点窗口 → 设置全开也不弹（审批弹窗用户可见）', () => {
    setSettingValue({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: true,
      onApprovalRequested: true,
    });
    mocks.focusedWindows.push(true);
    const lifecycle = mountApprovalAndCapture();

    lifecycle.onRequested({ sessionId: 's1', approvalId: 'a1', toolName: 'run_command' });

    expect(mocks.notifications).toHaveLength(0);
  });

  it('V8 系统通知不可用（isSupported=false）→ 静默跳过不抛错', async () => {
    const electron = await vi.importMock<Record<string, unknown>>('electron');
    const original = (electron['Notification'] as { isSupported: () => boolean }).isSupported;
    (electron['Notification'] as { isSupported: () => boolean }).isSupported = () => false;
    try {
      setSettingValue({
        enabled: true,
        onTurnFinished: true,
        onTurnFailed: true,
        onApprovalRequested: true,
      });
      const lifecycle = mountApprovalAndCapture();

      expect(() =>
        lifecycle.onRequested({ sessionId: 's1', approvalId: 'a1', toolName: 'run_command' }),
      ).not.toThrow();
      expect(mocks.notifications).toHaveLength(0);
    } finally {
      (electron['Notification'] as { isSupported: () => boolean }).isSupported = original;
    }
  });

  it('部分损坏（onApprovalRequested 非布尔）→ 字段按默认 true 补齐，审批照常弹', () => {
    setSettingValue({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: true,
      onApprovalRequested: 'yes',
    });
    const lifecycle = mountApprovalAndCapture();

    lifecycle.onRequested({ sessionId: 's1', approvalId: 'a1', toolName: 'run_command' });

    expect(mocks.notifications).toHaveLength(1);
  });

  it('onResolved 决议回调 → 不产生任何通知', () => {
    setSettingValue({
      enabled: true,
      onTurnFinished: true,
      onTurnFailed: true,
      onApprovalRequested: true,
    });
    const lifecycle = mountApprovalAndCapture();

    lifecycle.onResolved({ sessionId: 's1', approvalId: 'a1' });

    expect(mocks.notifications).toHaveLength(0);
  });
});

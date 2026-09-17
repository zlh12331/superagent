// src/renderer/components/$1/im-allowlist-field.test.tsx
// IM 群聊白名单编辑区测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09 安全审计修复）：写入是**覆盖式**的（settings:set），而读取
// 此前 catch 后静默返回 []。于是「读取失败」与「真的是空白名单」在 UI 上不可区分，
// 用户在读取失败时点保存 → 用空数组覆盖掉服务端已登记的白名单，
// 群聊执行策略被静默清空。现改为：
// - 读取失败不吞异常（进入 query error 态）
// - 保存按钮在 pending / error 时禁用
// - 编辑区在 error 时禁用并给出明确提示
// 本文件锁定这三条。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { ImAllowlistField } from './im-allowlist-field';

/** 构造封装（retry: false 让失败立即进入 error 态） */
function renderField() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ImAllowlistField />, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** 装配 window.api.settings mock */
function setupApi(getAll: () => Promise<unknown>, setImpl = vi.fn()) {
  window.api = {
    settings: { getAll, set: setImpl },
  } as never;
  return { setImpl };
}

describe('ImAllowlistField', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正向：读取已有白名单并回填到编辑区', async () => {
    setupApi(async () => ({ data: { settings: { 'im.allowedGroups': ['telegram:1', 'qq:2'] } } }));

    renderField();

    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('telegram:1\nqq:2'),
    );
    // 保存按钮在数据就绪后可用
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('边界：无该设置键 → 空白名单（合法空态，非错误）', async () => {
    setupApi(async () => ({ data: { settings: {} } }));

    renderField();

    // 等待查询落地后仍应为空且按钮可用
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('异常：读取失败 → 保存禁用 + 明确提示（防覆盖式清空白名单）', async () => {
    // 错误信封（unwrap 抛错）→ 不再被吞成空数组
    setupApi(async () => ({ error: { code: 'SETTINGS_READ_FAILED', message: 'db locked' } }));

    renderField();

    expect(await screen.findByText(i18n.t('settings.imAllowedGroupsLoadFailed'))).toBeDefined();
    // 关键：读取未就绪/失败时不得允许写入
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('异常：读取抛出（窗口无桥）→ 同样禁用保存，不静默降级为可写空列表', async () => {
    setupApi(async () => {
      throw new Error('boom');
    });

    renderField();

    expect(await screen.findByText(i18n.t('settings.imAllowedGroupsLoadFailed'))).toBeDefined();
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

// src/renderer/components/common/__tests__/AsyncSection.test.tsx
// AsyncSection 四态包装器 + QueryErrorRow/QueryPendingRow 行内形态单测
// ──────────────────────────────────────────────
// 覆盖动机：组件此前 0% 覆盖，而它有 9 个 settings section 调用方——
// 四态优先级（pending > error > empty > ready）、空态文案缺省不渲染、
// 重试按钮可选、error 详情截断（title 承载完整内容）均无回归锚。
// 本文件同时守护 2026-09-15 的 ErrorRowBody 提取（两个导出共用同一内容）。
// ──────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { AsyncSection, QueryErrorRow, QueryPendingRow } from './AsyncSection';

const t = i18n.t.bind(i18n);

describe('AsyncSection', () => {
  it('ready：渲染 children', () => {
    render(
      <AsyncSection isPending={false} isError={false} isEmpty={false}>
        <div data-testid="content">内容</div>
      </AsyncSection>,
    );
    expect(screen.getByTestId('content')).toBeDefined();
  });

  it('pending：渲染加载态（role=status + 加载文案），不渲染 children', () => {
    render(
      <AsyncSection isPending isError={false} isEmpty={false}>
        <div data-testid="content">内容</div>
      </AsyncSection>,
    );
    // Spinner 自身也带 role=status，故用 getAllByRole 断言存在含加载文案的那一个
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((el) => el.textContent?.includes(t('common.loading')))).toBe(true);
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('error：渲染失败文案 + 详情截断（title 带完整内容）+ 重试按钮', () => {
    const onRetry = vi.fn();
    const longMessage = 'x'.repeat(200);
    render(
      <AsyncSection
        isPending={false}
        isError
        isEmpty={false}
        errorMessage={longMessage}
        onRetry={onRetry}
      >
        <div>内容</div>
      </AsyncSection>,
    );
    expect(screen.getByRole('alert').textContent).toContain(t('common.sectionLoadFailed'));
    // 详情通过 title 承载完整内容（可见文本可能被 CSS 截断）
    expect(screen.getByTitle(longMessage)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error：errorMessage 为空串/null/undefined 时不渲染详情 span', () => {
    const { unmount } = render(
      <AsyncSection isPending={false} isError isEmpty={false} errorMessage="">
        <div>内容</div>
      </AsyncSection>,
    );
    // 空串：只有失败文案，无 title 详情节点
    expect(screen.getByRole('alert').querySelectorAll('span')).toHaveLength(1);
    unmount();
    render(
      <AsyncSection isPending={false} isError isEmpty={false} errorMessage={null}>
        <div>内容</div>
      </AsyncSection>,
    );
    expect(screen.getByRole('alert').querySelectorAll('span')).toHaveLength(1);
  });

  it('error：未传 onRetry → 不渲染重试按钮', () => {
    render(
      <AsyncSection isPending={false} isError isEmpty={false}>
        <div>内容</div>
      </AsyncSection>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('empty：渲染空态文案（role=status）', () => {
    render(
      <AsyncSection isPending={false} isError={false} isEmpty emptyText="暂无数据">
        <div data-testid="content">内容</div>
      </AsyncSection>,
    );
    expect(screen.getByRole('status').textContent).toBe('暂无数据');
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('边界：empty 且未传 emptyText（或空串）→ 渲染 null', () => {
    const { container } = render(
      <AsyncSection isPending={false} isError={false} isEmpty>
        <div>内容</div>
      </AsyncSection>,
    );
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(
      <AsyncSection isPending={false} isError={false} isEmpty emptyText="">
        <div>内容</div>
      </AsyncSection>,
    );
    expect(c2.firstChild).toBeNull();
  });

  it('边界：四态优先级 pending > error > empty > ready（同时为真时取更靠前者）', () => {
    const { container } = render(
      <AsyncSection isPending isError isEmpty emptyText="空">
        <div data-testid="content">内容</div>
      </AsyncSection>,
    );
    expect(container.textContent).toContain(t('common.loading'));
    expect(container.textContent).not.toContain('空');
  });
});

describe('QueryErrorRow', () => {
  it('isError=false → 渲染 null（可直接嵌在 JSX 任意位置）', () => {
    const { container } = render(<QueryErrorRow isError={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('isError=true → 失败文案 + 详情 + 重试（与 AsyncSection error 同款内容）', () => {
    const onRetry = vi.fn();
    render(<QueryErrorRow isError errorMessage="出错了" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain(t('common.sectionLoadFailed'));
    expect(screen.getByTitle('出错了')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('边界：isError 但无详情无重试 → 仅失败文案', () => {
    render(<QueryErrorRow isError />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(t('common.sectionLoadFailed'));
    expect(alert.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('QueryPendingRow', () => {
  it('isPending=true → role=status + 加载文案', () => {
    render(<QueryPendingRow isPending />);
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((el) => el.textContent?.includes(t('common.loading')))).toBe(true);
  });

  it('isPending=false → 渲染 null', () => {
    const { container } = render(<QueryPendingRow isPending={false} />);
    expect(container.firstChild).toBeNull();
  });
});

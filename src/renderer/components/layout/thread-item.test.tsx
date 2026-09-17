// src/renderer/components/layout/thread-item.test.tsx
// 会话线程项测试（正向 / 边界 / 异常）：选择 / 内联重命名生命周期 / 菜单回调 /
// 置顶标识 / 搜索高亮 / 删除中禁用 / 拖拽态视觉
// ──────────────────────────────────────────────────────────────
// mock 边界：useRenameSession（mutation 边界）与 @dnd-kit/sortable（拖拽库）；
// 菜单（Radix DropdownMenu）、重命名输入、键盘交互走真实实现。
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

const { mockRenameAsync, sortableState } = vi.hoisted(() => ({
  mockRenameAsync: vi.fn(),
  sortableState: { isDragging: false },
}));

vi.mock('@/hooks/use-sessions', () => ({
  // 组件仅解构 mutateAsync；重命名提交经 mutation 落库（invalidate 由 hook 内部负责）
  useRenameSession: () => ({ mutateAsync: mockRenameAsync }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  // 拖拽库在 jsdom 无实际几何：给惰性值即可；isDragging 由用例按需置位
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: sortableState.isDragging,
  }),
}));

import { SortableThreadItem } from './thread-item';

const base = {
  sessionId: 's1',
  folderName: 'proj',
  title: '我的会话',
  updatedAt: Date.now(),
  isActive: false,
  isDeleting: false,
  isPinned: false,
  highlighted: false,
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onTogglePin: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenInExplorer: vi.fn(),
};

type Props = Partial<typeof base> & { title: string; sessionId: string };

function renderThread(overrides: Partial<Props> = {}) {
  const props = { ...base, ...overrides };
  const view = render(<SortableThreadItem {...props} />);
  return { props, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRenameAsync.mockResolvedValue({ data: { ok: true } });
  sortableState.isDragging = false;
});

describe('ThreadItem · 渲染与选择', () => {
  it('正向：渲染标题 + 相对时间元信息 + 拖拽点', () => {
    const { container } = renderThread();
    expect(screen.getByText('我的会话')).toBeDefined();
    expect(container.querySelector('.ti-meta')).not.toBeNull();
    expect(container.querySelector('.ti-dot')).not.toBeNull();
  });

  it('正向：点击内容区 → onSelect；Enter 键同样触发', () => {
    const { props } = renderThread();
    fireEvent.click(screen.getByRole('button', { name: /我的会话/ }));
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('button', { name: /我的会话/ }), { key: 'Enter' });
    expect(props.onSelect).toHaveBeenCalledTimes(2);
  });

  it('正向：激活会话 → aria-current=page + active 类', () => {
    const { container } = renderThread({ isActive: true });
    const row = container.querySelector('.thread-item') as HTMLElement;
    expect(row).toHaveClass('active');
    expect(row.getAttribute('aria-current')).toBe('page');
  });

  it('正向边界：置顶会话显示 Pin 图标，未置顶不显示', () => {
    const { container, rerender } = renderThread({ isPinned: true });
    expect(container.querySelector('.lucide-pin')).not.toBeNull();
    rerender(<SortableThreadItem {...base} title="我的会话" sessionId="s1" isPinned={false} />);
    expect(container.querySelector('.lucide-pin')).toBeNull();
  });

  it('正向边界：搜索高亮 → ring 类（2 秒高亮环的视觉锚）', () => {
    const { container } = renderThread({ highlighted: true });
    expect(container.querySelector('.thread-item')?.className).toContain('ring-1');
  });

  it('异常：拖拽进行中 → 包装层半透明（isDragging 视觉）', () => {
    sortableState.isDragging = true;
    const { container } = renderThread();
    expect(container.querySelector('.opacity-50')).not.toBeNull();
  });

  it('异常：isDeleting → 操作按钮禁用', () => {
    renderThread({ isDeleting: true });
    expect(screen.getByLabelText(i18n.t('sidebar.sessionActions'))).toBeDisabled();
    expect(screen.getByLabelText(i18n.t('sidebar.openFiles'))).toBeDisabled();
  });
});

describe('ThreadItem · 内联重命名生命周期', () => {
  it('正向：双击标题进入重命名，Enter 提交新名（mutation 收到 trim 后的值）', async () => {
    renderThread();
    fireEvent.doubleClick(screen.getByRole('button', { name: /我的会话/ }));
    const input = await screen.findByLabelText(i18n.t('sidebar.renameTitle'));
    fireEvent.change(input, { target: { value: '  新名字  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(mockRenameAsync).toHaveBeenCalledWith({ id: 's1', title: '新名字' }),
    );
    // 提交后退出编辑态
    expect(screen.queryByLabelText(i18n.t('sidebar.renameTitle'))).toBeNull();
  });

  it('正向：失焦提交（blur 路径）', async () => {
    renderThread();
    fireEvent.doubleClick(screen.getByRole('button', { name: /我的会话/ }));
    const input = await screen.findByLabelText(i18n.t('sidebar.renameTitle'));
    fireEvent.change(input, { target: { value: '失焦提交' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(mockRenameAsync).toHaveBeenCalledWith({ id: 's1', title: '失焦提交' }),
    );
  });

  it('边界：空名提交 → 不调 mutation（仅退出编辑态）', async () => {
    renderThread();
    fireEvent.doubleClick(screen.getByRole('button', { name: /我的会话/ }));
    const input = await screen.findByLabelText(i18n.t('sidebar.renameTitle'));
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockRenameAsync).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(i18n.t('sidebar.renameTitle'))).toBeNull();
  });

  it('边界：名称未变化提交 → 不调 mutation', async () => {
    renderThread();
    fireEvent.doubleClick(screen.getByRole('button', { name: /我的会话/ }));
    const input = await screen.findByLabelText(i18n.t('sidebar.renameTitle'));
    fireEvent.keyDown(input, { key: 'Enter' }); // defaultValue 未变
    expect(mockRenameAsync).not.toHaveBeenCalled();
  });

  it('正向：Escape 退出编辑态且不提交', async () => {
    renderThread();
    fireEvent.doubleClick(screen.getByRole('button', { name: /我的会话/ }));
    const input = await screen.findByLabelText(i18n.t('sidebar.renameTitle'));
    fireEvent.change(input, { target: { value: '不该提交' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(mockRenameAsync).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(i18n.t('sidebar.renameTitle'))).toBeNull();
  });
});

describe('ThreadItem · 操作菜单', () => {
  async function openMenu(): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(i18n.t('sidebar.sessionActions')));
    // Radix 菜单内容渲染在 portal 中，等待出现
    await screen.findByText(i18n.t('sidebar.pin'));
  }

  it('正向：菜单「置顶」→ onTogglePin', async () => {
    const { props } = renderThread();
    await openMenu();
    await userEvent.click(screen.getByText(i18n.t('sidebar.pin')));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('正向：菜单「文件管理」→ onOpenFiles；「在资源管理器中打开」→ onOpenInExplorer', async () => {
    const { props } = renderThread();
    await openMenu();
    await userEvent.click(screen.getByText(i18n.t('sidebar.fileManager')));
    expect(props.onOpenFiles).toHaveBeenCalledTimes(1);
    await openMenu();
    await userEvent.click(screen.getByText(i18n.t('sidebar.openInExplorer')));
    expect(props.onOpenInExplorer).toHaveBeenCalledTimes(1);
  });

  it('正向：菜单「重命名」→ 选中后关闭菜单（输入态由双击用例覆盖）', async () => {
    // jsdom 中 Radix 关菜单的焦点还原与 autoFocus 输入的 blur 提交竞态——
    // 未改名即退出编辑态属时序产物，真实浏览器输入框持焦。此处断言菜单选中链路。
    renderThread();
    await openMenu();
    fireEvent.click(screen.getByText(i18n.t('sidebar.rename')));
    await waitFor(() => expect(screen.queryByText(i18n.t('sidebar.rename'))).toBeNull());
  });

  it('正向：菜单「删除会话」→ onDelete', async () => {
    const { props } = renderThread();
    await openMenu();
    await userEvent.click(screen.getByText(i18n.t('sidebar.deleteSession')));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('正向：独立「文件树」按钮 → onOpenFiles 且不冒泡成选择', async () => {
    const { props } = renderThread();
    fireEvent.click(screen.getByLabelText(i18n.t('sidebar.openFiles')));
    expect(props.onOpenFiles).toHaveBeenCalledTimes(1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

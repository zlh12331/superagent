// src/renderer/components/file-tree/__tests__/file-tree-create-edit.integration.test.tsx
// 文件树「新建 → 呈现 → 打开 → 编辑 → 保存」端到端集成测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 与 file-tree-viewer.integration 互补：那份覆盖「点击已有文件 → 查看」，
// 本份覆盖**写路径**——从工具栏新建（真实 useFileTreeOps → file:create IPC）
// 经 watch 事件落地到树，再打开、编辑、保存（真实 useFileWrite → file:write IPC）。
//
// mock 边界（单元/集成分层原则）：
// - 仅 mock useFileTree（IPC + watch 订阅的数据生命周期，其内部由 hooks 测试覆盖）
//   与 shiki（重依赖）。watch 事件在此**手工派发**（模拟 useFileTree 的订阅回调
//   把事件写进 store），因此被测链路是 store + 组件 + useFileTreeOps +
//   useFileContent/useFileWrite 的真实组合。
// - window.api（file.create / file.read / file.write）为内存假实现。
// ──────────────────────────────────────────────────────────────

import type { FileEntry } from '@code-agent/shared/renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';

import { FileTreePanel } from './FileTreePanel';
import { FileViewerPanel } from './FileViewerPanel';

vi.mock('@/hooks/use-file-tree', () => ({ useFileTree: () => ({ refresh: vi.fn() }) }));

const { getHighlighterMock, ensureLangLoadedMock } = vi.hoisted(() => ({
  getHighlighterMock: vi.fn(),
  ensureLangLoadedMock: vi.fn(),
}));
vi.mock('@/lib/highlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/highlight')>()),
  getHighlighter: getHighlighterMock,
  ensureLangLoaded: ensureLangLoadedMock,
}));

const ROOT = 'C:\\proj';
const NEW_FILE = `${ROOT}\\new.ts`;

/** 内存假文件系统：read 读它、write 改它（使保存链路可断言） */
let disk = new Map<string, string>();

/** 就绪态树：根目录展开且已加载空条目 */
function seedEmptyRoot(): void {
  useFileTreeStore.getState().setRootPath(ROOT);
  useFileTreeStore.getState().setEntries(ROOT, []);
}

/** 模拟 useFileTree 的 watch 处理：create 事件 → 重载父目录条目 */
function emitWatchCreate(parentDir: string, entry: FileEntry): void {
  const store = useFileTreeStore.getState();
  const existing = store.entries.get(parentDir) ?? [];
  store.setEntries(parentDir, [...existing, entry]);
}

function renderTreeAndViewer() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider>
        <FileTreePanel workingDir={ROOT} />
        <FileViewerPanel />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** 打开头部「更多操作」菜单并点击某项 */
async function clickMoreMenuItem(label: string): Promise<void> {
  await userEvent.click(screen.getByLabelText(i18n.t('fileTree.moreActions')));
  await userEvent.click(await screen.findByText(label));
}

beforeEach(() => {
  vi.clearAllMocks();
  disk = new Map();
  getHighlighterMock.mockResolvedValue({
    codeToHtml: vi.fn((content: string) => `<pre data-testid="hl">${content}</pre>`),
  });
  ensureLangLoadedMock.mockResolvedValue(undefined);
  window.api.file = {
    create: vi.fn().mockResolvedValue({ data: { path: NEW_FILE } }),
    createDir: vi.fn().mockResolvedValue({ data: { path: `${ROOT}\\newdir` } }),
    read: vi.fn(({ path }: { path: string }) =>
      Promise.resolve({ data: { content: disk.get(path) ?? '', totalLines: 1 } }),
    ),
    write: vi.fn(({ path, content }: { path: string; content: string }) => {
      disk.set(path, content);
      return Promise.resolve({ data: { bytesWritten: content.length } });
    }),
  } as never;
  useFileTreeStore.getState().reset();
  useFileViewerStore.setState({
    open: false,
    filePath: null,
    editMode: false,
    originalContent: '',
    editedContent: '',
    isDirty: false,
  });
  seedEmptyRoot();
});

describe('文件树 → 查看器 · 新建/编辑/保存链路', () => {
  it('正向：工具栏新建文件 → 落盘 → watch 落地到树 → 打开 → 编辑 → 保存', async () => {
    renderTreeAndViewer();

    // 1. 工具栏新建文件 → 出现内联输入框
    await clickMoreMenuItem(i18n.t('fileTree.addFile'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });

    // 2. Enter 提交 → 真实 useFileTreeOps 调 file:create（路径由 joinPath 拼接）
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(window.api.file.create).toHaveBeenCalledWith({
        path: NEW_FILE,
        createDirs: false,
      }),
    );
    // 成功后内联新建态收起
    await waitFor(() => expect(useFileTreeStore.getState().creatingEntry).toBeNull());

    // 3. watch create 事件把新条目写入父目录缓存（模拟 useFileTree 订阅处理器）
    emitWatchCreate(ROOT, { name: 'new.ts', path: NEW_FILE, type: 'file', size: 0, modifiedAt: 0 });
    expect(await screen.findByText('new.ts')).toBeDefined();

    // 4. 点击新文件 → 打开查看器（内容为空文件态）
    const fileButton = screen.getAllByRole('button').find((b) => b.textContent === 'new.ts');
    expect(fileButton).toBeDefined();
    fireEvent.click(fileButton as HTMLElement);

    await waitFor(() => expect(useFileViewerStore.getState().open).toBe(true));
    expect(await screen.findByText(i18n.t('common.emptyFile'))).toBeDefined();

    // 5. 进入编辑态并输入内容
    fireEvent.click(screen.getByLabelText(i18n.t('fileViewer.switchToEdit')));
    const textarea = await screen.findByLabelText(i18n.t('chat.editFileLabel', { name: 'new.ts' }));
    fireEvent.change(textarea, { target: { value: 'export const x = 1;' } });
    expect(useFileViewerStore.getState().isDirty).toBe(true);

    // 6. 保存 → file:write 落盘 + dirty 复位 + 缓存失效回读
    fireEvent.click(screen.getByLabelText(i18n.t('common.save')));
    await waitFor(() =>
      expect(window.api.file.write).toHaveBeenCalledWith(
        expect.objectContaining({ path: NEW_FILE, content: 'export const x = 1;' }),
      ),
    );
    expect(disk.get(NEW_FILE)).toBe('export const x = 1;');
    await waitFor(() => expect(useFileViewerStore.getState().isDirty).toBe(false));
  });

  it('正向：工具栏新建目录 → file:createDir 带拼接后路径', async () => {
    renderTreeAndViewer();

    await clickMoreMenuItem(i18n.t('fileTree.addFolder'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'newdir' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(window.api.file.createDir).toHaveBeenCalledWith({ path: `${ROOT}\\newdir` }),
    );
    expect(window.api.file.create).not.toHaveBeenCalled();
  });

  it('正向边界：新建在途期间父目录行带 pending 类（状态抵达 UI），完成后移除', async () => {
    // 受控 create：不立即 resolve，以便观察在途态
    let resolveCreate!: (value: unknown) => void;
    window.api.file = {
      ...(window.api.file ?? {}),
      create: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      ),
    } as never;

    const { container } = renderTreeAndViewer();
    await clickMoreMenuItem(i18n.t('fileTree.addFile'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 在途：根目录行 pending（新建的 fullPath 不在 entries 中，若按它标记则永不命中）
    await waitFor(() => expect(container.querySelector('.ft-dir.pending')).not.toBeNull());

    resolveCreate({ data: { path: NEW_FILE } });
    await waitFor(() => expect(container.querySelector('.ft-dir.pending')).toBeNull());
  });

  it('异常：落盘失败（错误信封）→ 保留内联新建态，用户可改名重试', async () => {
    window.api.file = {
      ...(window.api.file ?? {}),
      create: vi.fn().mockResolvedValue({
        error: { code: 'FS_WRITE_FAILED', message: 'EACCES: permission denied' },
      }),
    } as never;

    renderTreeAndViewer();
    await clickMoreMenuItem(i18n.t('fileTree.addFile'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'new.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // 失败后输入框仍在（可改名重试），且不写入树
    await waitFor(() => expect(window.api.file.create).toHaveBeenCalledTimes(1));
    expect(useFileTreeStore.getState().creatingEntry).not.toBeNull();
    expect(useFileTreeStore.getState().entries.get(ROOT)).toEqual([]);
  });
});

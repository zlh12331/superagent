import { create } from 'zustand';

import { i18n } from '@/i18n';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useUiStore } from '@/stores/transient/ui-store';

/**
 * 文件查看器状态形状
 */
interface FileViewerState {
  /** 是否已选择文件（false = 右面板显示引导空态） */
  readonly open: boolean;
  /** 当前查看的文件绝对路径（重开前仍保留，用于渲染上次内容避免空态闪烁） */
  readonly filePath: string | null;

  /** 是否处于编辑模式（false = 只读查看模式） */
  readonly editMode: boolean;
  /** 原始文件内容（从 IPC 拉取后缓存，用于脏数据比较和取消恢复） */
  readonly originalContent: string;
  /** 编辑后的内容（textarea 受控值，初始 = originalContent） */
  readonly editedContent: string;
  /** 是否有未保存的修改（editedContent !== originalContent） */
  readonly isDirty: boolean;

  /**
   * 打开指定文件（FileTreePanel / 命令面板 / 引用文件跳转共用），自动重置编辑态。
   * 脏数据保护：当前文件有未保存修改时先确认，取消则保持当前文件。
   */
  readonly openFile: (filePath: string) => Promise<void>;

  /** 注册当前查看器实例的保存处理器（编辑态打开时注册，关闭/卸载时注销） */
  readonly registerSaveHandler: (handler: (() => void) | null) => void;
  /** 触发保存（无处理器时 no-op；处理器内部自带 isDirty/保存中防重） */
  readonly requestSave: () => void;

  /**
   * 设置从 IPC 加载的原始内容
   * - 同步更新 originalContent / editedContent
   * - 重置 isDirty
   * - 当 open 内容为空字符串时也视为有效（空文件）
   */
  readonly setLoadedContent: (content: string) => void;

  /** 进入编辑模式（保留当前 editedContent） */
  readonly enterEditMode: () => void;
  /** 退出编辑模式，恢复到 originalContent（丢弃未保存修改） */
  readonly exitEditMode: () => void;

  /** 编辑态内容变化回调（textarea onChange） */
  readonly setEditedContent: (content: string) => void;

  /** 标记保存成功：将 originalContent 同步为当前 editedContent，重置 isDirty */
  readonly markSaved: () => void;
}

/**
 * 计算脏数据标记
 */
function computeDirty(original: string, edited: string): boolean {
  return original !== edited;
}

/**
 * 当前保存处理器（模块级变量，非响应式状态）
 *
 * 仅作 AppShell 全局 Ctrl+S 快捷键 → FileViewerPanel.handleSave 的桥接；
 * 不放进 zustand state：注册/注销不应触发任何订阅者重渲染。
 */
let saveHandler: (() => void) | null = null;

/**
 * 文件查看器 store
 *
 * @example
 * ```tsx
 * const open = useFileViewerStore((s) => s.open);
 * const filePath = useFileViewerStore((s) => s.filePath);
 * const openFile = useFileViewerStore((s) => s.openFile);
 *
 * // FileTreePanel 点击文件
 * openFile('D:\\proj\\src\\index.ts');
 *
 * // FileViewerPanel 受控渲染（open=false 时显示引导空态）
 * ```
 */
export const useFileViewerStore = create<FileViewerState>()((set) => ({
  open: false,
  filePath: null,

  editMode: false,
  originalContent: '',
  editedContent: '',
  isDirty: false,

  openFile: async (filePath) => {
    const current = useFileViewerStore.getState();
    if (current.open && current.isDirty && current.filePath !== filePath) {
      const ok = await confirm({
        title: i18n.t('fileViewer.unsaved'),
        message: i18n.t('fileViewer.confirmDiscardChanges'),
        danger: true,
      });
      if (!ok) return;
    }
    if (current.open && current.filePath === filePath && !current.isDirty) {
      useUiStore.getState().setRightPanelCollapsed(false);
      useUiStore.getState().setDevPanelTab('file');
      return;
    }
    set({
      open: true,
      filePath,
      editMode: false,
      originalContent: '',
      editedContent: '',
      isDirty: false,
    });
    useUiStore.getState().setRightPanelCollapsed(false);
    useUiStore.getState().setDevPanelTab('file');
  },

  registerSaveHandler: (handler) => {
    saveHandler = handler;
  },

  requestSave: () => {
    saveHandler?.();
  },

  setLoadedContent: (content) =>
    set({
      originalContent: content,
      editedContent: content,
      isDirty: false,
    }),

  enterEditMode: () => set({ editMode: true }),

  exitEditMode: () =>
    set((state) => ({
      editMode: false,
      editedContent: state.originalContent,
      isDirty: false,
    })),

  setEditedContent: (content) =>
    set((state) => ({
      editedContent: content,
      isDirty: computeDirty(state.originalContent, content),
    })),

  markSaved: () =>
    set((state) => ({
      originalContent: state.editedContent,
      isDirty: false,
    })),
}));

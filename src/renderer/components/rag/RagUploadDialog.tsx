// src/renderer/components/rag/RagUploadDialog.tsx
// RAG 文档上传对话框 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 标题/标签用 font-serif 衬线字体
// - 错误提示用 text-error token（替代 destructive）
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 受控对话框（open + onOpenChange），收集标题 + 文件两个输入
// - 文件选择使用原生 <input type="file">（不引入 react-dropzone 等额外依赖）
// - 提交时根据文件类型分流：
//   - 文本类（.md/.txt/.json）：readFileAsText → fileContent 直接传文本
//   - PDF（.pdf）：readFileAsBase64 → fileContent 传 base64 字符串（主进程解码+解析）
// - 成功后清空表单 + 关闭对话框 + 调 onUploaded 回调；失败时不关闭，让用户重试
//
// 注意：
// - title 必填，按钮 disabled 即时反馈
// - 文件大小限制 10MB，超过显示警告并禁用提交
// - exactOptionalPropertyTypes 开启：mimeType 为可选属性，用条件展开传入
// - noUncheckedIndexedAccess 开启：数组/字符串索引返回 T | undefined，需兜底

import { FileUp } from 'lucide-react';
import type { ChangeEvent, ReactElement } from 'react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readFileAsBase64, readFileAsText, useIngestRagDocument } from '@/hooks/use-rag';
import { handleIpcError } from '@/lib/handle-ipc-error';
import { cn } from '@/lib/utils';

interface RagUploadDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（受控） */
  onOpenChange: (open: boolean) => void;
  /** 当前项目 ID */
  projectId: string;
  /** 上传成功回调（可选，父组件用于刷新列表或显示提示） */
  onUploaded?: () => void;
}

/** 允许上传的文件扩展名白名单 */
const ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.pdf'] as const;

/** 文件大小上限：10MB（字节） */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * 把字节数格式化为人类可读的文件大小字符串
 *
 * - 小于 1KB：以 B 为单位
 * - 小于 1MB：以 KB 为单位（保留 1 位小数）
 * - 大于等于 1MB：以 MB 为单位（保留 1 位小数）
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 从文件名中提取扩展名（小写）
 *
 * 如 "doc.md" → ".md"，"archive.tar.gz" → ".gz"，"noext" → ""
 */
function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return '';
  // lastIndexOf 返回 number，slice 后用 toLowerCase 统一比较
  return name.slice(lastDot).toLowerCase();
}

/**
 * 从文件名中去除扩展名作为默认标题
 *
 * 如 "doc.md" → "doc"，"archive.tar.gz" → "archive.tar"
 */
function stripExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return name;
  return name.slice(0, lastDot);
}

/**
 * RAG 文档上传对话框
 *
 * @example
 * <RagUploadDialog
 *   open={uploadOpen}
 *   onOpenChange={setUploadOpen}
 *   projectId={projectId}
 *   onUploaded={() => { /* 父组件可在此刷新列表 *\/ }}
 * />
 */
export function RagUploadDialog({
  open,
  onOpenChange,
  projectId,
  onUploaded,
}: RagUploadDialogProps): ReactElement {
  // 表单状态：标题（必填，最大 200 字符）
  const [title, setTitle] = useState('');
  // 已选文件（null 表示未选）
  const [file, setFile] = useState<File | null>(null);
  // 文件扩展名校验错误（null 表示无错误）
  const [extError, setExtError] = useState<string | null>(null);
  // 文件大小超限警告（null 表示无警告）
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const { mutateAsync, isPending } = useIngestRagDocument();

  // 隐藏的文件输入：通过 ref 触发 click 打开文件选择器
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 重置表单：清空标题、文件、错误、警告 */
  const resetForm = (): void => {
    setTitle('');
    setFile(null);
    setExtError(null);
    setSizeWarning(null);
    // 清空原生 input 的 value，否则连续两次选择同一文件不会触发 onChange
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = '';
    }
  };

  /**
   * 文件选择变化处理
   *
   * 流程：
   * 1. 取出所选文件（单选，取第一个）
   * 2. 校验扩展名是否在白名单内
   * 3. 校验文件大小是否超 10MB
   * 4. 标题为空时自动填充文件名（去掉扩展名）
   */
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const selected = e.target.files?.[0];
    if (selected === undefined) {
      // 用户取消选择，保持原状态
      return;
    }
    const ext = getFileExtension(selected.name);
    // 扩展名校验：不在白名单内则显示错误并清空文件
    if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
      setFile(null);
      setExtError(`不支持的文件类型：${ext || '无扩展名'}，仅支持 .md / .txt / .json / .pdf`);
      setSizeWarning(null);
      return;
    }
    setExtError(null);
    setFile(selected);
    // 文件大小校验：超过 10MB 显示警告（但仍允许选择，提交时会被 disabled 拦截）
    if (selected.size > MAX_FILE_SIZE) {
      setSizeWarning(`文件大小 ${formatFileSize(selected.size)} 超过 10MB 限制，请选择更小的文件`);
    } else {
      setSizeWarning(null);
    }
    // 标题为空时自动填充文件名（去掉扩展名）
    if (title.trim().length === 0) {
      setTitle(stripExtension(selected.name));
    }
  };

  /**
   * 提交表单：根据文件类型分流读取并上传
   *
   * - PDF：readFileAsBase64 → fileContent 为 base64 字符串，mimeType='application/pdf'
   *   主进程会先解码 base64 → 调 pdf-parser 解析为文本，后续走原切片+嵌入流程
   * - 文本类：readFileAsText → fileContent 为原始文本
   *
   * 失败时不关闭对话框，让用户可以重试。
   */
  const handleSubmit = async (): Promise<void> => {
    // 必填校验：标题与文件均不能为空
    if (title.trim().length === 0 || file === null) return;
    // 扩展名错误或文件大小超限时禁止提交
    if (extError !== null || sizeWarning !== null) return;

    try {
      const ext = getFileExtension(file.name);
      // PDF 走 base64 + mimeType 分支；其他走文本分支
      // 注意：即使 file.type 为空（某些系统不识别 PDF MIME），按扩展名判定也能正确路由
      const isPdf = ext === '.pdf';
      const fileContent = isPdf ? await readFileAsBase64(file) : await readFileAsText(file);
      await mutateAsync({
        projectId,
        title: title.trim(),
        fileContent,
        // exactOptionalPropertyTypes 下：mimeType 为可选属性，用条件展开传入
        // PDF：强制传 'application/pdf'（主进程依赖此字段决定是否调 pdf-parser）
        // 文本类：file.type 可能为空（如某些 .md 文件未带 MIME），此时不传 mimeType
        ...(isPdf ? { mimeType: 'application/pdf' as const } : {}),
        ...(!isPdf && file.type.length > 0 ? { mimeType: file.type } : {}),
      });
      // 成功：清空表单 + 关闭对话框 + 调 onUploaded
      resetForm();
      onOpenChange(false);
      if (onUploaded !== undefined) {
        onUploaded();
      }
    } catch (err) {
      // 失败：通过 handleIpcError 显示 toast，不关闭对话框让用户重试
      handleIpcError(err);
    }
  };

  /** 取消按钮：关闭对话框并清空表单 */
  const handleCancel = (): void => {
    if (isPending) return; // 上传中禁止取消
    resetForm();
    onOpenChange(false);
  };

  // 提交按钮 disabled 条件：上传中 / 标题为空 / 无文件 / 扩展名错误 / 文件超限
  const isSubmitDisabled =
    isPending ||
    title.trim().length === 0 ||
    file === null ||
    extError !== null ||
    sizeWarning !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 关闭时同步清空表单（避免下次打开残留）
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          {/* 标题用衬线字体 */}
          <DialogTitle className="font-serif tracking-wide">上传文档</DialogTitle>
          <DialogDescription>
            支持 Markdown / 文本 / JSON / PDF，文件大小不超过 10MB
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {/* 标题输入：必填，最大 200 字符 */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="rag-doc-title" className="font-serif tracking-wide">
              标题 *
            </Label>
            <Input
              id="rag-doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：主角能力体系设定"
              maxLength={200}
              disabled={isPending}
            />
          </div>
          {/* 文件选择：隐藏原生 input + 按钮 + 文件信息展示 */}
          <div className="flex flex-col gap-2">
            <Label className="font-serif tracking-wide">文件 *</Label>
            {/* 隐藏的文件输入：accept 限定为 .md/.txt/.json/.pdf */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.json,.pdf,application/pdf"
              className="hidden"
              onChange={handleFileChange}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending}
              >
                <FileUp className="size-4" strokeWidth={1.5} />
                选择文件
              </Button>
              {/* 已选文件信息：文件名 + 文件大小 */}
              {file !== null && (
                <span className="text-muted-foreground font-mono truncate text-xs tracking-wide">
                  {file.name} · {formatFileSize(file.size)}
                </span>
              )}
            </div>
            {/* 扩展名错误提示：用 text-error 文学风 token */}
            {extError !== null && <p className="text-error text-xs">{extError}</p>}
            {/* 文件大小超限警告：用 text-error 文学风 token */}
            {sizeWarning !== null && <p className="text-error text-xs">{sizeWarning}</p>}
            {/* 通用样式占位：仅在无错误无警告且无文件时显示提示 */}
            {file === null && extError === null && sizeWarning === null && (
              <p className="text-muted-foreground font-serif text-xs">未选择文件</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isPending}>
            取消
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={isSubmitDisabled}
            className={cn(isPending && 'pointer-events-none')}
          >
            {isPending ? '上传中...' : '上传'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

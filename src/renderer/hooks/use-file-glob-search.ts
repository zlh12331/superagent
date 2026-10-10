import { useEffect, useRef, useState } from 'react';

import { buildFileSearchPattern } from '@/lib/file-search';
import { hasIpcBridge, unwrap } from '@/lib/ipc';

/** 空结果常量：稳定引用，使「无结果」时重复置空不触发重渲染 */
const EMPTY_FILES: readonly string[] = [];

/** useFileGlobSearch 入参 */
export interface FileGlobSearchOptions {
  /** 查询词（trim 后为空则不搜索） */
  readonly query: string;
  /** 搜索根目录（null = 无激活会话，不搜索文件） */
  readonly rootDir: string | null;
  /** 是否启用（对话框关闭时置 false，避免后台搜索并清空上次结果） */
  readonly enabled: boolean;
  /** 防抖窗口（ms） */
  readonly debounceMs: number;
  /** 结果上限（传给 search:glob 的 maxResults） */
  readonly maxResults: number;
  /** 失败回调（错误信封 / 异常的统一出口） */
  readonly onError: () => void;
}

/**
 * 防抖文件名搜索
 *
 * @param query - 查询词（trim 后为空则不搜索）
 * @param rootDir - 搜索根目录（null = 无激活会话，不搜索文件）
 * @param enabled - 是否启用（对话框关闭时置 false）
 * @param debounceMs - 防抖窗口（ms）
 * @param maxResults - 结果上限（传给 search:glob 的 maxResults）
 * @param onError - 失败回调（错误信封 / 异常的统一出口）
 * @returns 匹配到的文件绝对路径（保持最近一次成功结果，直到下一次成功或条件失效）
 *
 * @example
 * ```tsx
 * const files = useFileGlobSearch({
 *   query,
 *   rootDir: workingDir,
 *   enabled: open,
 *   debounceMs: 200,
 *   maxResults: 50,
 *   onError: () => toast.error(t('fileTree.fuzzySearch.failed')),
 * });
 * ```
 */
export function useFileGlobSearch({
  query,
  rootDir,
  enabled,
  debounceMs,
  maxResults,
  onError,
}: FileGlobSearchOptions): readonly string[] {
  const [files, setFiles] = useState<readonly string[]>(EMPTY_FILES);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!enabled) {
      setFiles(EMPTY_FILES);
      return;
    }
    const trimmed = query.trim();
    if (trimmed === '' || rootDir === null) {
      setFiles(EMPTY_FILES);
      return;
    }
    if (!hasIpcBridge()) {
      setFiles(EMPTY_FILES);
      return;
    }

    let cancelled = false;
    const handle = setTimeout(() => {
      window.api.search
        .glob({
          pattern: buildFileSearchPattern(trimmed),
          path: rootDir,
          includeHidden: false,
          maxResults,
        })
        .then((response) => {
          if (cancelled) return;
          setFiles([...unwrap(response).files]);
        })
        .catch(() => {
          if (cancelled) return;
          setFiles(EMPTY_FILES);
          onErrorRef.current();
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, rootDir, enabled, debounceMs, maxResults]);

  return files;
}

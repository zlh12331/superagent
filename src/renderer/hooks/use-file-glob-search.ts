// src/renderer/hooks/use-file-glob-search.ts
// 工作区文件名搜索 hook（防抖 + 竞态丢弃 + 失败上抛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - query 变化 → 防抖后调用 search:glob，返回匹配到的文件绝对路径
// - 竞态：查询变化 / 禁用 / 卸载后，旧响应的晚到结果一律丢弃
// - 空查询 / 未启用 / 无根目录 / 浏览器模式（无 window.api）→ 返回空结果且不调 IPC
// - 失败不吞：错误信封与异常统一交给调用方 onError（此前若在此吞掉，
//   用户会把「搜索失败」误读为「无结果」）
//
// 拆分背景（2026-09 file-tree 审计）：此前该逻辑内联在 fuzzy-search-dialog
// 组件里（200ms 防抖 + Promise 竞态 + toast 与渲染、键盘导航同处 414 行）。
// 提到 hook 层后可用 renderHook 精确断言竞态，组件只保留编排与渲染。
//
// 调用关系：
// - 调用方：FuzzySearchDialog
// - 被调方：preload search API（search:glob）、lib/file-search（glob 模式构造）
// ──────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';

import { buildFileSearchPattern } from '@/lib/file-search';
import { unwrap } from '@/lib/ipc';

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

  // 回调经 ref 转发：调用方传入的通常是内联函数（每次渲染都是新引用），
  // 若进依赖数组会让搜索 effect 每渲染重跑一次 —— 防抖窗口被反复重置，
  // 输入过程中永远发不出请求。effect 同步 ref 而非渲染期赋值，避免渲染副作用。
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!enabled) {
      // 关闭时清空：下次打开从空列表起步（不残留上次会话的搜索结果）
      setFiles(EMPTY_FILES);
      return;
    }
    const trimmed = query.trim();
    if (trimmed === '' || rootDir === null) {
      setFiles(EMPTY_FILES);
      return;
    }
    if (typeof window === 'undefined' || window.api === undefined) {
      // 浏览器模式（E2E）无桥：不搜索也不报错
      setFiles(EMPTY_FILES);
      return;
    }

    // 本轮请求令牌：cleanup 置 true 后，旧响应的晚到结果不得写入
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
          // 失败不留陈旧结果（用户看到的是失败提示而非空列表）
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

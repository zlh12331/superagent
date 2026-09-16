// src/renderer/components/chat/use-mention-files.ts
// mention 候选文件搜索 hook（自 ChatInput 提取，2026-09-12）
// ──────────────────────────────────────────────
// 职责：@ 触发后按查询词防抖搜索工作区文件（search.glob），返回候选列表。
// 策略：200ms 防抖（对齐参考项目约定）；触发态离开/工作目录缺失/浏览器模式/
// error 响应/网络异常一律清空候选——面板开着但没有候选即不展示。
//
// 提取动机：ChatInput 是全项目变更频率第二高的文件（90 天 39 次），
// 把带定时器生命周期的副作用收进独立 hook，让组件只剩编排。
// ──────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';

import { buildFileSearchPattern } from '@/lib/file-search';
import { unwrap } from '@/lib/ipc';
import type { SuggestTrigger } from './suggest-trigger';

/** 防抖窗口（ms）——对齐参考项目 useSlashSuggest 的防抖约定 */
const MENTION_DEBOUNCE_MS = 200;
/** 候选上限（对齐原实现：面板一屏可见量） */
const MENTION_MAX_RESULTS = 10;

/**
 * mention 候选文件（@ 触发的文件搜索）
 *
 * @param activeTrigger 当前建议触发态（非 'mention' 时不搜索）
 * @param activeQuery 触发词后的查询串（允许空串 = 列出全部，glob 语义）
 * @param workingDir 工作目录（undefined 时浏览器模式等场景，不搜索）
 * @returns 候选文件相对路径列表（防抖后更新）
 */
export function useMentionFiles(
  activeTrigger: SuggestTrigger | null,
  activeQuery: string | null,
  workingDir: string | undefined,
): readonly string[] {
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 在途请求令牌：查询/依赖变化或卸载后，旧请求的晚到结果不得覆盖新查询结果
  const requestRef = useRef(0);

  useEffect(() => {
    // 本次请求令牌（自增即作废此前在途请求）
    const requestId = ++requestRef.current;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (activeTrigger !== 'mention' || workingDir === undefined) {
      setMentionFiles([]);
      return;
    }
    // 防抖后调 glob（浏览器模式无 window.api 时静默清空）
    timerRef.current = setTimeout(() => {
      if (typeof window === 'undefined' || window.api === undefined) {
        setMentionFiles([]);
        return;
      }
      void window.api.search
        .glob({
          // 复用 lib/file-search 的模式构造（2026-09 审计修复）：
          // 此前直接拼 `**/*${query}*`，用户输入的 glob 元字符（* ? [ ] { } ( ) !）
          // 会被当作模式语法而非字面量——输入 `@a*` 会匹配任意 a 前缀文件，
          // 且带元字符时下游大小写展开也会错位。与 fuzzy-search-dialog 同一真源。
          pattern: buildFileSearchPattern(activeQuery ?? ''),
          path: workingDir,
          includeHidden: false,
          maxResults: MENTION_MAX_RESULTS,
        })
        .then((res) => {
          // 过期响应丢弃（当前令牌已前进）
          if (requestRef.current !== requestId) return;
          try {
            setMentionFiles([...unwrap(res).files]);
          } catch {
            // error 响应：清空候选（与网络异常同策略）
            setMentionFiles([]);
          }
        })
        .catch(() => {
          if (requestRef.current !== requestId) return;
          setMentionFiles([]);
        });
    }, MENTION_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      // 依赖变化/卸载：作废在途响应，避免卸载后 setState
      requestRef.current += 1;
    };
  }, [activeTrigger, activeQuery, workingDir]);

  return mentionFiles;
}

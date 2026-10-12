import { useEffect, useRef, useState } from 'react';

import { buildFileSearchPattern } from '@/lib/file-search';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
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
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (activeTrigger !== 'mention' || workingDir === undefined) {
      setMentionFiles([]);
      return;
    }
    timerRef.current = setTimeout(() => {
      if (!hasIpcBridge()) {
        setMentionFiles([]);
        return;
      }
      void window.api.search
        .glob({
          pattern: buildFileSearchPattern(activeQuery ?? ''),
          path: workingDir,
          includeHidden: false,
          maxResults: MENTION_MAX_RESULTS,
        })
        .then((res) => {
          if (requestRef.current !== requestId) return;
          try {
            setMentionFiles([...unwrap(res).files]);
          } catch {
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
      requestRef.current += 1;
    };
  }, [activeTrigger, activeQuery, workingDir]);

  return mentionFiles;
}

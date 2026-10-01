// src/renderer/hooks/use-working-dir.test.tsx
// 会话工作目录 hook 行为测试：索引派生 + knownDir 优先 + 激活会话解析

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActiveWorkingDir, useWorkingDir, useWorkingDirIndex } from './use-working-dir';

const mockUseSessionsFlat = vi.hoisted(() => vi.fn());
vi.mock('./use-sessions', () => ({
  useSessionsFlat: () => mockUseSessionsFlat(),
}));

const mockActiveSessionId = vi.hoisted(() => vi.fn());
vi.mock('@/stores/persistent/sessions-store', () => ({
  useActiveSessionStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId: mockActiveSessionId() }),
}));

function sessionsFlat(sessions: readonly { id: string; workingDir: string }[]): {
  data: readonly { id: string; workingDir: string }[];
} {
  return { data: sessions };
}

describe('use-working-dir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useWorkingDirIndex', () => {
    it('平铺会话数组建立 id → workingDir 索引', () => {
      mockUseSessionsFlat.mockReturnValue({
        data: [
          { id: 's1', workingDir: '/a' },
          { id: 's2', workingDir: '/b' },
        ],
      });
      const { result } = renderHook(() => useWorkingDirIndex());
      expect(result.current.get('s1')).toBe('/a');
      expect(result.current.get('s2')).toBe('/b');
      expect(result.current.size).toBe(2);
    });

    it('查询未就绪（data undefined）→ 空索引', () => {
      mockUseSessionsFlat.mockReturnValue({ data: undefined });
      const { result } = renderHook(() => useWorkingDirIndex());
      expect(result.current.size).toBe(0);
    });
  });

  describe('useWorkingDir', () => {
    it('knownDir 优先于索引', () => {
      mockUseSessionsFlat.mockReturnValue(sessionsFlat([{ id: 's1', workingDir: '/a' }]));
      const { result } = renderHook(() => useWorkingDir('s1', '/authoritative'));
      expect(result.current).toBe('/authoritative');
    });

    it('无 knownDir → 从索引取', () => {
      mockUseSessionsFlat.mockReturnValue(sessionsFlat([{ id: 's1', workingDir: '/a' }]));
      const { result } = renderHook(() => useWorkingDir('s1'));
      expect(result.current).toBe('/a');
    });

    it('sessionId 为 null / 未知 → null', () => {
      mockUseSessionsFlat.mockReturnValue(sessionsFlat([{ id: 's1', workingDir: '/a' }]));
      const { result: r1 } = renderHook(() => useWorkingDir(null));
      expect(r1.current).toBeNull();
      const { result: r2 } = renderHook(() => useWorkingDir('s9'));
      expect(r2.current).toBeNull();
    });
  });

  describe('useActiveWorkingDir', () => {
    it('激活会话有目录 → 返回目录', () => {
      mockActiveSessionId.mockReturnValue('s1');
      mockUseSessionsFlat.mockReturnValue(sessionsFlat([{ id: 's1', workingDir: '/a' }]));
      const { result } = renderHook(() => useActiveWorkingDir());
      expect(result.current).toBe('/a');
    });

    it('无激活会话 → null', () => {
      mockActiveSessionId.mockReturnValue(null);
      mockUseSessionsFlat.mockReturnValue({ data: undefined });
      const { result } = renderHook(() => useActiveWorkingDir());
      expect(result.current).toBeNull();
    });
  });
});

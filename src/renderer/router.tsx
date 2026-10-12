import { createHashRouter } from 'react-router';
import {
  fetchSessionTurns,
  prefetchTurnPages,
  SESSION_TURNS_QUERY_KEY,
} from '@/hooks/use-session-turns';
import { fetchSessionDetail, SESSION_DETAIL_DATA_KEY } from '@/hooks/use-sessions';
import { ROUTES } from '@/lib/constants';
import { queryClient } from '@/lib/query/query-client';
import { RootErrorBoundary, RootHydrateFallback, RootLayout } from './routes/root';

/**
 * 应用路由配置
 *
 * 使用 RR8 Data Mode：createHashRouter + RouterProvider。
 * hash 路由原因：生产构建以 file:// 加载（Electron loadFile），history 路由
 * 在 file:// 下 pathname 为文件路径导致全部路由 404（真实缺陷，2026-08-11
 * 由生产启动基准暴露）；hash 路由在 dev（http）与生产（file）均正常工作。
 *
 * 代码分割：HomePage / ChatPage 使用 route.lazy 按需加载，
 * 首屏 bundle 不再包含 shiki / diff-viewer / virtuoso 等重型依赖；
 * 加载期间由 root 路由的 HydrateFallback 提供占位。
 */
export const router = createHashRouter([
  {
    path: ROUTES.home,
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    // biome-ignore lint/style/useNamingConvention: React Router 8 路由 API 要求 PascalCase 属性名
    HydrateFallback: RootHydrateFallback,
    children: [
      {
        index: true,
        lazy: async () => {
          const { HomePage } = await import('./routes/home');
          // biome-ignore lint/style/useNamingConvention: React Router lazy 要求模块导出 Component
          return { Component: HomePage };
        },
      },
      {
        path: ROUTES.chat,
        loader: ({ params }) => {
          const sessionId = params['sessionId'];
          if (sessionId !== undefined) {
            void queryClient
              .ensureQueryData({
                queryKey: SESSION_DETAIL_DATA_KEY(sessionId, false),
                queryFn: () => fetchSessionDetail(sessionId, false),
              })
              .catch(() => undefined);
            void (async () => {
              const turns = await queryClient
                .ensureQueryData({
                  queryKey: SESSION_TURNS_QUERY_KEY(sessionId),
                  queryFn: () => fetchSessionTurns(sessionId),
                })
                .catch(() => undefined);
              if (turns === undefined) return;
              await prefetchTurnPages(sessionId, turns.turns).catch(() => undefined);
            })();
          }
          return null;
        },
        lazy: async () => {
          const { ChatPage } = await import('./routes/chat');
          // biome-ignore lint/style/useNamingConvention: React Router lazy 要求模块导出 Component
          return { Component: ChatPage };
        },
      },
    ],
  },
]);

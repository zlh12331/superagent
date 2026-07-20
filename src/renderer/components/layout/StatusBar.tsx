// src/renderer/components/layout/StatusBar.tsx
// 底部状态栏 · 极简文学风（28px 高）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景（与 Topbar 同色，形成上下视觉框）
// - 状态指示器三色：success(墨绿) / warning(琥珀) / error(朱砂)
// - 数字部分使用等宽字体（呼应"墨水计数"感）
// - 图标统一 strokeWidth=1.5，size-3
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 显示 PG 子进程状态（starting/running/stopped/crashed/restarting/dead）
// - 显示 Ollama 服务状态（starting/running/stopped/not_installed）
// - 显示 DB 连接状态（已连接/未连接）
// - Ollama 模型拉取进度条（仅当 pullProgress 非 null 时显示）
//
// 通过 useAppStatusStore 选择性订阅各字段，单字段变更仅触发相关重渲染。
// 状态图标使用 lucide-react：
// - Circle (stopped) / Loader2 (starting/restarting) / CircleCheck (running)
// - CircleAlert (crashed/dead/not_installed)
// - dead 使用 OctagonAlert（表示不可恢复）
//
// 注意：PG/Ollama 状态键来自 IPC payload 类型（包含 'not_installed' snake_case），
// 使用 switch case 而非对象字面量映射，避免 biome useNamingConvention 对
// snake_case 键报错。

import { Circle, CircleAlert, CircleCheck, Loader2, OctagonAlert } from 'lucide-react';
import type { ReactElement } from 'react';

import { STATUS_BAR_HEIGHT } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useAppStatusStore } from '@/stores/app-status.store';

/** 单个状态对应的展示信息（颜色 token + 图标 + 中文标签） */
interface StatusMeta {
  /** 中文标签 */
  label: string;
  /** 图标元素 */
  icon: ReactElement;
  /**
   * Tailwind 颜色类（基于设计 token：success/warning/error/muted-foreground）
   * 用于图标与文字着色
   */
  dot: string;
}

/** 根据 PG 状态返回展示信息（PgSupervisor 增补 'restarting' / 'dead' 状态） */
function getPgMeta(
  status: 'starting' | 'running' | 'stopped' | 'crashed' | 'restarting' | 'dead',
): StatusMeta {
  switch (status) {
    case 'starting': {
      return {
        label: 'PG 启动中',
        icon: <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />,
        dot: 'text-warning',
      };
    }
    case 'restarting': {
      // PgSupervisor 自动重启中（指数退避 5s/10s/30s 后重试）
      return {
        label: 'PG 重启中',
        icon: <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />,
        dot: 'text-warning',
      };
    }
    case 'running': {
      return {
        label: 'PG 运行中',
        icon: <CircleCheck className="size-3" strokeWidth={1.5} />,
        dot: 'text-success',
      };
    }
    case 'stopped': {
      return {
        label: 'PG 已停止',
        icon: <Circle className="size-3" strokeWidth={1.5} />,
        dot: 'text-muted-foreground',
      };
    }
    case 'crashed': {
      return {
        label: 'PG 崩溃',
        icon: <CircleAlert className="size-3" strokeWidth={1.5} />,
        dot: 'text-error',
      };
    }
    case 'dead': {
      // PgSupervisor 重启 3 次均失败，进入不可恢复状态
      return {
        label: 'PG 不可用',
        icon: <OctagonAlert className="size-3" strokeWidth={1.5} />,
        dot: 'text-error',
      };
    }
  }
}

/** 根据 Ollama 状态返回展示信息 */
function getOllamaMeta(status: 'starting' | 'running' | 'stopped' | 'not_installed'): StatusMeta {
  switch (status) {
    case 'starting': {
      return {
        label: 'Ollama 启动中',
        icon: <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />,
        dot: 'text-warning',
      };
    }
    case 'running': {
      return {
        label: 'Ollama 运行中',
        icon: <CircleCheck className="size-3" strokeWidth={1.5} />,
        dot: 'text-success',
      };
    }
    case 'stopped': {
      return {
        label: 'Ollama 已停止',
        icon: <Circle className="size-3" strokeWidth={1.5} />,
        dot: 'text-muted-foreground',
      };
    }
    case 'not_installed': {
      return {
        label: 'Ollama 未安装',
        icon: <CircleAlert className="size-3" strokeWidth={1.5} />,
        dot: 'text-warning',
      };
    }
  }
}

/**
 * 底部状态栏组件
 *
 * 高度固定 STATUS_BAR_HEIGHT（28px），左侧展示 PG/Ollama 状态，
 * 右侧展示 DB 连接状态与 Ollama 模型拉取进度。
 *
 * 订阅 useAppStatusStore 各字段，单字段变更仅触发相关重渲染。
 * 暖米色背景与 Topbar 形成上下视觉框，主内容区"夹"在中间。
 */
export function StatusBar(): ReactElement {
  const pgStatus = useAppStatusStore((s) => s.pgStatus);
  const ollamaStatus = useAppStatusStore((s) => s.ollamaStatus);
  const dbConnected = useAppStatusStore((s) => s.dbConnected);
  const pullProgress = useAppStatusStore((s) => s.pullProgress);

  const pg = getPgMeta(pgStatus);
  const ollama = getOllamaMeta(ollamaStatus);

  return (
    <footer
      className="bg-sidebar text-muted-foreground border-sidebar-border flex items-center justify-between border-t px-3 text-xs"
      style={{ height: STATUS_BAR_HEIGHT }}
    >
      <div className="flex items-center gap-4">
        <span className={cn('flex items-center gap-1.5', pg.dot)}>
          {pg.icon}
          <span className="font-sans tracking-wide">{pg.label}</span>
        </span>
        <span className={cn('flex items-center gap-1.5', ollama.dot)}>
          {ollama.icon}
          <span className="font-sans tracking-wide">{ollama.label}</span>
        </span>
      </div>
      <div className="flex items-center gap-4">
        {pullProgress !== null && (
          <span className="flex items-center gap-1.5">
            <span className="font-sans tracking-wide">拉取 {pullProgress.model}</span>
            <span className="text-foreground/70 font-mono">{pullProgress.percent.toFixed(0)}%</span>
          </span>
        )}
        <span
          className={cn(
            'flex items-center gap-1.5 font-sans tracking-wide',
            dbConnected ? 'text-success' : 'text-muted-foreground',
          )}
        >
          {dbConnected ? 'DB 已连接' : 'DB 未连接'}
        </span>
      </div>
    </footer>
  );
}

// src/renderer/components/settings/sections/about-section.tsx
// 关于 pane（2026-09-04 重设计 v2：品牌展示为主 + 诊断增强；v3：去边框纸感）
// ──────────────────────────────────────────────────────────────
// 板块：
// - 品牌 Hero（居中视觉中心）：大标识/产品名/标语/版本 + 渠道 + 更新区
// - 构建信息：渠道/构建时间/提交（app:getInfo 扩展自 build-info.json）
// - 环境信息：Electron/Node/Chromium/平台/架构/数据目录（平铺保留）
// - 诊断与支持：复制诊断信息（新增）/打开数据目录/导出诊断包
// - 更新状态：失败时展示完整错误信息 + 重试 + 打开数据目录
// - 许可与致谢：MIT 许可证 + 开源依赖致谢（文本，不伪造外链）
//
// 视觉（v3）：信息行去边框卡片（原 SettingRow 形态），改为无边框
// label-值 左右行，纸感极简；顶部不再显示「关于」标题（导航已标识）
// ──────────────────────────────────────────────────────────────

import type { AppInfoRes, ExportDiagnosticsRes, UpdatePhase } from '@code-agent/shared/renderer';
import { Clipboard, FolderOpen, Loader2, PackageCheck, RefreshCw, Rocket } from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useUpdate } from '@/hooks/use-update';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { SectionTitle } from '../settings-controls';

/** 无边框信息行（label 左 + 值右，纸感极简布局；替代 SettingRow 的卡片+边框形态） */
function InfoRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-foreground shrink-0 text-sm">{label}</span>
      <div className="min-w-0 shrink text-xs">{children}</div>
    </div>
  );
}

/** 格式化构建时间为本地可读时间（解析失败返回原文） */
function formatBuildTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * 拼接诊断信息为纯文本（VS Code About「复制」同款，报 bug/提 issue 时整段粘贴）
 * 只包含 app:getInfo 已提供的真实字段，不虚构任何数据
 */
function formatDiagnostics(info: AppInfoRes): string {
  return [
    `Code Agent Desktop ${info.version}`,
    `Channel   : ${info.channel ?? '-'}`,
    `Electron  : ${info.electron}`,
    `Node.js   : ${info.node}`,
    `Chromium  : ${info.chrome}`,
    `Platform  : ${info.platform} ${info.arch}`,
    `Build time: ${info.buildTime === undefined ? '-' : formatBuildTime(info.buildTime)}`,
    `Commit    : ${info.commitSha ?? '-'}`,
    `User data : ${info.userDataPath}`,
  ].join('\n');
}

/**
 * 关于 pane（品牌 Hero + 分组卡片）
 */
export function AboutSection(): ReactElement {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfoRes | null>(null);
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 更新状态（订阅主进程 update:event:status；全局 UpdateNotice 与这里共享事件流）
  const { state: updateState, check, install } = useUpdate();

  // app:getInfo：应用版本/环境/构建信息（浏览器模式兜底占位）
  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || window.api === undefined) {
      setInfo({
        version: 'dev',
        electron: '-',
        node: '-',
        chrome: '-',
        platform: 'browser',
        arch: '-',
        userDataPath: '-',
        channel: 'dev',
      });
      return;
    }
    window.api.app
      .getInfo()
      .then((res) => {
        if (!cancelled) {
          setInfo(unwrap<AppInfoRes>(res));
        }
      })
      .catch(() => {
        toast.error(t('settings.aboutLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** 复制文本到剪贴板（构建信息/提交哈希） */
  const copyText = async (text: string): Promise<void> => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      return;
    }
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('settings.aboutCopied'));
    } catch {
      // 写入失败（无焦点/权限拒绝）：给反馈而非静默，避免"点了没反应"
      toast.error(t('common.copyFailed'));
    }
    // finally 语义（React Compiler 不优化 try/finally）：成功/失败统一在此复位
    setCopying(false);
  };

  /** 导出诊断包（构建/日志/系统信息，上传给支持定位问题的标准途径） */
  const handleExportDiagnostics = async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    setExporting(true);
    try {
      const res = unwrap<ExportDiagnosticsRes>(await window.api.app.exportDiagnostics());
      if (res.saved && res.path !== undefined) {
        toast.success(t('settings.aboutExportSuccess', { path: res.path }));
      } else {
        toast.error(t('settings.aboutExportFailed'));
      }
    } catch {
      toast.error(t('settings.aboutExportFailed'));
    }
    // finally 语义（React Compiler 不优化 try/finally）：成功/失败统一在此复位
    setExporting(false);
  };

  const handleOpenDataDir = (): void => {
    if (typeof window === 'undefined' || window.api === undefined) {
      return;
    }
    void window.api.app.openDataDir();
  };

  // 更新区渲染（按阶段切换按钮/状态）
  const phase: UpdatePhase | undefined = updateState?.phase;
  const updateBlock = (
    <div className="flex items-center gap-2">
      {phase === undefined ? (
        <Button variant="outline" size="sm" onClick={() => void check()}>
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutCheckUpdate')}
        </Button>
      ) : phase === 'checking' || phase === 'downloading' ? (
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          {t('settings.aboutChecking')}
        </Button>
      ) : phase === 'not-available' ? (
        <span className="text-success-text inline-flex items-center gap-1 text-xs">
          <PackageCheck className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutUpToDate')}
        </span>
      ) : phase === 'available' ? (
        <span className="text-accent-text inline-flex items-center gap-1 text-xs">
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutUpdateAvailable')}
          {' · '}
          {t('settings.aboutUpdateVersion', { version: updateState?.version ?? '' })}
        </span>
      ) : phase === 'downloaded' ? (
        <>
          <span className="text-accent-text inline-flex items-center gap-1 text-xs">
            <PackageCheck className="size-3.5" strokeWidth={1.5} />
            {t('settings.aboutUpdateReady')}
          </span>
          <Button size="sm" variant="outline" onClick={install}>
            {t('settings.aboutInstallRestart')}
          </Button>
        </>
      ) : (
        // error：展示完整错误信息（来自主进程 UpdateStatusPayload.message）+
        // 重试 + 打开数据目录（更新日志/缓存位于 userData 下，供排查）
        <div className="flex w-full flex-col items-start gap-2">
          <span className="text-error-text text-xs leading-[1.5]">
            {updateState?.message !== undefined && updateState.message !== ''
              ? updateState.message
              : t('settings.aboutUpdateNotAvailable')}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void check()}>
              <RefreshCw className="size-3.5" strokeWidth={1.5} />
              {t('settings.aboutCheckUpdate')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleOpenDataDir}>
              <FolderOpen className="size-3.5" strokeWidth={1.5} />
              {t('settings.aboutOpenDataDir')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const channel = info?.channel;
  const channelBadge =
    channel === undefined ? null : (
      <span
        className={cn(
          'rounded-full px-1.5 py-0.5 font-mono text-[10px]',
          channel === 'stable' && 'bg-accent/10 text-accent-text',
          channel === 'beta' && 'bg-accent-2/10 text-accent-text',
          channel === 'dev' && 'bg-muted text-muted-foreground',
        )}
      >
        {channel}
      </span>
    );

  return (
    <div className="flex flex-col gap-3">
      {/* 品牌 Hero：居中视觉中心——大标识 + 渐变光晕 + 版本/渠道 + 更新 */}
      <Card className="relative overflow-hidden px-4 py-8">
        {/* 装饰光晕（top 覆盖，配合圆角溢出隐藏） */}
        <div
          aria-hidden
          className="bg-primary/10 pointer-events-none absolute -top-12 left-1/2 h-36 w-72 -translate-x-1/2 rounded-full blur-2xl"
        />
        <div className="relative flex flex-col items-center text-center">
          <div className="bg-primary/10 text-primary flex size-14 items-center justify-center rounded-xl">
            <Rocket className="size-7" strokeWidth={1.25} />
          </div>
          <div className="text-foreground mt-3.5 text-lg leading-tight font-semibold tracking-wide">
            Code Agent Desktop
          </div>
          <div className="text-muted-foreground mt-1 text-xs">{t('settings.aboutTagline')}</div>
          <div className="mt-3.5 flex items-center gap-1.5">
            <span className="bg-muted text-foreground inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-xs">
              {info === null ? '…' : `v${info.version}`}
            </span>
            {channelBadge}
          </div>
          <div className="mt-4 flex w-full justify-center">{updateBlock}</div>
        </div>
      </Card>

      {/* 构建信息 */}
      <SectionTitle>{t('settings.aboutBuildTitle')}</SectionTitle>
      <Card className="flex flex-col">
        <InfoRow label={t('settings.aboutBuildChannel')}>
          <span className="text-muted-foreground font-mono">{channel ?? '-'}</span>
        </InfoRow>
        <InfoRow label={t('settings.aboutBuildTime')}>
          <span className="text-muted-foreground font-mono">
            {info?.buildTime === undefined ? '-' : formatBuildTime(info.buildTime)}
          </span>
        </InfoRow>
        <InfoRow label={t('settings.aboutBuildCommit')}>
          {info?.commitSha !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-auto gap-1 rounded px-0 font-mono"
              aria-label={t('settings.aboutCopy')}
              title={t('settings.aboutCopy')}
              onClick={() => void copyText(info.commitSha ?? '')}
            >
              {info.commitSha}
              {copying ? (
                <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              ) : (
                <Clipboard className="size-3" strokeWidth={1.5} />
              )}
            </Button>
          ) : (
            <span className="text-muted-foreground font-mono">-</span>
          )}
        </InfoRow>
      </Card>

      {/* 环境信息 */}
      <SectionTitle>{t('settings.aboutRuntime')}</SectionTitle>
      <Card className="flex flex-col">
        <InfoRow label="Electron">
          <span className="text-muted-foreground font-mono">{info?.electron ?? '…'}</span>
        </InfoRow>
        <InfoRow label="Node.js">
          <span className="text-muted-foreground font-mono">{info?.node ?? '…'}</span>
        </InfoRow>
        <InfoRow label="Chromium">
          <span className="text-muted-foreground font-mono">{info?.chrome ?? '…'}</span>
        </InfoRow>
        <InfoRow label={t('settings.aboutPlatform')}>
          <span className="text-muted-foreground font-mono">
            {info === null ? '…' : `${info.platform} ${info.arch}`}
          </span>
        </InfoRow>
        <InfoRow label={t('settings.aboutUserData')}>
          <span
            className="text-muted-foreground inline-block max-w-[220px] truncate align-bottom font-mono"
            title={info?.userDataPath}
          >
            {info?.userDataPath ?? '…'}
          </span>
        </InfoRow>
      </Card>

      {/* 诊断与支持 */}
      <SectionTitle>{t('settings.aboutDiagnosticsTitle')}</SectionTitle>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (info !== null) {
                void copyText(formatDiagnostics(info));
              }
            }}
            disabled={copying || info === null}
          >
            {copying ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <Clipboard className="size-3.5" strokeWidth={1.5} />
            )}
            {t('settings.aboutCopyDiagnostics')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenDataDir}
            disabled={typeof window === 'undefined' || window.api === undefined}
          >
            <FolderOpen className="size-3.5" strokeWidth={1.5} />
            {t('settings.aboutOpenDataDir')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportDiagnostics()}
            disabled={exporting || typeof window === 'undefined' || window.api === undefined}
          >
            {exporting ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <PackageCheck className="size-3.5" strokeWidth={1.5} />
            )}
            {t('settings.aboutExportDiagnostics')}
          </Button>
        </div>
      </Card>

      {/* 许可与致谢 */}
      <SectionTitle>{t('settings.aboutLegalTitle')}</SectionTitle>
      <Card className="flex flex-col">
        <InfoRow label="License">
          <span className="text-muted-foreground font-mono">{t('settings.aboutLicenseValue')}</span>
        </InfoRow>
      </Card>
      <p className="text-muted-foreground px-1.5 text-2xs">{t('settings.aboutThanks')}</p>
    </div>
  );
}

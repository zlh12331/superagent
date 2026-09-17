// src/renderer/components/settings/sections/about-section.tsx
// 关于 pane（2026-09-04 重设计 v2：品牌展示为主 + 诊断增强；v3：去边框纸感）
// ──────────────────────────────────────────────────────────────
// 板块：
// - 品牌 Hero（居中视觉中心）：大标识/产品名/标语/版本 + 渠道 + 更新区
// - 构建信息：渠道/构建时间/提交（app:getInfo 扩展自 build-info.json）
// - 环境信息：Electron/Node/Chromium/平台/架构/数据目录（平铺保留）
// - 诊断与支持：复制诊断信息 / 打开数据目录 / 导出诊断包
// - 更新状态：按 UpdatePhase 分派（失败时展示完整错误 + 重试 + 打开数据目录）
// - 许可与致谢：MIT 许可证 + 开源依赖致谢（文本，不伪造外链）
//
// 视觉（v3）：信息行去边框卡片（原 SettingRow 形态），改为无边框
// label-值 左右行，纸感极简；顶部不再显示「关于」标题（导航已标识）
//
// 结构（2026-09 审计）：原 AboutSection 单函数认知复杂度 43（阈值 15），
// 因内联 7 段嵌套三元（更新区）+ 三段渠道条件类 + 两个 try/catch 副作用。
// 现拆为：UpdateBlock（早返回分派）/ ChannelBadge（表驱动）/ 三个模块级
// 副作用函数（copyToClipboard / exportDiagnostics / openDataDir）。
// ──────────────────────────────────────────────────────────────

import type {
  AppInfoRes,
  ExportDiagnosticsRes,
  UpdateStatusPayload,
} from '@code-agent/shared/renderer';
import { Clipboard, FolderOpen, Loader2, PackageCheck, RefreshCw, Rocket } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAppInfo } from '@/hooks/use-app-info';
import { useUpdate } from '@/hooks/use-update';
import { useTranslation } from '@/i18n/use-translation';
import { reportError } from '@/lib/error-report';
import { formatDateTime } from '@/lib/format-intl';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { SectionTitle } from '../settings-controls';

/** i18n 文案函数类型（本项目 react-i18next 未导出 TFunction，由 hook 推导） */
type TranslateFn = ReturnType<typeof useTranslation>['t'];

// ── 纯展示子组件 ──────────────────────────────────────────────

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

/**
 * 渠道徽章（stable / beta / dev 三色）
 *
 * 表驱动：此前内联的三段 `channel === 'x' && 'class'` 条件类曾是 AboutSection
 * 复杂度的一部分；映射表让「渠道 → 配色」成为数据而非分支。
 * 未收录渠道回退中性色（新增渠道不会掉样式）。
 */
const CHANNEL_CLASSES: Readonly<Record<string, string>> = {
  stable: 'bg-accent/10 text-accent-text',
  beta: 'bg-accent-2/10 text-accent-text',
  dev: 'bg-muted text-muted-foreground',
};

function ChannelBadge({ channel }: { readonly channel: string }): ReactElement {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 font-mono text-[10px]',
        CHANNEL_CLASSES[channel] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {channel}
    </span>
  );
}

/** 更新区 props */
interface UpdateBlockProps {
  readonly state: UpdateStatusPayload | null;
  readonly onCheck: () => void;
  readonly onInstall: () => void;
  readonly onOpenDataDir: () => void;
}

/**
 * 更新状态区（按 UpdatePhase 分派）
 *
 * 抽离动机（2026-09 审计）：此前是内联在 AboutSection 里的 **7 段嵌套三元链**
 * （undefined / checking+downloading / not-available / available / downloaded /
 * error），使 AboutSection 认知复杂度达 43（阈值 15）。改为早返回的分派组件后，
 * 每个阶段是独立直线分支，主组件只负责组装。
 */
function UpdateBlock({ state, onCheck, onInstall, onOpenDataDir }: UpdateBlockProps): ReactElement {
  const { t } = useTranslation();
  const phase = state?.phase;

  // 空闲：还没查过
  if (phase === undefined) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCheck}>
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutCheckUpdate')}
        </Button>
      </div>
    );
  }

  // 进行中（检查 / 下载共用同一视觉）
  if (phase === 'checking' || phase === 'downloading') {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          {t('settings.aboutChecking')}
        </Button>
      </div>
    );
  }

  if (phase === 'not-available') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-success-text inline-flex items-center gap-1 text-xs">
          <PackageCheck className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutUpToDate')}
        </span>
      </div>
    );
  }

  if (phase === 'available') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-accent-text inline-flex items-center gap-1 text-xs">
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutUpdateAvailable')}
          {' · '}
          {t('settings.aboutUpdateVersion', { version: state?.version ?? '' })}
        </span>
      </div>
    );
  }

  if (phase === 'downloaded') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-accent-text inline-flex items-center gap-1 text-xs">
          <PackageCheck className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutUpdateReady')}
        </span>
        <Button size="sm" variant="outline" onClick={onInstall}>
          {t('settings.aboutInstallRestart')}
        </Button>
      </div>
    );
  }

  // 其余（error）：完整错误信息（主进程 UpdateStatusPayload.message）+ 重试 +
  // 打开数据目录（更新日志/缓存位于 userData 下，供排查）
  const detail =
    state?.message !== undefined && state.message !== ''
      ? state.message
      : t('settings.aboutUpdateNotAvailable');
  return (
    <div className="flex w-full flex-col items-start gap-2">
      <span className="text-error-text text-xs leading-[1.5]">{detail}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCheck}>
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutCheckUpdate')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenDataDir}>
          <FolderOpen className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutOpenDataDir')}
        </Button>
      </div>
    </div>
  );
}

/**
 * 诊断与支持卡片（复制诊断信息 / 打开数据目录 / 导出诊断包）
 *
 * 抽离动机：这三颗按钮的条件（在途态禁用、无桥禁用、info 为空时禁用复制）
 * 曾是 AboutSection 复杂度的一部分；独立后主组件不再承载这些分支。
 */
function DiagnosticsCard({
  info,
  locale,
  copying,
  exporting,
  onCopy,
  onExport,
}: {
  readonly info: AppInfoRes | null;
  readonly locale: string;
  readonly copying: boolean;
  readonly exporting: boolean;
  readonly onCopy: (text: string) => void;
  readonly onExport: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const bridgeReady = hasIpcBridge();
  // 无 info（未加载/加载失败）时无法拼诊断文本
  const copyDisabled = copying || info === null;

  const handleCopyDiagnostics = (): void => {
    if (info === null) return;
    onCopy(formatDiagnostics(info, locale));
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleCopyDiagnostics} disabled={copyDisabled}>
          {copying ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <Clipboard className="size-3.5" strokeWidth={1.5} />
          )}
          {t('settings.aboutCopyDiagnostics')}
        </Button>
        <Button variant="outline" size="sm" onClick={openDataDir} disabled={!bridgeReady}>
          <FolderOpen className="size-3.5" strokeWidth={1.5} />
          {t('settings.aboutOpenDataDir')}
        </Button>
        <Button variant="outline" size="sm" onClick={onExport} disabled={exporting || !bridgeReady}>
          {exporting ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          ) : (
            <PackageCheck className="size-3.5" strokeWidth={1.5} />
          )}
          {t('settings.aboutExportDiagnostics')}
        </Button>
      </div>
    </Card>
  );
}

// ── 格式化与副作用（模块级：保持组件函数体精简） ──────────────

/** 格式化构建时间为本地可读时间（跟随 locale；解析失败返回原文） */
function formatBuildTime(iso: string, locale: string): string {
  return formatDateTime(iso, locale, iso);
}

/**
 * 拼接诊断信息为纯文本（VS Code About「复制」同款，报 bug/提 issue 时整段粘贴）
 * 只包含 app:getInfo 已提供的真实字段，不虚构任何数据
 */
function formatDiagnostics(info: AppInfoRes, locale: string): string {
  return [
    `Code Agent Desktop ${info.version}`,
    `Channel   : ${info.channel ?? '-'}`,
    `Electron  : ${info.electron}`,
    `Node.js   : ${info.node}`,
    `Chromium  : ${info.chrome}`,
    `Platform  : ${info.platform} ${info.arch}`,
    `Build time: ${info.buildTime === undefined ? '-' : formatBuildTime(info.buildTime, locale)}`,
    `Commit    : ${info.commitSha ?? '-'}`,
    `User data : ${info.userDataPath}`,
  ].join('\n');
}

/** 复制文本到剪贴板（无剪贴板 API 时静默；失败给反馈而非"点了没反应"） */
async function copyToClipboard(text: string, t: TranslateFn): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t('settings.aboutCopied'));
  } catch {
    toast.error(t('common.copyFailed'));
  }
}

/** 导出诊断包（构建/日志/系统信息，上传给支持定位问题的标准途径） */
async function exportDiagnostics(t: TranslateFn): Promise<void> {
  if (!hasIpcBridge()) return;
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
}

/** 打开数据目录（userData；无桥时 no-op——按钮已按 hasIpcBridge 禁用） */
function openDataDir(): void {
  if (!hasIpcBridge()) return;
  void window.api.app.openDataDir();
}

// ── 主组件 ────────────────────────────────────────────────────

/**
 * 关于 pane（品牌 Hero + 分组卡片）
 */
export function AboutSection(): ReactElement {
  const { t, i18n } = useTranslation();
  // app:getInfo 统一入口（与 Topbar / 侧栏账户菜单共享同一 hook，单一真源）。
  // 失败经 onError 提示：hook 内返回 null 由下方渲染占位，错误细节由此 toast 告知。
  const info = useAppInfo((error: unknown) => {
    reportError(error, { tags: { scope: 'about-section.getInfo' } });
    toast.error(t('settings.aboutLoadFailed'));
  });
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 更新状态（订阅主进程 update:event:status；全局 UpdateNotice 与这里共享事件流）
  const { state: updateState, check, install } = useUpdate();

  /** 复制文本到剪贴板（含在途态复位） */
  const copyText = async (text: string): Promise<void> => {
    setCopying(true);
    await copyToClipboard(text, t);
    // finally 语义（React Compiler 不优化 try/finally）：在各分支后统一复位
    setCopying(false);
  };

  /** 导出诊断包（含在途态复位） */
  const handleExportDiagnostics = async (): Promise<void> => {
    setExporting(true);
    await exportDiagnostics(t);
    setExporting(false);
  };

  const channel = info?.channel;

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
            {channel !== undefined && <ChannelBadge channel={channel} />}
          </div>
          {/* 更新区（按阶段分派，实现见 UpdateBlock） */}
          <div className="mt-4 flex w-full justify-center">
            <UpdateBlock
              state={updateState}
              onCheck={() => void check()}
              onInstall={install}
              onOpenDataDir={openDataDir}
            />
          </div>
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
            {info?.buildTime === undefined ? '-' : formatBuildTime(info.buildTime, i18n.language)}
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
      <DiagnosticsCard
        info={info}
        locale={i18n.language}
        copying={copying}
        exporting={exporting}
        onCopy={(text) => void copyText(text)}
        onExport={() => void handleExportDiagnostics()}
      />

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

import type {
  UpdateCheckRes,
  UpdateErrorKind,
  UpdateGetStatusRes,
  UpdateStatusPayload,
} from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import { app, BrowserWindow } from 'electron';
import {
  clearDeferredInstall,
  isDeferredInstallPending,
  requestDeferredInstall,
  setCloseConfirmed,
} from '../../quit-state';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';
import { pruneStaleDifferentialBaseline, resolveUpdaterCacheDir } from './update-cache';

const LAUNCH_CHECK_DELAY_MS = 5_000;

const LAUNCH_CHECK_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

const LONG_SESSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const CHECK_TIMEOUT_MS = 45_000;

export interface UpdateProgressInfo {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

export interface CancellationTokenLike {
  cancel(): void;
  readonly cancelled: boolean;
}

export interface UpdaterLoggerLike {
  info(message?: unknown, ...params: unknown[]): void;
  warn(message?: unknown, ...params: unknown[]): void;
  error(message?: unknown, ...params: unknown[]): void;
  debug?(message?: unknown, ...params: unknown[]): void;
}

type CheckTimerKind = 'launch' | 'retry' | 'long-session';

export interface UpdateStartOptions {
  readonly autoCheckEnabled?: () => boolean;
  readonly allowPrereleaseEnabled?: () => boolean;
  readonly devUpdateEnabled?: boolean;
}

export interface AutoUpdaterLike {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(cancellationToken?: CancellationTokenLike): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: UpdaterLoggerLike | null;
  forceDevUpdateConfig: boolean;
  on(event: 'checking-for-update', listener: () => void): void;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): void;
  on(event: 'update-not-available', listener: () => void): void;
  on(event: 'download-progress', listener: (progress: UpdateProgressInfo) => void): void;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): void;
  on(event: 'update-cancelled', listener: (info: UpdateInfoLike) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface UpdateInfoLike {
  readonly version: string;
  readonly releaseNotes?: unknown;
}

// biome-ignore lint/style/useNamingConvention: I 前缀接口遵循项目惯例（IChatService 等）
export interface IUpdateService {
  start(options?: UpdateStartOptions): void;
  check(manual: boolean): Promise<UpdateCheckRes>;
  cancelDownload(): void;
  getStatus(): UpdateGetStatusRes;
  onStatus(listener: (payload: UpdateStatusPayload) => void): () => void;
  quitAndInstall(): void;
  runDeferredInstall(): void;
  refreshAutoInstallOnAppQuit(): void;
  dispose(): void;
}

export class UpdateService implements IUpdateService {
  private snapshot: UpdateStatusPayload | null = null;

  private readonly statusListeners = new Set<(payload: UpdateStatusPayload) => void>();

  private lastCheckAt: number | null = null;

  private pendingVersion: string | null = null;

  private pendingReleaseNotes: string | null = null;

  private cancelToken: CancellationTokenLike | null = null;

  private timer: NodeJS.Timeout | null = null;
  private timerKind: CheckTimerKind | null = null;

  private firedKind: CheckTimerKind | null = null;

  private retryIndex = 0;

  private checkInFlight = false;

  private started = false;

  private devUpdateForced = false;

  private allowPrereleaseEnabled: (() => boolean) | null = null;

  private autoCheckEnabled: (() => boolean) | null = null;

  constructor(
    private readonly updater: AutoUpdaterLike,
    private readonly isPackaged: () => boolean,
    private readonly createCancellationToken: () => CancellationTokenLike,
  ) {}

  start(options: UpdateStartOptions = {}): void {
    this.started = true;
    const autoCheckEnabled = (options.autoCheckEnabled ?? ((): boolean => true))();
    this.devUpdateForced = options.devUpdateEnabled === true;
    this.allowPrereleaseEnabled = options.allowPrereleaseEnabled ?? null;
    this.autoCheckEnabled = options.autoCheckEnabled ?? null;

    this.updater.logger = createUpdaterLogger();
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = autoCheckEnabled;
    this.updater.forceDevUpdateConfig = this.devUpdateForced;

    this.registerListeners();

    if (!this.isPackaged() && !this.devUpdateForced) {
      logger.info({ scope: 'auto-updater' }, '开发模式：跳过启动检查调度（更新仅对打包版生效）');
      return;
    }
    if (!autoCheckEnabled) {
      logger.info({ scope: 'auto-updater' }, '用户已关闭自动检查更新：跳过启动检查调度');
      return;
    }
    logger.info({ scope: 'auto-updater' }, '已调度启动检查（延迟 5s）');
    this.schedule('launch', LAUNCH_CHECK_DELAY_MS);
  }

  async check(manual: boolean): Promise<UpdateCheckRes> {
    this.updater.allowPrerelease =
      (this.allowPrereleaseEnabled?.() ?? false) || app.getVersion().includes('-');
    if (!this.isPackaged() && !this.devUpdateForced) {
      const message =
        '开发模式不支持自动更新（可用 CODE_AGENT_DEV_UPDATE=1 + dev-app-update.yml 调试）';
      if (manual) {
        this.emit({ phase: 'error', message });
      }
      return { status: 'error', message };
    }
    if (this.checkInFlight) {
      return { status: 'checking' };
    }
    this.checkInFlight = true;
    this.lastCheckAt = Date.now();
    let timedOut = false;
    try {
      await this.withCheckTimeout(this.updater.checkForUpdates(), () => {
        timedOut = true;
      });
      this.afterCheck(true);
      return { status: 'checking' };
    } catch (error) {
      const { message, errorKind } = describeCheckFailure(timedOut, error);
      logger.warn({ scope: 'auto-updater', errorKind }, `更新检查失败：${message}`);
      if (manual) {
        this.emit({ phase: 'error', errorKind, message });
      }
      this.afterCheck(false);
      return { status: 'error', message };
    } finally {
      this.checkInFlight = false;
    }
  }

  private async withCheckTimeout(
    checkPromise: Promise<unknown>,
    onTimeout: () => void,
  ): Promise<void> {
    void checkPromise.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        checkPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(new Error('check-timeout'));
          }, CHECK_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  cancelDownload(): void {
    const token = this.cancelToken;
    if (token === null || token.cancelled) {
      return;
    }
    logger.info({ scope: 'auto-updater' }, '取消更新下载');
    token.cancel();
  }

  getStatus(): UpdateGetStatusRes {
    return { snapshot: this.snapshot, lastCheckAt: this.lastCheckAt };
  }

  onStatus(listener: (payload: UpdateStatusPayload) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  quitAndInstall(): void {
    if (process.platform === 'win32') {
      requestDeferredInstall();
      setCloseConfirmed();
      app.quit();
      return;
    }
    this.updater.quitAndInstall(true, true);
  }

  runDeferredInstall(): void {
    if (!isDeferredInstallPending()) {
      return;
    }
    clearDeferredInstall();
    logger.info({ scope: 'auto-updater' }, '应用已退出，拉起安装向导');
    this.updater.quitAndInstall(false, false);
  }

  refreshAutoInstallOnAppQuit(): void {
    this.updater.autoInstallOnAppQuit = this.autoCheckEnabled?.() ?? true;
  }

  dispose(): void {
    this.started = false;
    this.clearTimer();
    this.cancelToken = null;
    this.pendingVersion = null;
    this.pendingReleaseNotes = null;
    this.statusListeners.clear();
  }

  private registerListeners(): void {
    this.updater.on('checking-for-update', () => {
      this.emit({ phase: 'checking' });
    });
    this.updater.on('update-available', (info) => {
      logger.info({ scope: 'auto-updater', version: info.version }, '发现新版本');
      this.pendingVersion = info.version;
      this.pendingReleaseNotes = toReleaseNotes(info.releaseNotes);
      this.emit({
        phase: 'available',
        version: info.version,
        ...(this.pendingReleaseNotes !== null ? { releaseNotes: this.pendingReleaseNotes } : {}),
      });
      this.beginDownload();
    });
    this.updater.on('update-not-available', () => {
      this.emit({ phase: 'not-available' });
    });
    this.updater.on('download-progress', (progress) => {
      this.emitProgress(progress);
    });
    this.updater.on('update-downloaded', (info) => {
      logger.info({ scope: 'auto-updater', version: info.version }, '新版本下载完成');
      this.cancelToken = null;
      this.setTaskbarProgress(null);
      const notes = toReleaseNotes(info.releaseNotes) ?? this.pendingReleaseNotes;
      this.emit({
        phase: 'downloaded',
        version: info.version,
        ...(notes !== null ? { releaseNotes: notes } : {}),
      });
    });
    this.updater.on('update-cancelled', (info) => {
      logger.info({ scope: 'auto-updater', version: info.version }, '更新下载已取消');
      this.cancelToken = null;
      this.pendingVersion = null;
      this.pendingReleaseNotes = null;
      this.setTaskbarProgress(null);
      this.emit({ phase: 'cancelled', version: info.version });
    });
    this.updater.on('error', (error) => {
      logger.error({ scope: 'auto-updater' }, '自动更新失败', error);
      this.cancelToken = null;
      this.setTaskbarProgress(null);
      this.emit({ phase: 'error', errorKind: classifyUpdateError(error), message: error.message });
    });
  }

  private beginDownload(): void {
    const token = this.createCancellationToken();
    this.cancelToken = token;
    void (async (): Promise<void> => {
      await this.ensureDifferentialBaseline();
      if (token.cancelled) {
        const version = this.pendingVersion;
        this.cancelToken = null;
        this.pendingVersion = null;
        this.pendingReleaseNotes = null;
        this.emit({ phase: 'cancelled', ...(version !== null ? { version } : {}) });
        return;
      }
      await this.updater.downloadUpdate(token);
    })()
      .catch((error: unknown) => {
        if (token.cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ scope: 'auto-updater' }, '更新下载失败', error);
        this.cancelToken = null;
        this.emit({ phase: 'error', errorKind: classifyUpdateError(error), message });
      })
      .finally(() => {
        if (this.cancelToken === token) {
          this.cancelToken = null;
        }
      });
  }

  private async ensureDifferentialBaseline(): Promise<void> {
    try {
      const cacheDir = await this.resolveUpdateCacheDir();
      if (cacheDir === null) {
        return;
      }
      if ((await pruneStaleDifferentialBaseline(cacheDir)) === 'pruned') {
        logger.info(
          { scope: 'auto-updater' },
          '基准块图与基准安装包版本不一致，已剔除陈旧块图（改从 release 取匹配基准，避免差分失败回退全量）',
        );
      }
    } catch (err) {
      logger.warn({ scope: 'auto-updater', error: String(err) }, '差分基线一致性检查失败，跳过');
    }
  }

  private async resolveUpdateCacheDir(): Promise<string | null> {
    const resourcesPath: unknown = process.resourcesPath;
    if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
      const fromPackaged = await resolveUpdaterCacheDir(resourcesPath);
      if (fromPackaged !== null) {
        return fromPackaged;
      }
    }
    return await resolveUpdaterCacheDir(app.getAppPath(), undefined, 'dev-app-update.yml');
  }

  private emitProgress(info: UpdateProgressInfo): void {
    const version = this.pendingVersion;
    const percent = Math.round(info.percent);
    this.setTaskbarProgress(percent);
    this.emit({
      phase: 'downloading',
      progress: percent,
      transferred: info.transferred,
      total: info.total,
      bytesPerSecond: info.bytesPerSecond,
      ...(version !== null ? { version } : {}),
    });
  }

  private setTaskbarProgress(percent: number | null): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.setProgressBar(percent === null ? -1 : percent / 100);
      }
    }
  }

  private emit(payload: UpdateStatusPayload): void {
    this.snapshot = payload;
    for (const listener of this.statusListeners) {
      try {
        listener(payload);
      } catch (err) {
        logger.warn({ scope: 'auto-updater', error: String(err) }, '状态监听器执行失败');
      }
    }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          emitEvent(win.webContents, IPC_DEFINITIONS.update.subscribeStatus, payload);
        }
      } catch (err) {
        logger.warn({ scope: 'auto-updater', error: String(err) }, '状态窗口广播失败');
      }
    }
  }

  private afterCheck(succeeded: boolean): void {
    const fired = this.firedKind;
    this.firedKind = null;
    if (succeeded) {
      this.retryIndex = 0;
      if (this.timerKind === 'launch' || this.timerKind === 'retry') {
        this.clearTimer();
      }
      if (this.timerKind === null) {
        this.schedule('long-session', LONG_SESSION_CHECK_INTERVAL_MS);
      }
      return;
    }
    if (fired === 'long-session') {
      this.retryIndex = 0;
      this.schedule('long-session', LONG_SESSION_CHECK_INTERVAL_MS);
      return;
    }
    if (fired !== 'launch' && fired !== 'retry') {
      return;
    }
    const delay = LAUNCH_CHECK_RETRY_DELAYS_MS[this.retryIndex];
    if (delay === undefined) {
      logger.warn({ scope: 'auto-updater' }, '启动检查重试次数用尽，本会话不再自动检查');
      this.clearTimer();
      return;
    }
    this.retryIndex += 1;
    this.schedule('retry', delay);
  }

  private schedule(kind: CheckTimerKind, delayMs: number): void {
    this.clearTimer();
    this.timerKind = kind;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.firedKind = this.timerKind;
      this.timerKind = null;
      if (this.started) {
        void this.check(false);
      }
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timerKind = null;
  }
}

export function classifyUpdateError(error: unknown): UpdateErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const code = readErrorField(error, 'code');
  const statusCode = readErrorField(error, 'statusCode');

  if (
    statusCode === 403 ||
    statusCode === 429 ||
    code === 'HTTP_ERROR_403' ||
    code === 'HTTP_ERROR_429'
  ) {
    return 'rate-limited';
  }
  if (/sha512|checksum/i.test(message)) {
    return 'checksum';
  }
  if (code === 'ENOSPC' || code === 'EDQUOT' || /ENOSPC|no space left/i.test(message)) {
    return 'disk';
  }
  if (
    /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|timeout/i.test(
      message,
    ) ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT'
  ) {
    return 'network';
  }
  return 'unknown';
}

export function toReleaseNotes(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const note = Reflect.get(item, 'note');
          return typeof note === 'string' ? note.trim() : '';
        }
        return '';
      })
      .filter((part) => part !== '');
    return parts.length === 0 ? null : parts.join('\n\n');
  }
  return null;
}

function describeCheckFailure(
  timedOut: boolean,
  error: unknown,
): { readonly message: string; readonly errorKind: UpdateErrorKind } {
  if (timedOut) {
    return {
      message: `更新检查超时（${Math.round(CHECK_TIMEOUT_MS / 1000)}s 未响应）`,
      errorKind: 'network',
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    errorKind: classifyUpdateError(error),
  };
}

function readErrorField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return Reflect.get(error, field) as unknown;
}

function toLogText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function createUpdaterLogger(): UpdaterLoggerLike {
  const forward = (level: 'info' | 'warn' | 'error' | 'debug', args: readonly unknown[]): void => {
    logger[level]({ scope: 'auto-updater' }, args.map((arg) => toLogText(arg)).join(' '));
  };
  return {
    info: (message, ...params) => forward('info', [message, ...params]),
    warn: (message, ...params) => forward('warn', [message, ...params]),
    error: (message, ...params) => forward('error', [message, ...params]),
    debug: (message, ...params) => forward('debug', [message, ...params]),
  };
}

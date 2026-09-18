// src/main/infra/update/update-service.ts
// 自动更新服务（electron-updater 封装，定义表驱动事件推送）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注册 autoUpdater 事件监听，转换为 UpdateStatusPayload 推送渲染层并留快照
// - 启动检查调度：每次启动一次 + 失败退避重试 + 长会话兜底
// - 手动检查 / 取消下载 / 安装重启 / 状态快照
//
// 设计（见 docs/design/27-auto-update-spec.md）：
// - 注入式：AutoUpdaterLike 抽象 electron-updater，测试注入 fake 实现（不 mock 模块）
// - 开关：autoCheckEnabled 以 () => boolean 注入（index.ts 读 app_settings 的 update 域）
// - 下载由本服务显式发起（start 置 autoDownload=false）：electron-updater 未暴露
//   取消 API（cancellationToken 在 doCheckForUpdates 内部新建、外部不可达），只有
//   自己持有 token 调 downloadUpdate 才能实现"取消下载"；库文档明确支持该用法
// - 更新源：electron-updater 打包后自动读取 electron-builder 生成的 app-update.yml
//   （由 electron-builder.yml 的 publish 配置生成），无需运行时 setFeedURL
// ──────────────────────────────────────────────────────────────

import type {
  UpdateCheckRes,
  UpdateErrorKind,
  UpdateGetStatusRes,
  UpdateStatusPayload,
} from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

/** 启动检查延迟（窗口就绪后再发起，避开启动期资源争抢） */
const LAUNCH_CHECK_DELAY_MS = 5_000;

/** 启动检查失败退避序列（1 / 5 / 15 分钟；用尽即本会话放弃，只记日志） */
const LAUNCH_CHECK_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

/** 长会话兜底间隔（窗口长期不关时补一次检查，不替代启动检查） */
const LONG_SESSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * 单次检查的超时上限（看门狗）
 *
 * 库层不可依赖：builder-util-runtime 的 60s 超时挂在 Node http 的 `socket` 事件上
 * （httpExecutor.js 的 addTimeOutHandler），而 electron-updater 走 Electron
 * net.request()——其 ClientRequest 不暴露 socket 事件，该超时不会触发。
 * 没有本看门狗时，一次网络黑洞会让 checkForUpdates 永不 settle：
 * `check()` 的 finally 不执行 → checkInFlight 永久为真 → 此后所有检查（含手动）
 * 都只返回 checking 而不发请求，界面停在"检查中"且按钮禁用，用户只能重启应用。
 */
const CHECK_TIMEOUT_MS = 45_000;

/**
 * 下载进度（electron-updater ProgressInfo 的子集）
 *
 * 差分下载时 total 是本次需下载的字节数（差分包大小），不是完整安装包体积。
 */
export interface UpdateProgressInfo {
  /** 百分比 0-100 */
  readonly percent: number;
  /** 已下载字节 */
  readonly transferred: number;
  /** 本次下载总字节 */
  readonly total: number;
  /** 平均速率（字节/秒） */
  readonly bytesPerSecond: number;
}

/** 取消令牌的可注入子集（builder-util-runtime 的 CancellationToken） */
export interface CancellationTokenLike {
  /** 取消（触发在途下载中止；幂等） */
  cancel(): void;
  /** 是否已取消 */
  readonly cancelled: boolean;
}

/** electron-updater 日志出口的可注入子集（接管后更新过程日志进 main.log） */
export interface UpdaterLoggerLike {
  /** 普通日志 */
  info(message?: unknown, ...params: unknown[]): void;
  /** 警告（差分回退等） */
  warn(message?: unknown, ...params: unknown[]): void;
  /** 错误 */
  error(message?: unknown, ...params: unknown[]): void;
  /** 调试（库内部细节，仅有实现时调用） */
  debug?(message?: unknown, ...params: unknown[]): void;
}

/** 检查调度类型（决定成功/失败后如何续排） */
type CheckTimerKind = 'launch' | 'retry' | 'long-session';

/** 启动自动检查的选项 */
export interface UpdateStartOptions {
  /**
   * 是否启用启动检查（读用户设置；缺省视为启用）
   *
   * 关闭时：不调度任何自动检查，且停用"退出时自动安装"
   * （否则上一次会话残留的已下载包仍会在退出时装上）。
   */
  readonly autoCheckEnabled?: () => boolean;
  /**
   * 开发模式更新调试（缺省关闭）
   *
   * 开启后置 autoUpdater.forceDevUpdateConfig=true：electron-updater 改为读取
   * app.getAppPath()/dev-app-update.yml，未打包也能跑通检查/下载链路（用于本地
   * 验证进度条、取消、就绪等 UI 的端到端行为）。由 index.ts 读环境变量注入，
   * 默认关闭意味着 dev 不会发起任何更新请求。
   */
  readonly devUpdateEnabled?: boolean;
}

/**
 * electron-updater autoUpdater 的可注入子集
 *
 * 只声明 UpdateService 用到的 API，测试可注入 fake 实现
 * （与工具/服务层 DI 注入模式一致，不 mock 模块）。
 */
export interface AutoUpdaterLike {
  /** 检查更新（结果经事件下发，返回值不含结果） */
  checkForUpdates(): Promise<unknown>;
  /**
   * 手动发起下载（autoDownload=false 时由本服务调用，token 用于取消）
   *
   * 参数声明为可选：与 electron-updater 的实际签名一致（可选参数使得真实
   * AppUpdater 在结构上可赋给本接口，同时本服务总是显式传入自持 token）。
   */
  downloadUpdate(cancellationToken?: CancellationTokenLike): Promise<unknown>;
  /** 安装已下载的更新并重启（isSilent=true 为静默安装） */
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  /** 发现新版后是否自动下载（本服务置 false，改由 downloadUpdate 显式发起） */
  autoDownload: boolean;
  /** 退出时是否自动安装已下载更新（跟随用户开关） */
  autoInstallOnAppQuit: boolean;
  /** 日志出口（本服务接管为项目 logger 适配器） */
  logger: UpdaterLoggerLike | null;
  /** 开发模式更新调试开关（electron-updater 据此改读 dev-app-update.yml） */
  forceDevUpdateConfig: boolean;
  on(event: 'checking-for-update', listener: () => void): void;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): void;
  on(event: 'update-not-available', listener: () => void): void;
  on(event: 'download-progress', listener: (progress: UpdateProgressInfo) => void): void;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): void;
  on(event: 'update-cancelled', listener: (info: UpdateInfoLike) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** 事件携带的版本信息（releaseNotes 由库按 provider 下发的原文，可能为字符串或分段数组） */
export interface UpdateInfoLike {
  /** 版本号 */
  readonly version: string;
  /** 更新说明（GitHub provider 下为 release body 原文；可能缺失） */
  readonly releaseNotes?: unknown;
}

/** UpdateService 接口（服务容器注入用） */
// biome-ignore lint/style/useNamingConvention: I 前缀接口遵循项目惯例（IChatService 等）
export interface IUpdateService {
  /** 注册事件监听并按选项调度启动检查（app ready 后调用一次） */
  start(options?: UpdateStartOptions): void;
  /** 触发更新检查（manual=true 时失败会推送 error 事件，自动检查静默） */
  check(manual: boolean): Promise<UpdateCheckRes>;
  /** 取消在途下载（无在途下载时为空操作；取消结果经 update-cancelled 推送） */
  cancelDownload(): void;
  /** 状态快照与上次检查时间（渲染层重载后恢复界面用；从未产生过分别为 null） */
  getStatus(): UpdateGetStatusRes;
  /** 安装已下载的更新并重启（静默安装 + 装完自动启动） */
  quitAndInstall(): void;
  /** 释放资源（清挂起定时器；在途下载留给 pending 缓存续传） */
  dispose(): void;
}

/**
 * 自动更新服务实现
 *
 * @example
 * ```ts
 * const updateService = new UpdateService(autoUpdater, () => app.isPackaged, () => new CancellationToken());
 * updateService.start({ autoCheckEnabled: () => readSetting('update')?.autoCheck !== false });
 * ```
 */
export class UpdateService implements IUpdateService {
  /** 最近一次状态快照（emit 时更新，供 getStatus 读取） */
  private snapshot: UpdateStatusPayload | null = null;

  /** 上次检查发起时间（毫秒时间戳；从未检查过为 null） */
  private lastCheckAt: number | null = null;

  /** 发现新版的版本号（进度事件不带版本，下载中/取消时补进 payload） */
  private pendingVersion: string | null = null;

  /** 发现新版时带下来的更新说明（就绪态继续展示；取消/清理时置空） */
  private pendingReleaseNotes: string | null = null;

  /** 在途下载的取消令牌（null = 无在途下载） */
  private cancelToken: CancellationTokenLike | null = null;

  /** 挂起的检查定时器与其类型 */
  private timer: NodeJS.Timeout | null = null;
  private timerKind: CheckTimerKind | null = null;

  /** 刚结束的检查来自哪种调度（null = 手动检查，用于决定是否续排） */
  private firedKind: CheckTimerKind | null = null;

  /** 启动检查失败次数（成功即清零） */
  private retryIndex = 0;

  /** 是否有检查在途（会话内去重，避免连点/重试叠打） */
  private checkInFlight = false;

  /** start 是否已调用（dispose 后不再调度） */
  private started = false;

  /** 开发模式更新调试是否生效（生效后 isPackaged 不再是硬门槛） */
  private devUpdateForced = false;

  constructor(
    private readonly updater: AutoUpdaterLike,
    private readonly isPackaged: () => boolean,
    private readonly createCancellationToken: () => CancellationTokenLike,
  ) {}

  /** @inheritDoc */
  start(options: UpdateStartOptions = {}): void {
    this.started = true;
    // 只读一次：注入的是同步读 SQLite 的函数，两次调用之间取值可能不同
    const autoCheckEnabled = (options.autoCheckEnabled ?? ((): boolean => true))();
    this.devUpdateForced = options.devUpdateEnabled === true;

    // 日志接管：库默认走主进程 console（打包后无处可看），接进项目 logger
    this.updater.logger = createUpdaterLogger();
    // 下载改由本服务显式发起（只有自持 token 才能取消）
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = autoCheckEnabled;
    // 开发模式调试：改读 dev-app-update.yml（默认关闭，dev 不发任何更新请求）
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

  /** @inheritDoc */
  async check(manual: boolean): Promise<UpdateCheckRes> {
    // 开发模式（未打包）：electron-updater 无 app-update.yml，检查必失败。
    // 例外：devUpdateEnabled 时已置 forceDevUpdateConfig，库改读 dev-app-update.yml。
    if (!this.isPackaged() && !this.devUpdateForced) {
      const message =
        '开发模式不支持自动更新（可用 CODE_AGENT_DEV_UPDATE=1 + dev-app-update.yml 调试）';
      if (manual) {
        this.emit({ phase: 'error', message });
      }
      return { status: 'error', message };
    }
    // 会话内去重：在途检查不重复发起（连点"检查更新"不叠打远端）
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

  /**
   * 给检查加超时看门狗（超时判定与失败判定分开：调用方据 timedOut 归类为 network）
   *
   * 超时后底层请求仍在跑，故额外挂一个空 catch 防"未处理的 Promise 拒绝"冒到全局
   * 处理器（迟到的好消息仍会经事件正常推送）。
   */
  private async withCheckTimeout(
    checkPromise: Promise<unknown>,
    onTimeout: () => void,
  ): Promise<void> {
    void checkPromise.catch(() => {
      // 超时后我们已不再 await 它；正常路径下 race 会照常收到本 rejection
    });
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

  /** @inheritDoc */
  cancelDownload(): void {
    const token = this.cancelToken;
    if (token === null || token.cancelled) {
      return;
    }
    logger.info({ scope: 'auto-updater' }, '取消更新下载');
    token.cancel();
  }

  /** @inheritDoc */
  getStatus(): UpdateGetStatusRes {
    return { snapshot: this.snapshot, lastCheckAt: this.lastCheckAt };
  }

  /** @inheritDoc */
  quitAndInstall(): void {
    // 静默安装 + 装完自动启动（对齐"重启即装"的按钮文案；per-user 安装不弹 UAC）
    this.updater.quitAndInstall(true, true);
  }

  /** @inheritDoc */
  dispose(): void {
    this.started = false;
    this.clearTimer();
    this.cancelToken = null;
    this.pendingVersion = null;
    this.pendingReleaseNotes = null;
  }

  /** 注册 autoUpdater 事件监听（事件 → payload 推送 + 快照） */
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
      // 就绪态继续展示更新说明（部分 provider 只在 downloaded 事件带 notes）
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

  /** 显式发起下载（自持 token，供 cancelDownload 使用） */
  private beginDownload(): void {
    const token = this.createCancellationToken();
    this.cancelToken = token;
    void this.updater
      .downloadUpdate(token)
      .catch((error: unknown) => {
        // 用户取消：库会推 update-cancelled，这里不再重复报错
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

  /** 进度事件 → payload（透传字节与速率；差分下载时 total 为差分包大小） */
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

  /**
   * 任务栏进度（Windows/macOS 生效，其他平台 no-op）
   *
   * @param percent 0-100；null 表示清除（下载结束/取消/失败）
   */
  private setTaskbarProgress(percent: number | null): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.setProgressBar(percent === null ? -1 : percent / 100);
      }
    }
  }

  /** 推送状态到所有渲染窗口，并留快照（无窗口时也留，供后续 getStatus） */
  private emit(payload: UpdateStatusPayload): void {
    this.snapshot = payload;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        emitEvent(win.webContents, IPC_DEFINITIONS.update.subscribeStatus, payload);
      }
    }
  }

  /**
   * 检查结束后的调度决策
   *
   * - 成功：清零重试计数，清掉挂起的启动/重试定时器，确保 12h 长会话兜底在排
   * - 长会话兜底失败：保持 12h 节奏（一次网络抖动不该停掉整个会话的兜底）
   * - 启动检查链失败：按 1/5/15 分钟退避重试，用尽即本会话放弃（只记日志）
   * - 手动检查失败：不启动重试链（用户可再点）
   */
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

  /** 调度一次定时检查（同刻只允许一个挂起定时器） */
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

  /** 清除挂起的定时器 */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timerKind = null;
  }
}

/**
 * 更新错误分类（按错误特征归类，供渲染层映射本地化文案）
 *
 * 识别依据来自真实错误形状：builder-util-runtime 的 HttpError 带
 * `statusCode` 与 `code = HTTP_ERROR_<status>`；Node 网络错误带 code
 * （ENOTFOUND/ECONNREFUSED…）；Electron net 抛 net::ERR_* 文本；校验失败为
 * sha512/checksum 描述文本。无法归类一律 unknown（保留原始 message 供排查）。
 */
export function classifyUpdateError(error: unknown): UpdateErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const code = readErrorField(error, 'code');
  const statusCode = readErrorField(error, 'statusCode');

  // 限流：HTTP 403（无权限/被挡）与 429（请求过多）
  if (
    statusCode === 403 ||
    statusCode === 429 ||
    code === 'HTTP_ERROR_403' ||
    code === 'HTTP_ERROR_429'
  ) {
    return 'rate-limited';
  }
  // 校验失败：sha512 / checksum 不匹配
  if (/sha512|checksum/i.test(message)) {
    return 'checksum';
  }
  // 磁盘：Node fs 空间不足（ENOSPC）与超配额（EDQUOT）
  if (code === 'ENOSPC' || code === 'EDQUOT' || /ENOSPC|no space left/i.test(message)) {
    return 'disk';
  }
  // 网络：Electron net 错误文本与 Node 网络错误码
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

/**
 * 归一化更新说明
 *
 * electron-updater 的 releaseNotes 按 provider 可能是字符串（GitHub release
 * body）或分段数组（`{ version, note }[]`，如 latest.yml 的内嵌 notes）。
 * 这里统一成纯文本；无法识别的形状返回 null（不编造内容）。
 */
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

/**
 * 检查失败的文案与分类
 *
 * 超时单独归类为 network：用户侧的可操作建议与"网络不可达"一致（检查网络后重试）。
 */
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

/** 读取错误对象上的字段（Error 子类运行时携带 code/statusCode，类型上不可见） */
function readErrorField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return Reflect.get(error, field) as unknown;
}

/** 把值转为单行日志文本（保留 Error 的堆栈信息，对象走 JSON） */
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

/** 构造 electron-updater 的日志适配器（转发到项目 logger，scope=auto-updater） */
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

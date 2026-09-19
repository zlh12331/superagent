// src/main/window.ts
// 主窗口创建（自 index.ts 提取：窗口构造 + 安全基线 + DevTools 注入）
// ──────────────────────────────────────────────────────────────
// createWindow 自 index.ts 提取（129 行函数体），index.ts 保留应用生命周期编排。
// 安全配置遵循 Electron Security 官方推荐：
// - contextIsolation: true（XSS → RCE 防护）
// - nodeIntegration: false
// - sandbox: true（渲染层沙箱）
// ──────────────────────────────────────────────────────────────

import { join } from 'node:path';
import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { isCloseConfirmed, setCloseConfirmed } from './quit-state';
import { hasRunningAgentTurns } from './service-container';
import { reportMessage } from './utils/error-report';
import { logger } from './utils/logger';
import { loadWindowState, trackWindowState, type WindowState } from './utils/window-state';
import { TITLE_BAR_SYMBOL } from './window-theme';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// ── 关窗协商共享状态 ──
// 已独立到 ./quit-state（close 路径与 before-quit 路径共享"用户已确认"标志；
// 更新安装入口亦需置位该标志，为避免 update-service → window → service-container
// 循环依赖，标志移出本文件）。

/**
 * 运行中回合退出确认弹窗（close 协商与 before-quit 协商共用）
 *
 * @returns true = 用户确认退出（中断回合，交由退出善后标记 interrupted）
 *          false = 用户取消（回合继续，应用保持运行）
 */
export async function confirmInterruptRunningTurns(win: BrowserWindow): Promise<boolean> {
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: app.getName(),
      message: 'Agent 回合正在运行',
      detail: '现在退出将中断当前回合（已生成内容保留，下次启动可从中断处恢复）。确定退出吗？',
      buttons: ['取消', '退出'],
      defaultId: 0, // 默认聚焦"取消"——误按 Enter 不至于丢回合
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  } catch (err) {
    // dialog 失败（窗口已销毁等）：保守放行，交给 before-quit 兜底清理
    logger.warn({ error: String(err) }, '关窗确认对话框失败，放行关闭（before-quit 兜底）');
    return true;
  }
}

/**
 * 创建主窗口
 *
 * 流程：恢复窗口状态 → BrowserWindow（frameless + 安全基线）→
 * 导航/新窗口限制 → 加载渲染层 → 状态跟踪 → dev DevTools 注入。
 */
export function createWindow(): BrowserWindow {
  // 窗口状态记忆：恢复上次尺寸/位置/最大化（校验不可见时回退系统默认）
  const windowState: WindowState = loadWindowState(
    join(app.getPath('userData'), 'window-state.json'),
    { width: 1280, height: 800 },
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    ...(windowState.x !== undefined ? { x: windowState.x } : {}),
    ...(windowState.y !== undefined ? { y: windowState.y } : {}),
    width: windowState.width,
    height: windowState.height,
    // 最小窗口尺寸：低于 960 宽时主区被压缩至不可用（聊天输入区不可见）
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // frameless 标题栏（对齐原型自绘标题栏设计，三端支持）：
    // - 隐藏系统标题栏，渲染层顶部栏延伸到窗口顶部（顶栏即标题栏）
    // - macOS：titleBarStyle hidden 保留红绿灯（系统绘制）
    // - Windows/Linux：titleBarOverlay 保留窗口控件（系统绘制，原生交互全保留）
    titleBarStyle: 'hidden',
    // 非 macOS 平台用 overlay 窗口控件（Electron 官方推荐平台分支写法）
    // symbolColor 取暗色值（默认主题 dark）；启动时 syncTitleBarOverlayFromTheme
    // 会按 SQLite 实际设置校正，主题切换实时联动
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            // 透明底：让顶栏玻璃背景统一延伸（深色实底会形成突兀黑块）
            color: '#00000000',
            // stone-400：暗色玻璃背景上清晰可见（纯黑会隐身）
            symbolColor: TITLE_BAR_SYMBOL.dark,
            // 与 --aurora-topbar-h（52px）对齐
            height: 52,
          },
        }
      : {}),
    webPreferences: {
      // preload 输出为 .cjs（CJS 格式）：sandbox: true 要求 preload 必须是 CommonJS
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 限制导航（Security #13）：只允许应用内导航
  // P2 加固：dev 仅允许 electron-vite dev server 同源；prod（file:// 入口）
  // 不再放行任意 http://localhost:*——本机其他端口的服务同样能借此导航窗口
  const navRendererUrl = process.env['ELECTRON_RENDERER_URL'];
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const parsed = new URL(url);
      if (navRendererUrl !== undefined && parsed.origin === new URL(navRendererUrl).origin) {
        allowed = true;
      } else if (parsed.protocol === 'file:') {
        allowed = parsed.pathname.endsWith('/renderer/index.html');
      }
    } catch {
      allowed = false;
    }
    if (!allowed) {
      event.preventDefault();
    }
  });

  // 限制新窗口（Security #14）：外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 开发环境加载 dev server，生产环境加载构建产物
  // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  // ── 关窗协商（进程与窗口维度：关窗前与用户确认运行中回合）──
  // 有 Agent 回合在跑时拦截 close，弹确认框（对齐 VS Code"未保存工作退出确认"）：
  // - 取消 → 窗口保留，回合继续（用户可等回合自然结束再关）
  // - 退出 → 置共享标志放行本次 close，退出路径由 before-quit
  //   的 agentService.dispose drain + markInterruptedOnShutdown 善后
  // 豁免：CODE_AGENT_SKIP_CLOSE_GUARD=1（E2E / 无头场景跳过协商，防模态框卡死测试）
  win.on('close', (event) => {
    if (isCloseConfirmed() || process.env['CODE_AGENT_SKIP_CLOSE_GUARD'] === '1') {
      return;
    }
    if (!hasRunningAgentTurns()) {
      return;
    }
    event.preventDefault();
    logger.info({}, '检测到运行中的 Agent 回合，拦截窗口关闭并请求用户确认');
    void confirmInterruptRunningTurns(win).then((confirmed) => {
      if (confirmed) {
        setCloseConfirmed();
        win.close();
      }
    });
  });

  // 恢复最大化状态（必须在 show 前，避免先显示普通窗口再跳变）
  if (windowState.isMaximized) {
    win.maximize();
  }

  // ── 渲染进程崩溃自愈（进程与窗口维度：渲染崩 ≠ 整窗死）──
  // reason 分类（Electron webContents 'render-process-gone'）：
  // - clean-exit：正常退出路径（如 win.close 流程），不处理
  // - crashed / oom / killed / launch-failed 等：自动 reload 恢复窗口
  //   数据真源在 SQLite + 持久 store，reload 仅丢 transient 内存态（可接受）
  // 防循环：60s 窗口内最多 2 次自愈，超限停止 reload（避免"崩→reload→再崩"死循环）
  let crashRecoveryCount = 0;
  let crashWindowStart = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }
    logger.error(
      { reason: details.reason, exitCode: details.exitCode },
      '渲染进程异常退出，尝试自动恢复',
    );
    void reportMessage(`渲染进程崩溃：reason=${details.reason} exitCode=${details.exitCode}`);
    const now = Date.now();
    if (now - crashWindowStart > 60_000) {
      crashWindowStart = now;
      crashRecoveryCount = 0;
    }
    crashRecoveryCount += 1;
    if (crashRecoveryCount > 2) {
      logger.error(
        { reason: details.reason, crashRecoveryCount },
        '渲染进程短时间反复崩溃，停止自动恢复（请手动重启应用）',
      );
      void reportMessage('渲染进程反复崩溃，已停止自动恢复', 'warning');
      return;
    }
    win.webContents.reload();
  });

  // 窗口状态跟踪：move/resize 防抖 + 最大化即时 + close 同步落盘
  trackWindowState(win, join(app.getPath('userData'), 'window-state.json'));

  // 方案 A + C：dev 模式自动安装 React DevTools 扩展 + 自动打开 Chromium DevTools
  // - C：installExtension 从 Chrome Web Store 下载 React DevTools 并注入 session
  //   失败容忍（网络问题/已安装）—— 仅 warn 不影响应用启动
  // - A：openDevTools({ mode: 'detach' }) 打开独立 DevTools 窗口
  //   生产环境不自动打开（打包后 app.isPackaged === true）
  //
  // 注意：electron-devtools-installer v4.0.0 使用废弃的 session.getAllExtensions API
  // 导致 deprecated 警告，但不影响功能；React DevTools 需要联网下载
  //
  // M4 修复：
  // - 用 `void` 显式标注 fire-and-forget Promise，避免 floating-promise lint 警告
  // - catch 中保留完整 error 对象（含 stack），便于 logger 序列化排查网络/权限问题
  // - openDevTools 不依赖 installExtension 成功（即使扩展安装失败，DevTools 仍可用）
  if (!app.isPackaged) {
    void installExtension(REACT_DEVELOPER_TOOLS)
      .then((name) => {
        logger.info({ name }, 'React DevTools 扩展已安装');
      })
      .catch((err: unknown) => {
        // 错误容忍：网络问题 / 已安装版本冲突 / Chrome Web Store 不可达
        // 不影响应用启动，DevTools 仍可用（openDevTools 不依赖扩展）
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'React DevTools 扩展安装失败（不影响应用运行）',
        );
      });
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置 / §7.6 日志 / §7.7 Sentry
//
// 说明：P7 新增 SQLite + Drizzle 持久化层（SessionService），
// 替代早期已删除的 PG/Prisma/AGE 数据库层。
// 当前主进程负责：Sentry 初始化、Logger 初始化、SQLite 初始化、
// 窗口创建、退出清理（含 closeDb）。

import { join } from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, session, shell } from 'electron';
import { getAppConfig } from './config';
import { initDb } from './infra/storage/db';
import { registerAgentHandlers } from './ipc/agent.handler';
import { registerAgentApprovalHandlers } from './ipc/agent-approval.handler';
import { registerAppHandlers } from './ipc/app.handler';
import { registerChatHandlers } from './ipc/chat.handler';
import { registerCodebaseHandlers } from './ipc/codebase.handler';
import { registerFileHandlers } from './ipc/file.handler';
import { registerGitHandlers } from './ipc/git.handler';
import { registerSearchHandlers } from './ipc/search.handler';
import { registerSessionHandlers } from './ipc/session.handler';
import { registerTerminalHandlers } from './ipc/terminal.handler';
import { registerToolHandlers } from './ipc/tool.handler';
import { buildCsp } from './security/csp';
import { disposeServices, serviceContainer } from './service-container';
import { initLogger, logger, registerGlobalErrorHandlers } from './utils/logger';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// dev 环境把 userData 重定向到项目内目录，避免 TRAE 沙箱拦截系统 %APPDATA% 写入
// 生产环境（app.isPackaged === true）保持系统默认 %APPDATA%/<AppName>，符合用户数据规范
if (!app.isPackaged) {
  app.setPath('userData', join(__dirname, '../../.electron-user-data'));
}

/**
 * 初始化 Sentry
 *
 * 设计文档 §7.7：
 * - 自托管 Sentry v26.6.0
 * - DSN 从 config 读取（环境变量 SENTRY_DSN）
 * - 生产环境采样 10% 事务，dev 不采样
 * - beforeSend 脱敏：移除 Authorization header
 *
 * 必须在 app.whenReady() 之前调用
 */
function initSentry(): void {
  const config = getAppConfig();
  if (config.sentry.dsn === '') {
    // DSN 未配置时跳过初始化（dev 环境常见）
    logger.warn({}, 'Sentry DSN 未配置，跳过初始化');
    return;
  }

  Sentry.init({
    dsn: config.sentry.dsn,
    release: `novel-writer@${app.getVersion()}`,
    environment: config.isPackaged ? 'production' : 'development',
    tracesSampleRate: config.sentry.tracesSampleRate,
    sendDefaultPii: false,
    beforeSend(event) {
      // 脱敏：移除可能的 API Key / Authorization header
      // 注意：@sentry/electron 7 的 beforeSend 入参为 Event（携带 type 字段），
      // 返回类型必须为 Event | null，因此采用不可变更新保持 type 兼容
      // noPropertyAccessFromIndexSignature: headers 是索引签名，必须用方括号访问
      if (event.request?.headers?.['authorization']) {
        const { ['authorization']: _auth, ...restHeaders } = event.request.headers;
        return { ...event, request: { ...event.request, headers: restHeaders } };
      }
      return event;
    },
  });
}

/**
 * 创建主窗口
 * 安全配置遵循 Electron Security 官方推荐：
 * - contextIsolation: true（XSS → RCE 防护）
 * - nodeIntegration: false
 * - sandbox: true（渲染层沙箱）
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
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
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('app://')) {
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

  return win;
}

// Sentry 必须在 app.whenReady() 之前初始化（@sentry/electron 要求）
initSentry();

// 应用就绪后初始化 logger + SQLite + 全局错误捕获 + IPC handler + 创建窗口
app.whenReady().then(() => {
  // 初始化 logger（需要 app.getPath，必须在 whenReady 之后）
  initLogger();
  // 初始化 SQLite + Drizzle（必须在注册任何依赖 DB 的服务之前）
  // - 建表 + 索引（幂等，已存在则跳过）
  // - 启用 WAL 模式 + 外键约束
  // - SessionService 通过 getDb() 动态访问，但首次访问必须确保 db 已初始化
  initDb();
  registerGlobalErrorHandlers();
  // 注册应用级 IPC handler（app:getStatus / app:openExternal）
  registerAppHandlers();
  // 注册聊天域 IPC handler（chat:send / chat:stop，基于 Vercel AI SDK v7）
  // 通过 ServiceContainer 注入 IChatService 实例，解耦 handler 与具体实现
  registerChatHandlers({ chatService: serviceContainer.getChatService() });
  // 注册文件域 IPC handler（file:read / file:write / file:list / file:watch:start / file:watch:stop）
  // 通过 ServiceContainer 注入 IFileService 实例，handler 不直接依赖 FileService 实现
  registerFileHandlers({ fileService: serviceContainer.getFileService() });
  // 注册搜索域 IPC handler（search:grep / search:glob）
  // 通过 ServiceContainer 注入 ISearchService 实例，handler 不直接依赖 SearchService 实现
  registerSearchHandlers({ searchService: serviceContainer.getSearchService() });

  // 注册终端域 IPC handler（terminal:create / input / resize / kill）
  // 通过 ServiceContainer 注入 ITerminalService 实例（基于 node-pty）
  // terminal:create 传入 ctx.sender（WebContents）作为后续事件推送目标
  // 后续输出和退出事件通过 terminal:event:output / terminal:event:exit 推送
  registerTerminalHandlers({ terminalService: serviceContainer.getTerminalService() });

  // 注册 Git 域 IPC handler（git:status / git:diff）
  // 通过 ServiceContainer 注入 IGitService 实例（基于 child_process.spawn('git')）
  // 仅暴露只读查询，写操作通过 TerminalService 由用户手动执行
  registerGitHandlers({ gitService: serviceContainer.getGitService() });

  // 注册代码库域 IPC handler（codebase:query / explore / node / callers / callees / impact）
  // 通过 ServiceContainer 注入 ICodebaseService 实例（基于 child_process.spawn('codegraph')）
  // 提供 6 个代码智能查询通道，支持符号搜索、调用追踪、影响分析
  // Code Agent 调用这些方法获取代码上下文，喂给 LLM 辅助决策
  registerCodebaseHandlers({ codebaseService: serviceContainer.getCodebaseService() });

  // 注册 Session 域 IPC handler（session:list / get / delete / rename）
  // 通过 ServiceContainer 注入 ISessionService 实例（基于 drizzle + better-sqlite3）
  // 持久化会话历史：用户关闭窗口后下次启动可恢复历史对话
  // create / appendMessage 是内部 API（供 AgentService 调用），不通过 IPC 暴露
  registerSessionHandlers({ sessionService: serviceContainer.getSessionService() });

  // 注册工具域 IPC handler（tool:list）
  // 通过 ServiceContainer 注入 IToolRegistry 实例（已注册 5 个内置工具）
  registerToolHandlers({ toolRegistry: serviceContainer.getToolRegistry() });

  // 注册 Agent 域 IPC handler（agent:run / agent:stop）
  // 通过 ServiceContainer 注入 IAgentService 实例（依赖 ToolRegistry + ToolExecutor）
  // agent:run 启动 streamText 多轮工具调用循环，立即返回 sessionId
  // 后续流式事件通过 AGENT_STREAM_PART / AGENT_TOOL_CALL / AGENT_TOOL_RESULT / AGENT_APPROVAL_REQUEST 推送
  registerAgentHandlers({ agentService: serviceContainer.getAgentService() });

  // 注册 Agent 审批响应 IPC handler（agent:approval:response）
  // 通过 ServiceContainer 注入 IPermissionService 实例
  // 渲染层 ApprovalModal 用户操作后通过此 channel 回传审批结果
  registerAgentApprovalHandlers({
    permissionService: serviceContainer.getPermissionService(),
  });

  // 注入 CSP 响应头（P1-5 安全基线）
  // 生产环境严格策略 / 开发环境宽松策略（允许 Vite HMR）
  // 覆盖渲染层 HTML 的 CSP meta，确保所有响应统一使用主进程策略
  const csp = buildCsp(!app.isPackaged);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
  logger.info({ isPackaged: app.isPackaged }, 'CSP 策略已注入');

  logger.info({}, '应用启动');

  createWindow();

  // macOS: 点击 dock 图标时若无窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前统一清理所有服务（设计文档 §1.1 应用生命周期 / §7.6 生命周期管理）
// P3-10 改造：disposeServices 内部调用 ChatService.dispose() 等待所有活跃 stream 真正完成
// （带 3s 超时兜底），避免进程退出时正在进行的 IPC send 丢失 / 渲染层 loading 状态卡死
// 防重入标志：app.exit(0) 可能再次触发 before-quit，避免重复清理
let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  // preventDefault 必须在事件循环开始处同步调用，确保能阻止默认退出
  event.preventDefault();
  isQuitting = true;
  try {
    await disposeServices();
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  // 强制退出，不再触发 before-quit（与 app.quit() 不同）
  app.exit(0);
});

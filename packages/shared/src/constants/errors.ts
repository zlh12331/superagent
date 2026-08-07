// packages/shared/src/constants/errors.ts
// 统一错误码 + AppError 类：跨进程共享的错误处理基础设施
// 设计文档 §7.2（错误码枚举）、§7.3（AppError）、§7.10（用户友好提示）
//
// 说明：数据库相关错误码（PROJECT/CHAPTER/CHARACTER/RAG/DB/PG/OLLAMA）
// 已随数据库层一并删除，仅保留通用基础设施错误码。
//
// 命名规范：{域}_{动作/状态}，全大写下划线分隔
// 域：UNKNOWN/INTERNAL/IPC/AI/FS/TOOL/SESSION/TERMINAL
//
// 注意：使用 as const 派生字面量联合类型，避免 enum 的运行时对象开销

/**
 * 错误码枚举
 *
 * 仅包含与数据库无关的通用错误码：
 * - 通用：UNKNOWN/INTERNAL_ERROR/INVALID_INPUT/NOT_FOUND/UNAUTHORIZED/RATE_LIMITED
 * - IPC 边界：IPC_SENDER_INVALID/IPC_CHANNEL_NOT_FOUND
 * - AI 调用：AI_API_KEY_MISSING/AI_API_KEY_INVALID/AI_RATE_LIMITED/AI_TIMEOUT/AI_MODEL_ERROR/AI_STREAM_INTERRUPTED/AI_CONTEXT_TOO_LARGE
 * - 文件系统：FS_READ_FAILED/FS_WRITE_FAILED/FS_DISK_FULL
 * - Code Agent 工具：TOOL_NOT_FOUND/TOOL_EXECUTION_FAILED/TOOL_PERMISSION_DENIED/TOOL_ABORTED
 * - Code Agent 会话：SESSION_NOT_FOUND
 * - Code Agent 终端：TERMINAL_SPAWN_FAILED
 */
export const ErrorCode = {
  // ── 通用 ──────────────────────────────────────────
  UNKNOWN: 'UNKNOWN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',

  // ── IPC 边界 ──────────────────────────────────────
  IPC_SENDER_INVALID: 'IPC_SENDER_INVALID',
  IPC_CHANNEL_NOT_FOUND: 'IPC_CHANNEL_NOT_FOUND',
  /** 主进程 handler 返回结构不符合契约（resSchema 校验失败） */
  INVALID_RESPONSE: 'INVALID_RESPONSE',

  // ── AI 调用 ───────────────────────────────────────
  AI_API_KEY_MISSING: 'AI_API_KEY_MISSING',
  AI_API_KEY_INVALID: 'AI_API_KEY_INVALID',
  AI_RATE_LIMITED: 'AI_RATE_LIMITED',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_MODEL_ERROR: 'AI_MODEL_ERROR',
  AI_STREAM_INTERRUPTED: 'AI_STREAM_INTERRUPTED',
  AI_CONTEXT_TOO_LARGE: 'AI_CONTEXT_TOO_LARGE',
  /** HTTP 402：账户余额不足（DeepSeek 等供应商返回） */
  AI_BALANCE_INSUFFICIENT: 'AI_BALANCE_INSUFFICIENT',

  // ── IM 渠道 ───────────────────────────────────────
  /** 渠道未配置 token（keychain 无凭证） */
  IM_CHANNEL_NOT_CONFIGURED: 'IM_CHANNEL_NOT_CONFIGURED',
  /** 渠道 token 无效（getMe 等校验失败） */
  IM_CHANNEL_INVALID_TOKEN: 'IM_CHANNEL_INVALID_TOKEN',
  /** 渠道未实现（骨架占位） */
  IM_CHANNEL_NOT_IMPLEMENTED: 'IM_CHANNEL_NOT_IMPLEMENTED',
  /** 渠道 API 请求失败（网络/HTTP 错误） */
  IM_CHANNEL_REQUEST_FAILED: 'IM_CHANNEL_REQUEST_FAILED',

  // ── 文件系统 ──────────────────────────────────────
  FS_READ_FAILED: 'FS_READ_FAILED',
  FS_WRITE_FAILED: 'FS_WRITE_FAILED',
  FS_DISK_FULL: 'FS_DISK_FULL',

  // ── Code Agent ───────────────────────────────────
  // 工具相关：Code Agent 执行 LLM 工具调用时的失败场景
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  TOOL_ABORTED: 'TOOL_ABORTED',
  // 会话相关：Code Agent 会话持久化与恢复
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  // 终端相关：node-pty 终端会话管理
  TERMINAL_SPAWN_FAILED: 'TERMINAL_SPAWN_FAILED',
} as const;

/** 错误码字面量联合类型（从 ErrorCode 派生） */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误严重级别 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/**
 * 错误元数据
 *
 * - userMessage：面向终端用户的中文友好提示
 * - retryable：是否可自动重试（AI 限流、超时等）
 * - severity：日志级别 + Sentry 事件级别
 */
export interface ErrorMeta {
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly severity: ErrorSeverity;
}

/**
 * ERROR_META：错误码 → 元数据映射表
 *
 * 完整覆盖所有 ErrorCode，缺失即视为 bug（单测会校验）
 * 用户友好提示文案参考设计文档 §7.10
 */
export const ERROR_META: Readonly<Record<ErrorCode, ErrorMeta>> = {
  // 通用
  UNKNOWN: { userMessage: '未知错误', retryable: false, severity: 'error' },
  INTERNAL_ERROR: { userMessage: '内部错误', retryable: false, severity: 'error' },
  INVALID_INPUT: { userMessage: '输入参数有误', retryable: false, severity: 'warn' },
  NOT_FOUND: { userMessage: '资源不存在', retryable: false, severity: 'warn' },
  ALREADY_EXISTS: { userMessage: '目标已存在', retryable: false, severity: 'warn' },
  UNAUTHORIZED: { userMessage: '未授权', retryable: false, severity: 'warn' },
  RATE_LIMITED: { userMessage: '操作过于频繁', retryable: true, severity: 'warn' },

  // IPC
  IPC_SENDER_INVALID: { userMessage: 'IPC 调用来源无效', retryable: false, severity: 'error' },
  IPC_CHANNEL_NOT_FOUND: { userMessage: 'IPC 通道不存在', retryable: false, severity: 'error' },
  INVALID_RESPONSE: {
    userMessage: '主进程响应不符合契约',
    retryable: false,
    severity: 'error',
  },

  // AI
  AI_API_KEY_MISSING: { userMessage: '请先配置 API Key', retryable: false, severity: 'warn' },
  AI_API_KEY_INVALID: { userMessage: 'API Key 无效', retryable: false, severity: 'warn' },
  AI_RATE_LIMITED: { userMessage: 'AI 调用频繁，正在重试', retryable: true, severity: 'warn' },
  AI_TIMEOUT: { userMessage: 'AI 调用超时', retryable: true, severity: 'warn' },
  AI_MODEL_ERROR: { userMessage: 'AI 模型错误', retryable: false, severity: 'error' },
  AI_STREAM_INTERRUPTED: { userMessage: 'AI 流式响应中断', retryable: true, severity: 'warn' },
  AI_CONTEXT_TOO_LARGE: {
    userMessage: '上下文过长，请精简对话',
    retryable: false,
    severity: 'warn',
  },
  AI_BALANCE_INSUFFICIENT: {
    userMessage: '账户余额不足，请充值后重试',
    retryable: false,
    severity: 'warn',
  },

  // IM 渠道
  IM_CHANNEL_NOT_CONFIGURED: {
    userMessage: 'IM 渠道未配置凭证',
    retryable: false,
    severity: 'warn',
  },
  IM_CHANNEL_INVALID_TOKEN: {
    userMessage: 'IM 渠道凭证无效',
    retryable: false,
    severity: 'warn',
  },
  IM_CHANNEL_NOT_IMPLEMENTED: {
    userMessage: 'IM 渠道待接入',
    retryable: false,
    severity: 'info',
  },
  IM_CHANNEL_REQUEST_FAILED: {
    userMessage: 'IM 渠道请求失败',
    retryable: true,
    severity: 'warn',
  },

  // 文件系统
  FS_READ_FAILED: { userMessage: '文件读取失败', retryable: false, severity: 'error' },
  FS_WRITE_FAILED: { userMessage: '文件写入失败', retryable: false, severity: 'error' },
  FS_DISK_FULL: { userMessage: '磁盘空间不足', retryable: false, severity: 'warn' },

  // Code Agent：工具调用相关
  TOOL_NOT_FOUND: { userMessage: '工具不存在', retryable: false, severity: 'warn' },
  TOOL_EXECUTION_FAILED: {
    userMessage: '工具执行失败',
    retryable: false,
    severity: 'error',
  },
  TOOL_PERMISSION_DENIED: {
    userMessage: '工具调用未授权',
    retryable: false,
    severity: 'warn',
  },
  TOOL_ABORTED: { userMessage: '工具执行被中断', retryable: false, severity: 'info' },
  // Code Agent：会话相关
  SESSION_NOT_FOUND: { userMessage: '会话不存在', retryable: false, severity: 'warn' },
  // Code Agent：终端相关
  TERMINAL_SPAWN_FAILED: {
    userMessage: '终端启动失败',
    retryable: false,
    severity: 'error',
  },
};

/**
 * IPC 错误序列化结构
 *
 * 主进程 wrap() 捕获 AppError 后调用 toIpcError()，经 IPC 序列化传输到渲染层
 */
export interface IpcError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * AppError：应用统一错误类
 *
 * 设计文档 §7.3
 * - 主进程 service / infra 层抛出 AppError
 * - wrap() 捕获并调用 toIpcError() 返回给渲染层
 * - 渲染层通过 handleIpcError() 根据 code 显示 toast 与操作建议
 *
 * 注意：复用 ES2022 Error 原生 cause 属性（通过 super 第二参数传入）
 * 不在子类重新声明 cause，避免与 lib.es2022.error 的 Error.cause 冲突
 */
export class AppError extends Error {
  /** 错误码（单一身份标识） */
  readonly code: ErrorCode;

  /** 附加上下文（如校验失败的字段列表），会序列化到 IPC details */
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, cause?: unknown, details?: unknown) {
    // ES2022 Error 原生支持 cause 选项
    // 优先使用显式 message，否则 fallback 到 ERROR_META 的 userMessage
    const messageOrDefault = message ?? ERROR_META[code].userMessage;
    if (cause !== undefined) {
      super(messageOrDefault, { cause });
    } else {
      super(messageOrDefault);
    }
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  /** 元数据访问器（retryable / severity） */
  get meta(): ErrorMeta {
    return ERROR_META[this.code];
  }

  /** 是否可自动重试（AI 限流、超时等） */
  get retryable(): boolean {
    return this.meta.retryable;
  }

  /** 日志/Sentry 级别 */
  get severity(): ErrorSeverity {
    return this.meta.severity;
  }

  /**
   * 序列化为 IPC 传输结构
   *
   * 注意 cause 不序列化（可能含不可序列化的原生错误对象）
   * 注意 details 通过条件构建对象赋值，避免修改 readonly 字段
   */
  toIpcError(): IpcError {
    // 使用条件构建对象，避免对 readonly 的 IpcError.details 赋值
    // 同时 if 守卫满足 exactOptionalPropertyTypes 要求
    if (this.details !== undefined) {
      return {
        code: this.code,
        message: this.message,
        details: this.details,
      };
    }
    return {
      code: this.code,
      message: this.message,
    };
  }
}

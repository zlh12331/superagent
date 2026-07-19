// packages/shared/src/constants/errors.ts
// 统一错误码 + AppError 类：跨进程共享的错误处理基础设施
// 设计文档 §7.2（错误码枚举）、§7.3（AppError）、§7.10（用户友好提示）

/**
 * 错误码枚举
 *
 * 命名规范：{域}_{动作/状态}，全大写下划线分隔
 * 域：UNKNOWN/INTERNAL/IPC/PROJECT/CHAPTER/CHARACTER/AI/RAG/DB/PG/OLLAMA/FS
 *
 * 注意：使用 as const 派生字面量联合类型，避免 enum 的运行时对象开销
 */
export const ErrorCode = {
  // ── 通用 ──────────────────────────────────────────
  UNKNOWN: 'UNKNOWN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',

  // ── IPC 边界 ──────────────────────────────────────
  IPC_SENDER_INVALID: 'IPC_SENDER_INVALID',
  IPC_CHANNEL_NOT_FOUND: 'IPC_CHANNEL_NOT_FOUND',

  // ── 项目 ──────────────────────────────────────────
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_NAME_EXISTS: 'PROJECT_NAME_EXISTS',

  // ── 章节 ──────────────────────────────────────────
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  CHAPTER_CONTENT_TOO_LARGE: 'CHAPTER_CONTENT_TOO_LARGE',

  // ── 人物 ──────────────────────────────────────────
  CHARACTER_NOT_FOUND: 'CHARACTER_NOT_FOUND',
  CHARACTER_RELATION_CYCLE: 'CHARACTER_RELATION_CYCLE',

  // ── AI 调用 ───────────────────────────────────────
  AI_API_KEY_MISSING: 'AI_API_KEY_MISSING',
  AI_API_KEY_INVALID: 'AI_API_KEY_INVALID',
  AI_RATE_LIMITED: 'AI_RATE_LIMITED',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_MODEL_ERROR: 'AI_MODEL_ERROR',
  AI_STREAM_INTERRUPTED: 'AI_STREAM_INTERRUPTED',
  AI_CONTEXT_TOO_LARGE: 'AI_CONTEXT_TOO_LARGE',

  // ── RAG ───────────────────────────────────────────
  RAG_EMBEDDING_FAILED: 'RAG_EMBEDDING_FAILED',
  RAG_NO_RESULTS: 'RAG_NO_RESULTS',
  RAG_DOCUMENT_TOO_LARGE: 'RAG_DOCUMENT_TOO_LARGE',
  RAG_DOCUMENT_PARSE_FAILED: 'RAG_DOCUMENT_PARSE_FAILED',

  // ── 数据库 ────────────────────────────────────────
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_ERROR: 'DB_QUERY_ERROR',
  DB_CONSTRAINT_VIOLATION: 'DB_CONSTRAINT_VIOLATION',

  // ── PG 子进程 ─────────────────────────────────────
  PG_INIT_FAILED: 'PG_INIT_FAILED',
  PG_START_FAILED: 'PG_START_FAILED',
  PG_CRASHED: 'PG_CRASHED',
  PG_BACKUP_FAILED: 'PG_BACKUP_FAILED',

  // ── Ollama 本地嵌入服务 ──────────────────────────
  OLLAMA_NOT_INSTALLED: 'OLLAMA_NOT_INSTALLED',
  OLLAMA_NOT_RUNNING: 'OLLAMA_NOT_RUNNING',
  OLLAMA_MODEL_PULL_FAILED: 'OLLAMA_MODEL_PULL_FAILED',
  OLLAMA_MODEL_NOT_FOUND: 'OLLAMA_MODEL_NOT_FOUND',
  OLLAMA_TIMEOUT: 'OLLAMA_TIMEOUT',
  OLLAMA_DISK_FULL: 'OLLAMA_DISK_FULL',

  // ── 文件系统 ──────────────────────────────────────
  FS_READ_FAILED: 'FS_READ_FAILED',
  FS_WRITE_FAILED: 'FS_WRITE_FAILED',
  FS_DISK_FULL: 'FS_DISK_FULL',
} as const;

/** 错误码字面量联合类型（从 ErrorCode 派生） */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误严重级别 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'fatal';

/**
 * 错误元数据
 *
 * - userMessage：面向终端用户的中文友好提示
 * - retryable：是否可自动重试（AI 限流、超时、PG 崩溃等）
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
  UNAUTHORIZED: { userMessage: '未授权', retryable: false, severity: 'warn' },
  RATE_LIMITED: { userMessage: '操作过于频繁', retryable: true, severity: 'warn' },

  // IPC
  IPC_SENDER_INVALID: { userMessage: 'IPC 调用来源无效', retryable: false, severity: 'error' },
  IPC_CHANNEL_NOT_FOUND: { userMessage: 'IPC 通道不存在', retryable: false, severity: 'error' },

  // 项目
  PROJECT_NOT_FOUND: { userMessage: '项目不存在', retryable: false, severity: 'warn' },
  PROJECT_NAME_EXISTS: { userMessage: '项目名已存在', retryable: false, severity: 'warn' },

  // 章节
  CHAPTER_NOT_FOUND: { userMessage: '章节不存在', retryable: false, severity: 'warn' },
  CHAPTER_CONTENT_TOO_LARGE: { userMessage: '章节内容过长', retryable: false, severity: 'warn' },

  // 人物
  CHARACTER_NOT_FOUND: { userMessage: '人物不存在', retryable: false, severity: 'warn' },
  CHARACTER_RELATION_CYCLE: { userMessage: '人物关系存在循环', retryable: false, severity: 'warn' },

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

  // RAG
  RAG_EMBEDDING_FAILED: { userMessage: '嵌入向量生成失败', retryable: true, severity: 'error' },
  RAG_NO_RESULTS: { userMessage: '未检索到相关文档', retryable: false, severity: 'info' },
  RAG_DOCUMENT_TOO_LARGE: { userMessage: '文档过大，无法入库', retryable: false, severity: 'warn' },
  RAG_DOCUMENT_PARSE_FAILED: {
    userMessage: 'PDF 解析失败，请检查文件是否损坏',
    retryable: false,
    severity: 'warn',
  },

  // 数据库
  DB_CONNECTION_FAILED: { userMessage: '数据库连接失败', retryable: true, severity: 'error' },
  DB_QUERY_ERROR: { userMessage: '数据库查询错误', retryable: false, severity: 'error' },
  DB_CONSTRAINT_VIOLATION: { userMessage: '数据约束冲突', retryable: false, severity: 'error' },

  // PG 子进程
  PG_INIT_FAILED: { userMessage: '数据库初始化失败', retryable: false, severity: 'fatal' },
  PG_START_FAILED: { userMessage: '数据库启动失败', retryable: true, severity: 'error' },
  PG_CRASHED: { userMessage: '数据库异常，正在重启', retryable: true, severity: 'error' },
  PG_BACKUP_FAILED: { userMessage: '数据库备份失败', retryable: false, severity: 'warn' },

  // Ollama
  OLLAMA_NOT_INSTALLED: {
    userMessage: '未检测到 Ollama，请先安装',
    retryable: false,
    severity: 'warn',
  },
  OLLAMA_NOT_RUNNING: { userMessage: 'Ollama 服务未运行', retryable: true, severity: 'warn' },
  OLLAMA_MODEL_PULL_FAILED: { userMessage: '嵌入模型拉取失败', retryable: false, severity: 'warn' },
  OLLAMA_MODEL_NOT_FOUND: { userMessage: '嵌入模型未拉取', retryable: false, severity: 'warn' },
  OLLAMA_TIMEOUT: { userMessage: 'Ollama 调用超时', retryable: true, severity: 'warn' },
  OLLAMA_DISK_FULL: { userMessage: '磁盘空间不足', retryable: false, severity: 'warn' },

  // 文件系统
  FS_READ_FAILED: { userMessage: '文件读取失败', retryable: false, severity: 'error' },
  FS_WRITE_FAILED: { userMessage: '文件写入失败', retryable: false, severity: 'error' },
  FS_DISK_FULL: { userMessage: '磁盘空间不足', retryable: false, severity: 'warn' },
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

  /** 是否可自动重试（AI 限流、超时、PG 崩溃等） */
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

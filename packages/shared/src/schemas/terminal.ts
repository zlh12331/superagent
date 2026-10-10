// terminal.ts：终端域 IPC 契约单一真源——create/input/resize/kill 请求-响应与 output/created/exit
// 事件 payload 的 zod schema + 类型，外加 env 注入黑名单（TERMINAL_ENV_DENY_KEYS）
// 消费方：packages/shared/src/ipc/definitions.ts（IPC 定义表）——主进程据此校验入参与
// handler 返回值（src/main/ipc/register.ts、src/main/utils/wrap.ts），事件 payload 另在发送侧
// dev 校验（src/main/utils/emit-event.ts）
// 边界：只管线上形状（值域/长度/关键 env 键拒收）；cwd 存在性、shell 解析与 PTY 行为在主进程
// src/main/ipc/terminal.handler.ts 与 src/main/infra/terminal/terminal-service.ts

import { z } from 'zod';

/**
 * 渲染层禁止注入的环境变量键（P0 安全）
 *
 * 这些键决定「进程启动后命令/代码从哪里解析」，允许 IPC 侧覆盖等同于
 * 劫持终端内执行的每一条命令（渲染层被 XSS 攻破时即可 RCE）：
 * - PATH / PATHEXT / SYSTEMROOT / WINDIR / COMSPEC / PROMPT：可执行文件与系统/shell 行为解析
 * - LD_PRELOAD / LD_LIBRARY_PATH / DYLD_*：动态库加载劫持
 * - NODE_OPTIONS / NODE_PATH / PYTHONPATH / PYTHONHOME / PERL5OPT / RUBYOPT /
 *   JAVA_TOOL_OPTIONS / _JAVA_OPTIONS：解释器启动即执行注入代码
 * - PSModulePath / GIT_SSH / GIT_SSH_COMMAND / GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM /
 *   SSH_AUTH_SOCK：模块与 git/ssh 外联行为重定向
 *
 * 键名一律大写：命中判定与 Windows 大小写不敏感语义对齐（见 isTerminalEnvDenied）。
 * 主进程 TerminalService 也导入本常量，在 spawn 前对合并后的 env 再过滤一次（纵深防御）：
 * 它命中时记 warn 并跳过该键（不报错），硬拒收只发生在本 schema 的 IPC 边界。
 */
export const TERMINAL_ENV_DENY_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PROMPT',
  'PSMODULEPATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'SSH_AUTH_SOCK',
]);

/**
 * 判断环境变量键是否属于禁止注入清单
 *
 * 统一先 trim 再按大写比较：Windows 环境变量本身大小写不敏感（`path` 与 `PATH` 同义），
 * POSIX 侧这些关键变量亦全为大写惯例，故归一不会误伤普通自定义变量。
 */
export function isTerminalEnvDenied(key: string): boolean {
  return TERMINAL_ENV_DENY_KEYS.has(key.trim().toUpperCase());
}

// ── 请求-响应契约：terminal:create / input / resize / kill 的入参 schema + 响应类型与响应 schema ──

/**
 * terminal:create 入参 zod schema
 *
 * 字段语义：
 * - cwd 省略时由主进程回退用户主目录（terminal-service.ts 的 defaultHomeDir）
 * - command 省略时用默认 shell（平台默认，或用户在 settings.terminal.shell 选定的档位）
 * - env 与系统 env 合并，同名覆盖系统变量（关键变量除外，见下）
 *
 * 两处 P0 收口，均在 superRefine 中直接拒收（理由见相应守卫处）：
 * - command 非空一律拒绝（任意进程原语收口；agent 侧 terminal 工具走审批，直连
 *   terminalService.create，不经过本 schema）
 * - env 命中 TERMINAL_ENV_DENY_KEYS 即报错
 *
 * cwd/command/env 用 `.optional().transform(v => v ?? undefined)` 而非裸 `.optional()`
 * （本仓可选入参统一写法，先例 packages/shared/src/schemas/agent.ts）：z.output 形状为
 * 「必填键、值可为 undefined」，在 exactOptionalPropertyTypes 下可直接赋给消费方，
 * 无需条件展开。cols/rows 默认值 80×24 与渲染层 TERMINAL_DEFAULT_COLS/ROWS
 * （packages/shared/src/constants/defaults.ts）同值。
 */
export const TerminalCreateReqSchema = z
  .object({
    // 工作目录（可选；省略时主进程回退用户主目录）
    cwd: z
      .string()
      .min(1)
      .optional()
      .transform((v) => v ?? undefined),
    // 启动命令（只接受省略/空白——非空由下方守卫拒收，agent 工具路径不经过本 schema）
    command: z
      .string()
      .optional()
      .transform((v) => v ?? undefined),
    // 额外环境变量（与系统 env 合并、同名覆盖；键为运行期动态键名，故用 z.record 而非 z.object）
    env: z
      .record(z.string(), z.string())
      .optional()
      .transform((v) => v ?? undefined),
    cols: z.number().int().positive().max(500).default(80), // 初始列数（默认 80；上限防异常几何撑爆缓冲/渲染内存）
    rows: z.number().int().positive().max(200).default(24), // 初始行数（默认 24；上限同上）
  })
  .superRefine((cfg, ctx) => {
    // 非空 command 等于「任意进程原语」：按 shell 语义拆词后首个 token 即 spawn 的二进制，
    // 且本通道无审批（区别于 agent 侧 terminal 工具的 ask 级审批）。渲染层面板固定传
    // undefined，故直接拒收；将来若要「以指定解释器打开终端」必须走审批链，不得恢复透传。
    if (cfg.command !== undefined && cfg.command.trim().length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'terminal:create 仅允许默认 shell，不接受自定义启动命令',
      });
    }
    if (cfg.env === undefined) {
      return;
    }
    const denied = Object.keys(cfg.env).filter(isTerminalEnvDenied);
    if (denied.length > 0) {
      // 报类型化校验错误而非静默丢弃：静默丢弃会让调用方误以为注入已生效。
      // 消息一次列全被拒键（落在 error.issues：主进程日志与直接 safeParse 的调用方可见）；
      // IPC 路径上 renderer 只会看到 INVALID_INPUT 的错误码级文案（wrap.ts 不转发 issue 文本）
      ctx.addIssue({
        code: 'custom',
        path: ['env'],
        message: `终端 env 不允许覆盖系统关键环境变量：${denied.join(', ')}`,
      });
    }
  });

/** terminal:create 响应 payload */
export interface TerminalCreateRes {
  /** 终端会话唯一 id（UUID，主进程生成） */
  readonly terminalId: string;
  /** PTY 进程 pid */
  readonly pid: number;
  /**
   * 终端标题（默认 shell 名，如 powershell.exe / zsh / bash；agent 工具创建的终端为启动命令）
   *
   * 用响应回传而非渲染层自行推断：默认 shell 按平台与用户设置解析（见
   * terminal-service.ts 的 resolveShellChoice / readShellChoice），渲染层无从得知，
   * 只能展示主进程给出的真实值。TerminalTabs 直接以此渲染标签。
   */
  readonly title: string;
}

/**
 * terminal:create 响应 zod schema（R3：响应契约校验）
 *
 * 形状须与 TerminalCreateRes 手工同步（响应侧 interface 无法反向派生 schema）；
 * 漂移只在运行时报 INVALID_RESPONSE（src/main/utils/wrap.ts 以 resSchema 复核
 * handler 返回值）。
 */
export const TerminalCreateResSchema = z.object({
  terminalId: z.string().min(1),
  pid: z.number().int().positive(),
  title: z.string(),
});

/**
 * terminal:input 入参 zod schema
 *
 * data 是要写入终端的字符串，可以是用户键入的字符，也可以是粘贴的命令。
 * 主进程通过 node-pty 的 write 方法写入。
 */
export const TerminalInputReqSchema = z.object({
  terminalId: z.string().min(1), // terminal:create 返回的会话 id；未知/已关闭的 id 回 ok:false，不抛错
  data: z.string(), // 原样写入 PTY（不追加/规范化换行——回车语义由渲染层 xterm 的输入字节表达）
});

/** terminal:input 响应 payload */
export interface TerminalInputRes {
  /** 是否写入成功（终端不存在/已关闭，或 PTY 写入抛错时为 false；不抛 IPC 错误） */
  readonly ok: boolean;
}

/** terminal:input 响应 zod schema（R3：响应契约校验） */
export const TerminalInputResSchema = z.object({
  ok: z.boolean(),
});

/** terminal:resize 入参 zod schema（值来自渲染层 FitAddon 实测几何，经 ResizeObserver 防抖后上报） */
export const TerminalResizeReqSchema = z.object({
  terminalId: z.string().min(1), // terminal:create 返回的会话 id；未知/已关闭的 id 回 ok:false，不抛错
  cols: z.number().int().positive().max(500), // 与 create 同界：超出即被 IPC 层拒绝，而非截断
  rows: z.number().int().positive().max(200),
});

/**
 * terminal:resize 响应 payload
 *
 * ok 只表示「终端存在且 PTY resize 未抛错」；重排后的显示内容经 terminal:event:output
 * 异步回流（pty.onData → 输出事件），不在此响应中。
 */
export interface TerminalResizeRes {
  readonly ok: boolean;
}

/** terminal:resize 响应 zod schema（R3：响应契约校验） */
export const TerminalResizeResSchema = z.object({
  ok: z.boolean(),
});

/** terminal:kill 入参 zod schema */
export const TerminalKillReqSchema = z.object({
  terminalId: z.string().min(1), // terminal:create 返回的会话 id；未知 id 回 ok:false，不抛错
});

/**
 * terminal:kill 响应 payload
 *
 * ok 只表示「终端存在且已调用 PTY kill」——kill 内部异常被吞（仅记日志）后仍返回 true；
 * 进程真正终止经 terminal:event:exit 异步通知。
 */
export interface TerminalKillRes {
  readonly ok: boolean;
}

/** terminal:kill 响应 zod schema（R3：响应契约校验） */
export const TerminalKillResSchema = z.object({
  ok: z.boolean(),
});

/**
 * terminal:event:output 流式事件 payload
 *
 * 主进程监听 node-pty 的 onData 事件，每次有输出时推送此 payload。
 * data 是原始 ANSI 转义序列字符串，渲染层用 xterm.js 直接 write。
 *
 * 注意：data 可能包含多条 ANSI 命令拼接，渲染层不应拆分。
 * 同一通道承载全部终端：订阅回调须按 payload 的 terminalId 过滤。
 * 高频通道，但通道名不含 ':stream:'，故 dev 发送侧校验对每帧全量执行
 * （src/main/utils/emit-event.ts 的 shouldValidate）；改本 schema 需留意该开销。
 */
export interface TerminalOutputEventPayload {
  readonly terminalId: string;
  /** 终端原始输出（含 ANSI 转义序列，未解码） */
  readonly data: string;
}

/**
 * terminal:event:created 流式事件 payload
 *
 * 终端创建成功后由主进程推送（含 Agent 工具创建的终端）。
 * 比 TerminalCreateRes 多带 cwd/cols/rows：create 响应只回发起方需要的 terminalId/pid/title，
 * 本事件面向所有订阅方广播，带登记终端所需的完整元数据。
 */
export interface TerminalCreatedEventPayload {
  readonly terminalId: string;
  /** 终端标题（启动命令或默认 shell 名） */
  readonly title: string;
  /** 进程 id */
  readonly pid: number;
  /** 工作目录（实际 spawn 使用的目录，非请求原样透传） */
  readonly cwd: string;
  /** 初始列数 */
  readonly cols: number;
  /** 初始行数 */
  readonly rows: number;
}

/**
 * terminal:event:exit 流式事件 payload
 *
 * 终端进程退出时推送（无论正常退出还是被 kill）。
 * exitCode: 0 表示正常退出；非 0 表示异常退出
 * signal: 被信号中断时携带信号名（如 'SIGTERM'）
 *
 * 由 pty.onExit 回调发出（同一回调里主进程随即把该终端移出会话表）——收到后对它的
 * input/resize/kill 一律 ok:false。
 */
export interface TerminalExitEventPayload {
  readonly terminalId: string;
  /** 进程退出码（0 正常退出） */
  readonly exitCode: number;
  /** 被信号中断时的信号名（如 'SIGTERM'；node-pty 给的是数字信号编号，主进程已转名） */
  readonly signal?: string;
}

// ── 事件 payload zod schema：主进程发送侧 dev 校验（envelope 级，data 原样透传），
//    经 packages/shared/src/ipc/definitions.ts 的 withPayload 挂到定义表 ──

/** terminal:event:output payload schema（data 原样透传，仅 envelope 校验） */
export const TerminalOutputEventPayloadSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});

/** terminal:event:created payload schema（与上游 TerminalCreatedEventPayload 手工同形） */
export const TerminalCreatedEventPayloadSchema = z.object({
  terminalId: z.string().min(1),
  title: z.string(),
  pid: z.number().int().positive(),
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** terminal:event:exit payload schema（与上游 TerminalExitEventPayload 手工同形） */
export const TerminalExitEventPayloadSchema = z.object({
  terminalId: z.string().min(1),
  exitCode: z.number().int(),
  signal: z.string().optional(),
});

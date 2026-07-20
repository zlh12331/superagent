// src/main/infra/pg/pg-types.ts
// PostgreSQL 子进程类型定义
// 设计文档 §1.2 决策 3 + §7.8 健康监控

/**
 * PG 进程状态
 *
 * - stopped：未启动或已停止
 * - starting：spawn 后等待端口就绪
 * - running：端口探活成功，可接收连接
 * - crashed：进程意外退出（非 0 退出码）
 * - stopping：收到 stop 请求，等待 exit
 * - restarting：PgSupervisor 自动重启中（指数退避等待期间）
 * - dead：重启 3 次均失败，进入不可恢复状态
 */
export type PgStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'crashed'
  | 'stopping'
  | 'restarting'
  | 'dead';

/**
 * PG 控制器配置
 *
 * dev 环境：binaryPath 用系统 PATH 中的 'postgres'
 * 生产环境：binaryPath 指向 resources/pg/bin/postgres.exe
 */
export interface PgConfig {
  /** postgres 可执行文件路径（dev: 'postgres'，prod: 绝对路径） */
  readonly binaryPath: string;
  /** 数据目录（%APPDATA%/<AppName>/pgdata/） */
  readonly dataDir: string;
  /** 监听端口（固定 5433，避免与系统 PG 冲突） */
  readonly port: number;
}

/**
 * 状态变更事件 payload
 *
 * extra 字段语义随 status 不同：
 * - running：附带 pid
 * - crashed：附带 code（PG 进程退出码）
 * - restarting：附带 attempt（本次重启为第几次尝试，1-based）
 */
export interface PgStatusChangeEvent {
  readonly status: PgStatus;
  readonly pid?: number;
  readonly code?: number;
  /** PgSupervisor 重启尝试次数（1-based，仅 'restarting' 状态有意义） */
  readonly attempt?: number;
}

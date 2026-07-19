// packages/shared/src/constants/pg-versions.ts
// PostgreSQL 版本枚举（设计文档 §6.5 AGE 兼容性策略）
// Phase 4b 实际使用；Phase 4a 仅声明，避免散落硬编码

/** PostgreSQL 版本（AGE 兼容性策略：默认 18.4，失败降级 17.10） */
export const POSTGRES_VERSIONS = {
  /** 默认版本（AGE 通常滞后 PG 主版本 1-2 个 minor） */
  V18_4: '18.4',
  /** AGE 兼容降级版本 */
  V17_10: '17.10',
} as const;

export type PostgresVersion = (typeof POSTGRES_VERSIONS)[keyof typeof POSTGRES_VERSIONS];

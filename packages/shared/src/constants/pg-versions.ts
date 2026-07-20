// packages/shared/src/constants/pg-versions.ts
// PostgreSQL 版本枚举（设计文档 §6.5 AGE 兼容性策略）
// Phase 4b 实际使用；Phase 4a 仅声明，避免散落硬编码
//
// 版本历史：
// - 2026-07 之前：默认 18.4（EnterpriseDB 便携版，MSVC 编译，不含 AGE/pgvector）
// - 2026-07 起：默认 17.2-mingw（ShanGor/apache-age-windows 预编译包）
//   原因：AGE 官方从未发布 Windows 二进制，EnterpriseDB 便携版不含 age.dll
//   ShanGor 包基于 MSYS2-MINGW64 编译的 PG 17.2 + AGE 1.5.0 + pgvector 0.8.0 三合一
//   目录名带 -mingw 后缀以区分 EnterpriseDB MSVC 编译版（ABI 不兼容，不可混用）

/** PostgreSQL 版本（AGE 兼容性策略：默认 17.2-mingw，含 AGE 1.5.0 + pgvector 0.8.0） */
export const POSTGRES_VERSIONS = {
  /**
   * 默认版本（ShanGor/apache-age-windows 预编译包）
   *
   * - PG 17.2 + AGE 1.5.0 + pgvector 0.8.0 三合一
   * - MSYS2-MINGW64 编译，目录名带 -mingw 后缀
   * - 来源：https://github.com/ShanGor/apache-age-windows/releases/tag/PG17%2Fv1.5.0-rc0
   */
  V17_2_MINGW: '17.2-mingw',
  /**
   * 旧版 EnterpriseDB 便携版（仅作历史参考，已弃用）
   *
   * - EnterpriseDB MSVC 编译，不含 AGE / pgvector 扩展二进制
   * - 保留常量以兼容旧数据目录检测（pgdata-18.4）
   * - 不再用于新启动
   */
  V18_4: '18.4',
} as const;

export type PostgresVersion = (typeof POSTGRES_VERSIONS)[keyof typeof POSTGRES_VERSIONS];

// prisma.config.ts
// Prisma 7 配置文件（取代 schema.prisma 中的 datasource.url）
// 文档：https://pris.ly/d/config-datasource
//
// Prisma 7 起连接 URL 不再写在 schema.prisma，改由此文件提供。
// - prisma generate：不需要真实 URL，但需要 prisma.config.ts 存在
// - prisma migrate diff：从此处读取 datasource.url 生成 SQL
// - PrismaClient 运行时连接：Phase 4b 通过 adapter 注入（设计文档 §4.3）

import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

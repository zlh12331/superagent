// drizzle.config.ts：drizzle-kit CLI 配置——从 src/main/infra/storage/schema.ts（全库唯一真源）派生 SQL 迁移到 drizzle/
// 应用运行时的库路径真源是 src/main/infra/storage/db.ts 的 getDbPath()，与本文件的 dbCredentials 无关

import { defineConfig } from 'drizzle-kit';

/** drizzle-kit CLI 按根目录同名约定读取；只服务命令行迁移链（generate / check / push / migrate），应用启动不加载 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/infra/storage/schema.ts', // 迁移唯一输入：加表/改列只改它再 generate，禁手写第二份建表 SQL
  out: './drizzle', // 迁移产物入仓；打包时经 extraResources 复制到 process.resourcesPath/drizzle，由 initDb 的 migrator 读取
  dbCredentials: {
    url: '.electron-user-data/sessions.db', // dev 库路径：须与 src/main/index.ts 未打包时的 userData 重定向同步，否则 push/migrate 会连到另一个空库
  },
  verbose: true, // 仅对 push 生效：打印将执行的 SQL
  strict: true, // 仅对 push 生效：逐条确认后才执行
});

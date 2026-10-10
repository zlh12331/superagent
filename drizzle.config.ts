import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/infra/storage/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: '.electron-user-data/sessions.db',
  },
  verbose: true,
  strict: true,
});

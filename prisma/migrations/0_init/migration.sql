-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- 注意：CREATE EXTENSION age / pgvector 已从此 migration 移除
-- 原因：便携版 PG 18.4 不含 age / pgvector 扩展二进制
-- 扩展加载由 db-init.ts 的 ensureAgeExtension / ensureHnswIndex 在运行时按需加载，
-- 失败则降级（AGE 不可用 / HNSW 索引跳过），不阻塞应用启动
-- 硬性约束：migration.sql 必须移除 CREATE EXTENSION "age"（pgvector 容器兼容性）

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DRAFT');

-- CreateEnum
CREATE TYPE "ChapterStatus" AS ENUM ('DRAFT', 'OUTLINE', 'WRITING', 'COMPLETED', 'REVISION');

-- CreateEnum
CREATE TYPE "CharacterRole" AS ENUM ('PROTAGONIST', 'ANTAGONIST', 'SUPPORTING', 'MINOR');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant', 'system');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "genre" VARCHAR(50),
    "cover" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volumes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "volumeId" TEXT,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ChapterStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "avatar" TEXT,
    "role" "CharacterRole" NOT NULL DEFAULT 'SUPPORTING',
    "description" TEXT,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worldviews" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT,
    "type" VARCHAR(50),
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worldviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "model" VARCHAR(50),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "source" VARCHAR(500),
    "mimeType" VARCHAR(100),
    "chunksCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_document_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    -- 注意：embedding 字段类型从 halfvec(2048) 改为 TEXT
    -- 原因：便携版 PG 18.4 不含 pgvector 扩展，halfvec 类型不可用
    -- RAG 向量字段在 pgvector 扩展加载后由 ensureHnswIndex 通过 ALTER COLUMN 改回 halfvec(2048)
    -- 当前 TEXT 类型作为占位，不阻塞应用启动（RAG 检索功能在 pgvector 加载前不可用）
    "embedding" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_settings" (
    "projectId" TEXT NOT NULL,
    "aiModel" VARCHAR(50) NOT NULL DEFAULT 'deepseek-v4-flash',
    "aiTemperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "aiMaxTokens" INTEGER NOT NULL DEFAULT 4096,
    "ragEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ragTopK" INTEGER NOT NULL DEFAULT 5,
    "ragThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "customPrompts" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "model" VARCHAR(50) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "volumes_projectId_idx" ON "volumes"("projectId");

-- CreateIndex
CREATE INDEX "chapters_projectId_idx" ON "chapters"("projectId");

-- CreateIndex
CREATE INDEX "chapters_volumeId_idx" ON "chapters"("volumeId");

-- CreateIndex
CREATE INDEX "chapters_status_sortOrder_idx" ON "chapters"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "characters_projectId_idx" ON "characters"("projectId");

-- CreateIndex
CREATE INDEX "characters_role_idx" ON "characters"("role");

-- CreateIndex
CREATE INDEX "worldviews_projectId_idx" ON "worldviews"("projectId");

-- CreateIndex
CREATE INDEX "worldviews_parentId_idx" ON "worldviews"("parentId");

-- CreateIndex
CREATE INDEX "chat_sessions_projectId_idx" ON "chat_sessions"("projectId");

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_createdAt_idx" ON "chat_messages"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "rag_documents_projectId_idx" ON "rag_documents"("projectId");

-- CreateIndex
CREATE INDEX "rag_document_chunks_documentId_idx" ON "rag_document_chunks"("documentId");

-- CreateIndex
CREATE INDEX "ai_usage_logs_createdAt_idx" ON "ai_usage_logs"("createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_logs_provider_model_idx" ON "ai_usage_logs"("provider", "model");

-- AddForeignKey
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "volumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worldviews" ADD CONSTRAINT "worldviews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worldviews" ADD CONSTRAINT "worldviews_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "worldviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_document_chunks" ADD CONSTRAINT "rag_document_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "rag_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


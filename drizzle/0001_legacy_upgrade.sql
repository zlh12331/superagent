-- Legacy upgrade: 老库（手写 schema-sql.ts 时代）升级到 drizzle 约束体系
-- ──────────────────────────────────────────────────────────────
-- 背景：0000_baseline 全量 IF NOT EXISTS（建表+索引幂等）。老库跑 0000 时
-- 「表已存在」全部跳过，意味着老库永远拿不到领域约束（CHECK / UNIQUE）。
--
-- 本迁移把「缺约束且无表外键引用（重建安全）」的 5 张表做数据保真重建：
--   messages       → chk_messages_role
--   turns          → uq_turns_turn_id
--   skills         → chk_skills_source
--   cron_tasks     → chk_cron_tasks_enabled
--   runtime_models → chk_runtime_models_is_enabled
--
-- 约束策略（与 schema.ts 顶部注释一致）：
--   - sessions 被 messages/turns/goals/token_usage 外键引用，重建牵连大 → 放弃补 CHECK
--   - goals.status / tasks.kind+status 为演进枚举 → 策略上不加 DB CHECK
--
-- 注意事项：
--   - 每条 ALTER→CREATE→INSERT→DROP 是整库事务内的一次大迁移，中途失败整体回滚
--   - INSERT ... SELECT 显式列清单，与旧表列序无关，数据完整迁移
--   - 表重建后索引一并重建（IF NOT EXISTS 幂等，对新库/老库均安全）
--   - 本迁移对「已是新 schema 的库」执行 = 同定义重建，无副作用
-- ──────────────────────────────────────────────────────────────

ALTER TABLE `messages` RENAME TO `messages_legacy_v1`;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_messages_role" CHECK("messages"."role" IN ('user','assistant','tool','system'))
);
--> statement-breakpoint
INSERT INTO `messages` (`id`,`session_id`,`turn_id`,`seq`,`role`,`content`,`created_at`)
	SELECT `id`,`session_id`,`turn_id`,`seq`,`role`,`content`,`created_at` FROM `messages_legacy_v1`;
--> statement-breakpoint
DROP TABLE `messages_legacy_v1`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_session_seq` ON `messages` (`session_id`,`seq`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_turn` ON `messages` (`turn_id`);
--> statement-breakpoint

ALTER TABLE `turns` RENAME TO `turns_legacy_v1`;
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`model_id` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `turns` (`id`,`turn_id`,`session_id`,`seq`,`model_id`,`status`,`input_tokens`,`output_tokens`,`total_tokens`,`duration_ms`,`created_at`)
	SELECT `id`,`turn_id`,`session_id`,`seq`,`model_id`,`status`,`input_tokens`,`output_tokens`,`total_tokens`,`duration_ms`,`created_at` FROM `turns_legacy_v1`;
--> statement-breakpoint
DROP TABLE `turns_legacy_v1`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_turns_turn_id` ON `turns` (`turn_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turns_session_seq` ON `turns` (`session_id`,`seq`);
--> statement-breakpoint

ALTER TABLE `skills` RENAME TO `skills_legacy_v1`;
--> statement-breakpoint
CREATE TABLE `skills` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`prompt` text NOT NULL,
	`source` text DEFAULT 'learned' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_skills_source" CHECK("skills"."source" IN ('learned','builtin'))
);
--> statement-breakpoint
INSERT INTO `skills` (`name`,`description`,`prompt`,`source`,`created_at`)
	SELECT `name`,`description`,`prompt`,`source`,`created_at` FROM `skills_legacy_v1`;
--> statement-breakpoint
DROP TABLE `skills_legacy_v1`;
--> statement-breakpoint

ALTER TABLE `cron_tasks` RENAME TO `cron_tasks_legacy_v1`;
--> statement-breakpoint
CREATE TABLE `cron_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`expression` text NOT NULL,
	`description` text NOT NULL,
	`next_fire_at` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_cron_tasks_enabled" CHECK("cron_tasks"."enabled" IN (0,1))
);
--> statement-breakpoint
INSERT INTO `cron_tasks` (`id`,`session_id`,`expression`,`description`,`next_fire_at`,`enabled`,`created_at`)
	SELECT `id`,`session_id`,`expression`,`description`,`next_fire_at`,`enabled`,`created_at` FROM `cron_tasks_legacy_v1`;
--> statement-breakpoint
DROP TABLE `cron_tasks_legacy_v1`;
--> statement-breakpoint

ALTER TABLE `runtime_models` RENAME TO `runtime_models_legacy_v1`;
--> statement-breakpoint
CREATE TABLE `runtime_models` (
	`model_id` text PRIMARY KEY NOT NULL,
	`provider_kind` text NOT NULL,
	`base_url` text,
	`display_name` text,
	`is_enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_runtime_models_is_enabled" CHECK("runtime_models"."is_enabled" IN (0,1))
);
--> statement-breakpoint
INSERT INTO `runtime_models` (`model_id`,`provider_kind`,`base_url`,`display_name`,`is_enabled`,`created_at`)
	SELECT `model_id`,`provider_kind`,`base_url`,`display_name`,`is_enabled`,`created_at` FROM `runtime_models_legacy_v1`;
--> statement-breakpoint
DROP TABLE `runtime_models_legacy_v1`;
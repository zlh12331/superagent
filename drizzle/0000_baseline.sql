CREATE TABLE IF NOT EXISTS `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cron_tasks` (
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
CREATE TABLE IF NOT EXISTS `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`condition` text NOT NULL,
	`status` text NOT NULL,
	`iterations` integer DEFAULT 0 NOT NULL,
	`last_reason` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_goals_session` ON `goals` (`session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
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
CREATE INDEX IF NOT EXISTS `idx_messages_session_seq` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_turn` ON `messages` (`turn_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`is_default` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_prompts_role` ON `prompts` (`role`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runtime_models` (
	`model_id` text PRIMARY KEY NOT NULL,
	`provider_kind` text NOT NULL,
	`base_url` text,
	`display_name` text,
	`is_enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_runtime_models_is_enabled" CHECK("runtime_models"."is_enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`working_dir` text NOT NULL,
	`last_run_status` text DEFAULT 'idle' NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_sessions_last_run_status" CHECK("sessions"."last_run_status" IN ('idle','running','interrupted'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_updated_at` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skills` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`prompt` text NOT NULL,
	`source` text DEFAULT 'learned' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "chk_skills_source" CHECK("skills"."source" IN ('learned','builtin'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `token_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`model_id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`cache_read_tokens` integer,
	`reasoning_tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_token_usage_created_at` ON `token_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `turns` (
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
CREATE INDEX IF NOT EXISTS `idx_turns_session_seq` ON `turns` (`session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_turns_turn_id` ON `turns` (`turn_id`);
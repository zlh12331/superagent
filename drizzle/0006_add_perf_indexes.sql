CREATE INDEX `idx_sessions_pinned_updated` ON `sessions` (`pinned`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_working_dir` ON `sessions` (`working_dir`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_turns_created_at` ON `turns` (`created_at`);
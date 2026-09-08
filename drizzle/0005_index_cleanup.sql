DROP INDEX `idx_turns_session_seq`;--> statement-breakpoint
CREATE INDEX `idx_token_usage_session_id` ON `token_usage` (`session_id`);
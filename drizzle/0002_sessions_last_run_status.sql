-- sessions 领域约束（触发器实现 CHECK，替代表重建）
-- ──────────────────────────────────────────────────────────────
-- 背景：sessions 被 messages/turns/token_usage/goals 外键引用，
-- 重建表会触发 ON DELETE CASCADE 清空全部会话数据（不可行）。
-- SQLite 也无法 ALTER TABLE ADD CHECK。故用 BEFORE INSERT/UPDATE
-- 触发器实现 last_run_status 枚举校验，语义等同 CHECK。
--
-- 备注：schema.ts 中 sessions.last_run_status 使用 $type<RunStatus>()
-- 应用层约束 + 本触发器 DB 层兜底（双保险，外部写入也无法绕过）。
-- ──────────────────────────────────────────────────────────────

CREATE TRIGGER IF NOT EXISTS trg_sessions_last_run_status_insert
BEFORE INSERT ON `sessions`
FOR EACH ROW
BEGIN
	SELECT CASE
		WHEN NEW.last_run_status NOT IN ('idle','running','interrupted')
		THEN RAISE(ABORT, 'CHECK constraint failed: chk_sessions_last_run_status')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_sessions_last_run_status_update
BEFORE UPDATE OF `last_run_status` ON `sessions`
FOR EACH ROW
BEGIN
	SELECT CASE
		WHEN NEW.last_run_status NOT IN ('idle','running','interrupted')
		THEN RAISE(ABORT, 'CHECK constraint failed: chk_sessions_last_run_status')
	END;
END;
-- 会话内序号唯一性（数据完整性补齐）
-- ──────────────────────────────────────────────────────────────
-- 背景：messages.seq / turns.seq 是会话内业务游标，此前仅由应用层事务
-- （startSeq=messageCount、序号递增）保证不重复。并发/重试写入同 seq 会
-- 产生双行导致会话历史与 transcript 错乱——由 UNIQUE 索引在 DB 层兜底。
--
-- 实现说明：UNIQUE 约束可用独立唯一索引表达，无需重建表（SQLite 对
-- 已有表加 UNIQUE = CREATE UNIQUE INDEX）。IF NOT EXISTS 幂等。
--
-- 前提假设：既有数据的 (session_id, seq) 无重复（SessionService 事务
-- 递增写入保证）；若有历史重复会使本迁移失败（质询数据，恰是意图）。
-- ──────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS `uq_messages_session_seq` ON `messages` (`session_id`,`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_turns_session_seq` ON `turns` (`session_id`,`seq`);
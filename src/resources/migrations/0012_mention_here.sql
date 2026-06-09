-- 0012_mention_here.sql — per-source @here mention toggle (mirrors mention_everyone).

ALTER TABLE sources ADD COLUMN mention_here INTEGER NOT NULL DEFAULT 0;

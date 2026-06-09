-- 0005_model.sql — Translation provider config and usage accounting.

CREATE TABLE IF NOT EXISTS model_config (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  role                 TEXT NOT NULL UNIQUE CHECK (role IN ('primary', 'fallback')),
  provider             TEXT NOT NULL CHECK (provider IN ('gemini', 'nvidia-nim')),
  model                TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  target_lang          TEXT NOT NULL DEFAULT 'ko',
  prompt_log_max_bytes INTEGER NOT NULL DEFAULT 32768 CHECK (prompt_log_max_bytes >= 0),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('primary', 'fallback')),
  provider      TEXT NOT NULL CHECK (provider IN ('gemini', 'nvidia-nim')),
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  error         TEXT,
  prompt_log    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initial UI defaults only. Runtime model settings live in model_config and remain mutable after migration.
INSERT OR IGNORE INTO model_config (role, provider, model, enabled)
VALUES
  ('primary', 'gemini', 'gemini-2.5-flash', 1),
  ('fallback', 'nvidia-nim', 'nvidia/llama-3.3-nemotron-super-49b-v1', 0);

CREATE INDEX IF NOT EXISTS idx_model_usage_role_created ON model_usage(role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_provider_created ON model_usage(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at DESC);

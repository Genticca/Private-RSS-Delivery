-- 0009_reseed_model.sql — Align default model rows with the current product decision.

INSERT INTO model_config (role, provider, model, enabled, updated_at)
VALUES
  ('primary', 'gemini', 'gemini-3.1-flash-lite', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('fallback', 'nvidia-nim', 'qwen3-coder-480b-a35b-instruct', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(role) DO UPDATE SET
  provider = excluded.provider,
  model = excluded.model,
  updated_at = excluded.updated_at;

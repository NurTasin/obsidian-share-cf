CREATE TABLE IF NOT EXISTS note_assets (
  vault_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  original_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, note_id, asset_id),
  FOREIGN KEY (vault_id, note_id) REFERENCES notes(vault_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_assets_note ON note_assets(vault_id, note_id);

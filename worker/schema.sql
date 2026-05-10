CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  client_name TEXT,
  client_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  share_id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, id),
  FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_share_id ON notes(share_id);
CREATE INDEX IF NOT EXISTS idx_notes_vault_path ON notes(vault_id, path);

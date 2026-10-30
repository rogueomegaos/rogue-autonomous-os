-- One-time/short-lived download grants are stored as hashes, never as raw bearer values.
CREATE TABLE IF NOT EXISTS order_download_grants (
  grant_hash TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_order_download_grants_order
  ON order_download_grants(order_id);

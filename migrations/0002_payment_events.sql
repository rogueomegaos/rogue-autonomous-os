-- Payment webhook idempotency ledger. Raw payment secrets are never stored here.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL,
  event_status TEXT NOT NULL CHECK(event_status IN ('paid', 'failed', 'cancelled', 'refunded', 'paid_duplicate')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_events_order_created
  ON payment_events(order_id, created_at DESC);

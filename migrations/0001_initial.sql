PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  source_type TEXT NOT NULL CHECK(source_type IN ('website', 'rss', 'api')),
  url TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered', 'paused', 'error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'unclassified',
  legitimacy_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK(legitimacy_status IN ('unverified', 'pending_review', 'verified', 'rejected')),
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK(price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'MYR',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'archived')),
  asset_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_email TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  total_minor INTEGER NOT NULL CHECK(total_minor >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'paid', 'failed', 'refunded', 'cancelled')),
  payment_provider TEXT,
  provider_reference TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_provider_reference
  ON orders(payment_provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS creative_jobs (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_contact TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  deliverable_type TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'brief_received'
    CHECK(status IN ('brief_received', 'quoted', 'in_progress', 'review', 'completed', 'cancelled')),
  quoted_minor INTEGER CHECK(quoted_minor IS NULL OR quoted_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'MYR',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'system',
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'error', 'critical')),
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_opportunities_status_score
  ON opportunities(legitimacy_status, score DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_status
  ON creative_jobs(status, created_at DESC);

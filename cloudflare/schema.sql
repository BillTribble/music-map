-- Cloudflare D1 Schema for Bill Tribble Music Map (Stars, Downloads, Requests & Email Anti-Spam)

CREATE TABLE IF NOT EXISTS music_map_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  track_title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (event_type IN ('star', 'unstar', 'download', 'request')),
  format TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  session_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_mm_events_created ON music_map_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mm_events_track ON music_map_events(track_id, event_type);
CREATE INDEX IF NOT EXISTS idx_mm_events_ip_window ON music_map_events(ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS music_map_track_stars (
  track_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  track_title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (track_id, session_hash)
);

CREATE INDEX IF NOT EXISTS idx_mm_stars_track ON music_map_track_stars(track_id);

CREATE TABLE IF NOT EXISTS music_map_track_totals (
  track_id TEXT PRIMARY KEY,
  track_title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  active_stars INTEGER NOT NULL DEFAULT 0,
  total_star_events INTEGER NOT NULL DEFAULT 0,
  total_downloads INTEGER NOT NULL DEFAULT 0,
  mp3_downloads INTEGER NOT NULL DEFAULT 0,
  flac_downloads INTEGER NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  last_starred_at TEXT,
  last_downloaded_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS music_map_email_dedup (
  dedup_key TEXT PRIMARY KEY,
  sent_at_epoch INTEGER NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mm_dedup_epoch ON music_map_email_dedup(sent_at_epoch);

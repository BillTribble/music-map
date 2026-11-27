-- Cloudflare D1 Schema for Bill Tribble Music Map (Stars, Downloads, Qualified Plays, Requests & Email Anti-Spam)

CREATE TABLE IF NOT EXISTS music_map_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  track_title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (event_type IN ('star', 'unstar', 'download', 'request', 'play')),
  format TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  play_id TEXT NOT NULL DEFAULT '',
  listened_sec REAL NOT NULL DEFAULT 0,
  session_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_mm_events_created ON music_map_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mm_events_track ON music_map_events(track_id, event_type);
CREATE INDEX IF NOT EXISTS idx_mm_events_ip_window ON music_map_events(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mm_events_play_lookup ON music_map_events(track_id, session_hash, play_id);
CREATE INDEX IF NOT EXISTS idx_mm_events_session ON music_map_events(session_hash);
CREATE INDEX IF NOT EXISTS idx_mm_events_owner_created ON music_map_events(is_owner, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS music_map_owner_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS music_map_track_stars (
  track_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  track_title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  is_owner INTEGER NOT NULL DEFAULT 0,
  starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (track_id, session_hash)
);

CREATE INDEX IF NOT EXISTS idx_mm_stars_track ON music_map_track_stars(track_id);
CREATE INDEX IF NOT EXISTS idx_mm_stars_track_owner ON music_map_track_stars(track_id, is_owner);

CREATE TABLE IF NOT EXISTS music_map_track_listeners (
  track_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  first_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  play_count INTEGER NOT NULL DEFAULT 1,
  is_owner INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, session_hash)
);

CREATE INDEX IF NOT EXISTS idx_mm_listeners_track ON music_map_track_listeners(track_id);
CREATE INDEX IF NOT EXISTS idx_mm_listeners_track_owner ON music_map_track_listeners(track_id, is_owner);

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
  total_plays INTEGER NOT NULL DEFAULT 0,
  manual_plays INTEGER NOT NULL DEFAULT 0,
  autoplay_plays INTEGER NOT NULL DEFAULT 0,
  unique_listeners INTEGER NOT NULL DEFAULT 0,
  total_listen_sec REAL NOT NULL DEFAULT 0,
  last_starred_at TEXT,
  last_downloaded_at TEXT,
  last_played_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS music_map_email_dedup (
  dedup_key TEXT PRIMARY KEY,
  sent_at_epoch INTEGER NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mm_dedup_epoch ON music_map_email_dedup(sent_at_epoch);

CREATE TABLE IF NOT EXISTS music_map_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  track_title TEXT NOT NULL,
  era TEXT NOT NULL DEFAULT '',
  requester_email TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  session_hash TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_mm_requests_created ON music_map_requests(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mm_requests_track ON music_map_requests(track_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pulse_presets (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);



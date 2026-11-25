-- Migration 0002: Qualified Play Tracking, Unique Listeners & Weighted Popularity Rollups
-- Losslessly widens music_map_events CHECK constraint to include 'play' (+ play_id & listened_sec),
-- adds music_map_track_listeners, and adds play rollup columns to music_map_track_totals.

DROP TABLE IF EXISTS music_map_events_v2;

CREATE TABLE music_map_events_v2 (
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
  ip_hash TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO music_map_events_v2 (
  id, track_id, track_title, era, event_type, format, source,
  session_hash, ip_hash, country, referrer, note, created_at
)
SELECT
  id, track_id, track_title, era, event_type, format, source,
  session_hash, ip_hash, country, referrer, note, created_at
FROM music_map_events;

DROP TABLE music_map_events;

ALTER TABLE music_map_events_v2 RENAME TO music_map_events;

CREATE INDEX IF NOT EXISTS idx_mm_events_created ON music_map_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mm_events_track ON music_map_events(track_id, event_type);
CREATE INDEX IF NOT EXISTS idx_mm_events_ip_window ON music_map_events(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mm_events_play_lookup ON music_map_events(track_id, session_hash, play_id);

CREATE TABLE IF NOT EXISTS music_map_track_listeners (
  track_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  first_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  play_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (track_id, session_hash)
);

CREATE INDEX IF NOT EXISTS idx_mm_listeners_track ON music_map_track_listeners(track_id);

DROP TABLE IF EXISTS music_map_track_totals_v2;

CREATE TABLE music_map_track_totals_v2 (
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

INSERT INTO music_map_track_totals_v2 (
  track_id, track_title, era, active_stars, total_star_events,
  total_downloads, mp3_downloads, flac_downloads, total_requests,
  last_starred_at, last_downloaded_at, updated_at
)
SELECT
  track_id, track_title, era, active_stars, total_star_events,
  total_downloads, mp3_downloads, flac_downloads, total_requests,
  last_starred_at, last_downloaded_at, updated_at
FROM music_map_track_totals;

DROP TABLE music_map_track_totals;

ALTER TABLE music_map_track_totals_v2 RENAME TO music_map_track_totals;

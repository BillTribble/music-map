-- Migration 0003: Private Music Map Track Requests Table (Email + Optional Note)
-- Strictly private table: never exposed on public /api/hotlist or any unauthenticated GET endpoint.

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

-- Migration 0004: Owner Session Partitioning (is_owner + music_map_owner_sessions)
-- Separates owner device activity ('Only my stats') from public visitor stats ('Visitors')
-- without discarding owner plays, stars, downloads, or listen time.

CREATE TABLE IF NOT EXISTS music_map_owner_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

ALTER TABLE music_map_events ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE music_map_track_stars ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE music_map_track_listeners ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mm_events_session ON music_map_events(session_hash);
CREATE INDEX IF NOT EXISTS idx_mm_events_owner_created ON music_map_events(is_owner, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mm_stars_track_owner ON music_map_track_stars(track_id, is_owner);
CREATE INDEX IF NOT EXISTS idx_mm_listeners_track_owner ON music_map_track_listeners(track_id, is_owner);

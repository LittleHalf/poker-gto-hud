-- Poker GTO HUD — Postgres schema (Supabase / Postgres alternative to SQLite)
-- Use this when deploying to a cloud environment via Manufact.

-- Players: identity registry
CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,   -- SHA-256 of display_name
  name       TEXT NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen  TIMESTAMPTZ DEFAULT NOW(),
  total_hands INTEGER DEFAULT 0,
  llm_notes  TEXT                -- Claude-generated opponent summary
);

-- Stats: running aggregate counters (fraction stored as num/denom for accuracy)
CREATE TABLE IF NOT EXISTS stats (
  player_id          TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  vpip_num           INTEGER DEFAULT 0,
  vpip_denom         INTEGER DEFAULT 0,
  pfr_num            INTEGER DEFAULT 0,
  pfr_denom          INTEGER DEFAULT 0,
  af_bets            INTEGER DEFAULT 0,   -- bets + raises
  af_calls           INTEGER DEFAULT 0,   -- calls (AF = af_bets / af_calls)
  cbet_fold_num      INTEGER DEFAULT 0,
  cbet_fold_denom    INTEGER DEFAULT 0,
  fold_to_3bet_num   INTEGER DEFAULT 0,
  fold_to_3bet_denom INTEGER DEFAULT 0,
  wtsd_num           INTEGER DEFAULT 0,   -- went to showdown
  wtsd_denom         INTEGER DEFAULT 0,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Hand history: raw log + hero decision metadata
CREATE TABLE IF NOT EXISTS hand_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  played_at     TIMESTAMPTZ DEFAULT NOW(),
  raw_log       JSONB NOT NULL,      -- array of GameEvents
  hero_position TEXT,               -- BTN/CO/HJ/SB/BB/UTG
  hero_cards    TEXT,               -- "Ah Kd"
  board         TEXT,               -- "Qs 7d 2c 9h"
  hero_decision TEXT,               -- FOLD/CALL/RAISE
  recommended   TEXT,               -- what adviser said
  lambda_used   REAL,
  ev_loss       REAL                -- post-hoc calc, nullable
);

-- Sessions: game tab registry
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url  TEXT NOT NULL,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  status      TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended'))
);

-- Hand events: raw event stream
CREATE TABLE IF NOT EXISTS hand_events (
  id         BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp  BIGINT NOT NULL,
  payload    JSONB NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_stats_player ON stats(player_id);
CREATE INDEX IF NOT EXISTS idx_hand_history_played ON hand_history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_hand_events_session ON hand_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen DESC);

-- Computed player tag view (not stored — derived from stats at read time)
CREATE OR REPLACE VIEW player_tags AS
SELECT
  p.id,
  p.name,
  p.total_hands,
  s.vpip_denom AS sample_size,
  CASE
    WHEN s.vpip_denom < 5 THEN 'UNKNOWN'
    WHEN (s.vpip_num::float / NULLIF(s.vpip_denom, 0)) > 0.40
      AND (s.pfr_num::float / NULLIF(s.pfr_denom, 0)) > 0.30 THEN 'MANIAC'
    WHEN (s.vpip_num::float / NULLIF(s.vpip_denom, 0)) > 0.40 THEN 'FISH'
    WHEN (s.vpip_num::float / NULLIF(s.vpip_denom, 0)) < 0.15 THEN 'NIT'
    ELSE 'REG'
  END AS tag,
  CASE
    WHEN s.vpip_denom < 5 THEN 'low'
    WHEN s.vpip_denom < 30 THEN 'medium'
    ELSE 'high'
  END AS confidence
FROM players p
LEFT JOIN stats s ON s.player_id = p.id;

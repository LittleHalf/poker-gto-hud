import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const dbPath = process.env.DB_CONNECTION_STRING ?? join(__dirname, '../../poker.db')

export const db = new Database(dbPath)

// Enforce WAL mode for concurrent reads
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Initialize schema on first run
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen  TEXT DEFAULT (datetime('now')),
    total_hands INTEGER DEFAULT 0,
    llm_notes  TEXT
  );

  CREATE TABLE IF NOT EXISTS stats (
    player_id          TEXT PRIMARY KEY REFERENCES players(id),
    vpip_num           INTEGER DEFAULT 0,
    vpip_denom         INTEGER DEFAULT 0,
    pfr_num            INTEGER DEFAULT 0,
    pfr_denom          INTEGER DEFAULT 0,
    af_bets            INTEGER DEFAULT 0,
    af_calls           INTEGER DEFAULT 0,
    cbet_fold_num      INTEGER DEFAULT 0,
    cbet_fold_denom    INTEGER DEFAULT 0,
    fold_to_3bet_num   INTEGER DEFAULT 0,
    fold_to_3bet_denom INTEGER DEFAULT 0,
    wtsd_num           INTEGER DEFAULT 0,
    wtsd_denom         INTEGER DEFAULT 0,
    updated_at         TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hand_history (
    id            TEXT PRIMARY KEY,
    played_at     TEXT DEFAULT (datetime('now')),
    raw_log       TEXT NOT NULL,
    hero_position TEXT,
    hero_cards    TEXT,
    board         TEXT,
    hero_decision TEXT,
    recommended   TEXT,
    lambda_used   REAL,
    ev_loss       REAL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    source_url  TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    status      TEXT DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS hand_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp  INTEGER NOT NULL,
    payload    TEXT NOT NULL
  );
`)

// Built-in SQLite — Node 22.5+ (stable in Node 25). No native compilation needed.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'

const dbPath = process.env.DB_CONNECTION_STRING ?? join(process.cwd(), 'poker.db')

export const db = new DatabaseSync(dbPath)

// WAL mode for concurrent reads; foreign keys on
db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA foreign_keys = ON")

// Initialize schema on first run
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    first_seen  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT DEFAULT (datetime('now')),
    total_hands INTEGER DEFAULT 0,
    llm_notes   TEXT
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

  CREATE TABLE IF NOT EXISTS chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`)

// ── Safe wrappers — node:sqlite uses SupportedValueType; cast via any ───────

type RowRecord = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type P = any[]

export function dbGet<T = RowRecord>(sql: string, ...params: P): T | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (db.prepare(sql) as any).get(...params)
  return (row as T) ?? null
}

export function dbAll<T = RowRecord>(sql: string, ...params: P): T[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db.prepare(sql) as any).all(...params) as T[]
}

export function dbRun(sql: string, ...params: P): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(db.prepare(sql) as any).run(...params)
}

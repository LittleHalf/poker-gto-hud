import { join } from 'path'

const connStr = process.env.DB_CONNECTION_STRING ?? ''
export const IS_PG = connStr.startsWith('postgresql://') || connStr.startsWith('postgres://')

// ── Postgres ─────────────────────────────────────────────────────────────────

import type { Sql } from 'postgres'
let _sql: Sql | null = null

async function getSql(): Promise<Sql> {
  if (!_sql) {
    const postgres = (await import('postgres')).default
    _sql = postgres(connStr, { ssl: 'require', max: 5 })
  }
  return _sql
}

// Convert ?-style placeholders → $1, $2, ...
function toPositional(sql: string): string {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

// Translate SQLite-specific SQL to Postgres
export function dialect(sql: string): string {
  if (!IS_PG) return sql
  return sql
    .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
    .replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO')
    .replace(/datetime\('now',\s*'-(\d+) hours'\)/gi, "NOW() - INTERVAL '$1 hours'")
    .replace(/datetime\('now'\)/gi, 'NOW()')
}

// ── SQLite ────────────────────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite'

let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (!_db) {
    const path = connStr || join(process.cwd(), 'poker.db')
    _db = new DatabaseSync(path)
    _db.exec('PRAGMA journal_mode = WAL')
    _db.exec('PRAGMA foreign_keys = ON')
    initSchema(_db)
  }
  return _db
}

function initSchema(db: DatabaseSync) {
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
}

// ── Unified helpers ───────────────────────────────────────────────────────────

type Row = Record<string, unknown>

export async function dbGet<T = Row>(sql: string, ...params: unknown[]): Promise<T | null> {
  const q = dialect(sql)
  if (IS_PG) {
    const pg = await getSql()
    const rows = await pg.unsafe(toPositional(q), params as never[])
    return (rows[0] as T) ?? null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (getDb().prepare(q) as any).get(...params)
  return (row as T) ?? null
}

export async function dbAll<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  const q = dialect(sql)
  if (IS_PG) {
    const pg = await getSql()
    const rows = await pg.unsafe(toPositional(q), params as never[])
    return rows as unknown as T[]
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getDb().prepare(q) as any).all(...params) as T[]
}

export async function dbRun(sql: string, ...params: unknown[]): Promise<void> {
  const q = dialect(sql)
  if (IS_PG) {
    const pg = await getSql()
    await pg.unsafe(toPositional(q), params as never[])
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(getDb().prepare(q) as any).run(...params)
}

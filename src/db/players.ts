import { dbGet, dbAll, dbRun, IS_PG } from './client.js'
import { createHash } from 'crypto'

export interface Player {
  id: string
  name: string
  first_seen: string
  last_seen: string
  total_hands: number
  llm_notes: string | null
}

export function hashPlayerId(name: string): string {
  return createHash('sha256').update(name.toLowerCase().trim()).digest('hex')
}

export async function upsertPlayer(id: string, name: string): Promise<void> {
  const nowExpr = IS_PG ? 'NOW()' : "datetime('now')"
  await dbRun(
    `INSERT INTO players (id, name, total_hands)
     VALUES (?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       last_seen = ${nowExpr},
       total_hands = total_hands + 1`,
    id, name
  )
  if (IS_PG) {
    await dbRun(`INSERT INTO stats (player_id) VALUES (?) ON CONFLICT DO NOTHING`, id)
  } else {
    await dbRun(`INSERT OR IGNORE INTO stats (player_id) VALUES (?)`, id)
  }
}

export async function getPlayer(id: string): Promise<Player | null> {
  return dbGet<Player>('SELECT * FROM players WHERE id = ?', id)
}

export async function updateLlmNotes(id: string, notes: string): Promise<void> {
  await dbRun('UPDATE players SET llm_notes = ? WHERE id = ?', notes, id)
}

export async function getAllPlayers(): Promise<Player[]> {
  return dbAll<Player>('SELECT * FROM players ORDER BY last_seen DESC')
}

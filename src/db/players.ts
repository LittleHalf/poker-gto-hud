import { dbGet, dbAll, dbRun } from './client.js'
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

export function upsertPlayer(id: string, name: string): void {
  dbRun(
    `INSERT INTO players (id, name, total_hands)
     VALUES (?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       last_seen = datetime('now'),
       total_hands = total_hands + 1`,
    id, name
  )
  // Ensure stats row exists
  dbRun(`INSERT OR IGNORE INTO stats (player_id) VALUES (?)`, id)
}

export function getPlayer(id: string): Player | null {
  return dbGet<Player>('SELECT * FROM players WHERE id = ?', id)
}

export function updateLlmNotes(id: string, notes: string): void {
  dbRun('UPDATE players SET llm_notes = ? WHERE id = ?', notes, id)
}

export function getAllPlayers(): Player[] {
  return dbAll<Player>('SELECT * FROM players ORDER BY last_seen DESC')
}

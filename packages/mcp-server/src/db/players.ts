import { db } from './client.js'
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
  db.prepare(`
    INSERT INTO players (id, name, total_hands)
    VALUES (?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = datetime('now'),
      total_hands = total_hands + 1
  `).run(id, name)

  // Ensure stats row exists
  db.prepare(`
    INSERT OR IGNORE INTO stats (player_id) VALUES (?)
  `).run(id)
}

export function getPlayer(id: string): Player | null {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player | null
}

export function getAllPlayers(): Player[] {
  return db.prepare('SELECT * FROM players ORDER BY last_seen DESC').all() as Player[]
}

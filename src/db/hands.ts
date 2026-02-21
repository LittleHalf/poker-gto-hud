import { dbRun, dbAll } from './client.js'
import { randomUUID } from 'crypto'
import type { GameEvent } from '../tools/ingest.js'

export interface HandRecord {
  id: string
  played_at: string
  raw_log: string
  hero_position: string | null
  hero_cards: string | null
  board: string | null
  hero_decision: string | null
  recommended: string | null
  lambda_used: number | null
  ev_loss: number | null
}

export function insertHandEvent(session_id: string, event: GameEvent): void {
  dbRun(
    `INSERT INTO hand_events (session_id, event_type, timestamp, payload)
     VALUES (?, ?, ?, ?)`,
    session_id, event.type, event.timestamp, JSON.stringify(event.payload)
  )
}

export function saveHandRecord(record: Omit<HandRecord, 'id' | 'played_at'>): string {
  const id = randomUUID()
  dbRun(
    `INSERT INTO hand_history
       (id, raw_log, hero_position, hero_cards, board, hero_decision, recommended, lambda_used, ev_loss)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, record.raw_log, record.hero_position, record.hero_cards,
    record.board, record.hero_decision, record.recommended,
    record.lambda_used, record.ev_loss
  )
  return id
}

export function getRecentHands(limit = 20): HandRecord[] {
  return dbAll<HandRecord>(
    'SELECT * FROM hand_history ORDER BY played_at DESC LIMIT ?',
    limit
  )
}

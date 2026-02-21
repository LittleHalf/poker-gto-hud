import { db } from './client.js'
import type { HandState } from '../engine/state.js'

export interface DbStats {
  player_id: string
  vpip_num: number
  vpip_denom: number
  pfr_num: number
  pfr_denom: number
  af_bets: number
  af_calls: number
  cbet_fold_num: number
  cbet_fold_denom: number
  fold_to_3bet_num: number
  fold_to_3bet_denom: number
  wtsd_num: number
  wtsd_denom: number
  updated_at: string
}

export function getStats(player_id: string): DbStats | null {
  return db.prepare('SELECT * FROM stats WHERE player_id = ?').get(player_id) as DbStats | null
}

export function updateStats(player_id: string, action: string, handState: HandState): void {
  const existing = getStats(player_id)
  if (!existing) return

  const updates: Partial<Record<keyof DbStats, number>> = {}
  const act = action.toUpperCase()

  // VPIP: voluntarily put money in pot preflop (call/raise, not BB check)
  if (handState.street === 'PREFLOP' && (act === 'CALL' || act === 'RAISE' || act === 'BET')) {
    updates.vpip_num = 1
    updates.vpip_denom = 1
  } else if (handState.street === 'PREFLOP' && (act === 'FOLD' || act === 'CHECK')) {
    updates.vpip_denom = 1
  }

  // PFR: preflop raise
  if (handState.street === 'PREFLOP' && (act === 'RAISE' || act === 'BET')) {
    updates.pfr_num = 1
    updates.pfr_denom = 1
  } else if (handState.street === 'PREFLOP') {
    updates.pfr_denom = 1
  }

  // AF: aggression factor (bets+raises vs calls)
  if (act === 'BET' || act === 'RAISE') {
    updates.af_bets = 1
  } else if (act === 'CALL') {
    updates.af_calls = 1
  }

  // WTSD
  if (act === 'SHOWDOWN') {
    updates.wtsd_num = 1
    updates.wtsd_denom = 1
  }

  // Fold to cbet detection (simplified: fold on flop after preflop raise)
  if (handState.street === 'FLOP' && act === 'FOLD') {
    updates.cbet_fold_num = 1
    updates.cbet_fold_denom = 1
  } else if (handState.street === 'FLOP' && (act === 'CALL' || act === 'RAISE')) {
    updates.cbet_fold_denom = 1
  }

  // Build dynamic SQL
  const sets: string[] = []
  const values: (number | string)[] = []
  for (const [key, delta] of Object.entries(updates)) {
    sets.push(`${key} = ${key} + ?`)
    values.push(delta as number)
  }

  if (sets.length === 0) return

  sets.push(`updated_at = datetime('now')`)
  values.push(player_id)

  db.prepare(`UPDATE stats SET ${sets.join(', ')} WHERE player_id = ?`).run(...values)
}

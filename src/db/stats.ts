import { dbGet, dbRun, IS_PG } from './client.js'
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

export async function getStats(player_id: string): Promise<DbStats | null> {
  return dbGet<DbStats>('SELECT * FROM stats WHERE player_id = ?', player_id)
}

export async function updateStats(player_id: string, action: string, handState: HandState): Promise<void> {
  const existing = await getStats(player_id)
  if (!existing) return

  const act = action.toUpperCase()
  const parts: string[] = []
  const vals: unknown[] = []

  if (handState.street === 'PREFLOP') {
    if (act === 'CALL' || act === 'RAISE' || act === 'BET') {
      parts.push('vpip_num = vpip_num + 1', 'vpip_denom = vpip_denom + 1')
    } else if (act === 'FOLD' || act === 'CHECK') {
      parts.push('vpip_denom = vpip_denom + 1')
    }
    if (act === 'RAISE' || act === 'BET') {
      parts.push('pfr_num = pfr_num + 1', 'pfr_denom = pfr_denom + 1')
    } else {
      parts.push('pfr_denom = pfr_denom + 1')
    }
  }

  if (act === 'BET' || act === 'RAISE') {
    parts.push('af_bets = af_bets + 1')
  } else if (act === 'CALL') {
    parts.push('af_calls = af_calls + 1')
  }

  if (handState.street === 'FLOP') {
    if (act === 'FOLD') {
      parts.push('cbet_fold_num = cbet_fold_num + 1', 'cbet_fold_denom = cbet_fold_denom + 1')
    } else if (act === 'CALL' || act === 'RAISE') {
      parts.push('cbet_fold_denom = cbet_fold_denom + 1')
    }
  }

  if (act === 'SHOWDOWN') {
    parts.push('wtsd_num = wtsd_num + 1', 'wtsd_denom = wtsd_denom + 1')
  }

  if (parts.length === 0) return
  parts.push(`updated_at = ${IS_PG ? 'NOW()' : "datetime('now')"}`)
  vals.push(player_id)

  await dbRun(`UPDATE stats SET ${parts.join(', ')} WHERE player_id = ?`, ...vals)
}

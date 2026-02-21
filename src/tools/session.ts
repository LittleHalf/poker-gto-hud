import { dbGet, dbAll } from '../db/client.js'

export interface SessionStats {
  hands_played: number
  session_start: string | null
  biggest_pot_bb: number | null
  hero_decisions: {
    fold: number
    call: number
    raise: number
    bet: number
  }
  ev_loss_total: number | null
}

interface HandCountRow {
  hands_played: number
  session_start: string | null
  biggest_pot_bb: number | null
}

interface DecisionRow {
  hero_decision: string
  cnt: number
}

interface EvRow {
  ev_loss_total: number | null
}

export async function sessionSummary(): Promise<SessionStats> {
  const row = dbGet<HandCountRow>(`
    SELECT
      COUNT(*) as hands_played,
      MIN(played_at) as session_start,
      NULL as biggest_pot_bb
    FROM hand_history
    WHERE played_at >= datetime('now', '-8 hours')
  `) ?? { hands_played: 0, session_start: null, biggest_pot_bb: null }

  const decisions = dbAll<DecisionRow>(`
    SELECT hero_decision, COUNT(*) as cnt
    FROM hand_history
    WHERE played_at >= datetime('now', '-8 hours')
      AND hero_decision IS NOT NULL
    GROUP BY hero_decision
  `)

  const decisionMap: SessionStats['hero_decisions'] = { fold: 0, call: 0, raise: 0, bet: 0 }
  for (const d of decisions) {
    const key = d.hero_decision.toLowerCase() as keyof SessionStats['hero_decisions']
    if (key in decisionMap) decisionMap[key] = d.cnt
  }

  const evRow = dbGet<EvRow>(`
    SELECT SUM(ev_loss) as ev_loss_total
    FROM hand_history
    WHERE played_at >= datetime('now', '-8 hours')
  `) ?? { ev_loss_total: null }

  return {
    hands_played: row.hands_played,
    session_start: row.session_start,
    biggest_pot_bb: row.biggest_pot_bb,
    hero_decisions: decisionMap,
    ev_loss_total: evRow.ev_loss_total,
  }
}

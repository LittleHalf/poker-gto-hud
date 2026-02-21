import { db } from '../db/client.js'

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

export async function sessionSummary(): Promise<SessionStats> {
  const row = db.prepare(`
    SELECT
      COUNT(*) as hands_played,
      MIN(played_at) as session_start,
      MAX(CAST(json_extract(raw_log, '$[0].payload.pot_bb') AS REAL)) as biggest_pot_bb
    FROM hand_history
    WHERE played_at >= datetime('now', '-8 hours')
  `).get() as { hands_played: number; session_start: string | null; biggest_pot_bb: number | null }

  const decisions = db.prepare(`
    SELECT hero_decision, COUNT(*) as cnt
    FROM hand_history
    WHERE played_at >= datetime('now', '-8 hours')
      AND hero_decision IS NOT NULL
    GROUP BY hero_decision
  `).all() as Array<{ hero_decision: string; cnt: number }>

  const decisionMap: SessionStats['hero_decisions'] = { fold: 0, call: 0, raise: 0, bet: 0 }
  for (const d of decisions) {
    const key = d.hero_decision.toLowerCase() as keyof SessionStats['hero_decisions']
    if (key in decisionMap) decisionMap[key] = d.cnt
  }

  const evRow = db.prepare(`
    SELECT SUM(ev_loss) as ev_loss_total
    FROM hand_history
    WHERE played_at >= datetime('now', '-8 hours')
  `).get() as { ev_loss_total: number | null }

  return {
    hands_played: row.hands_played,
    session_start: row.session_start,
    biggest_pot_bb: row.biggest_pot_bb,
    hero_decisions: decisionMap,
    ev_loss_total: evRow.ev_loss_total,
  }
}

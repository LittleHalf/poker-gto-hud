import { getPlayer, updateLlmNotes } from '../db/players.js'
import { getStats } from '../db/stats.js'
import { computeTag } from '../engine/stats.js'
import Anthropic from '@anthropic-ai/sdk'

const LLM_NOTES_THRESHOLD = 10

export interface PlayerProfile {
  id: string
  name: string
  total_hands: number
  tag: 'FISH' | 'MANIAC' | 'NIT' | 'REG' | 'UNKNOWN'
  stats: {
    vpip: number | null
    pfr: number | null
    af: number | null
    fold_to_cbet: number | null
    fold_to_3bet: number | null
    wtsd: number | null
    sample_size: number
  }
  llm_notes: string | null
  confidence: 'low' | 'medium' | 'high'
}

export async function dbLookup(player_id: string): Promise<PlayerProfile> {
  const player = await getPlayer(player_id)
  if (!player) {
    return {
      id: player_id, name: 'Unknown', total_hands: 0, tag: 'UNKNOWN',
      stats: { vpip: null, pfr: null, af: null, fold_to_cbet: null, fold_to_3bet: null, wtsd: null, sample_size: 0 },
      llm_notes: null, confidence: 'low',
    }
  }

  const rawStats = await getStats(player_id)
  const tag = rawStats ? computeTag(rawStats) : 'UNKNOWN'
  const sample = rawStats?.vpip_denom ?? 0
  const confidence: PlayerProfile['confidence'] = sample < 5 ? 'low' : sample < 30 ? 'medium' : 'high'

  const stats = {
    vpip: rawStats && rawStats.vpip_denom > 0 ? rawStats.vpip_num / rawStats.vpip_denom : null,
    pfr:  rawStats && rawStats.pfr_denom  > 0 ? rawStats.pfr_num  / rawStats.pfr_denom  : null,
    af:   rawStats && rawStats.af_calls   > 0 ? rawStats.af_bets  / rawStats.af_calls   : null,
    fold_to_cbet:  rawStats && rawStats.cbet_fold_denom    > 0 ? rawStats.cbet_fold_num    / rawStats.cbet_fold_denom    : null,
    fold_to_3bet:  rawStats && rawStats.fold_to_3bet_denom > 0 ? rawStats.fold_to_3bet_num / rawStats.fold_to_3bet_denom : null,
    wtsd:          rawStats && rawStats.wtsd_denom         > 0 ? rawStats.wtsd_num         / rawStats.wtsd_denom         : null,
    sample_size: sample,
  }

  let llm_notes = player.llm_notes ?? null
  if (!llm_notes && (rawStats?.wtsd_denom ?? 0) >= LLM_NOTES_THRESHOLD) {
    llm_notes = await generateLlmNotes(player.name, stats)
    await updateLlmNotes(player_id, llm_notes)
  }

  return { id: player_id, name: player.name, total_hands: player.total_hands, tag, stats, llm_notes, confidence }
}

async function generateLlmNotes(name: string, stats: PlayerProfile['stats']): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return ''
  const client = new Anthropic({ apiKey })
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 120,
    messages: [{ role: 'user', content: `You are a poker analyst. Summarize this player's tendencies in 1-2 concise sentences for a HUD tooltip.

Player: ${name}
Stats (${stats.sample_size} hands): VPIP=${stats.vpip !== null ? (stats.vpip*100).toFixed(1)+'%' : 'N/A'}, PFR=${stats.pfr !== null ? (stats.pfr*100).toFixed(1)+'%' : 'N/A'}, AF=${stats.af !== null ? stats.af.toFixed(2) : 'N/A'}, Fold→Cbet=${stats.fold_to_cbet !== null ? (stats.fold_to_cbet*100).toFixed(1)+'%' : 'N/A'}, Fold→3bet=${stats.fold_to_3bet !== null ? (stats.fold_to_3bet*100).toFixed(1)+'%' : 'N/A'}, WTSD=${stats.wtsd !== null ? (stats.wtsd*100).toFixed(1)+'%' : 'N/A'}

Write a brief, actionable summary for in-game use.` }],
  })
  return message.content[0].type === 'text' ? message.content[0].text : ''
}

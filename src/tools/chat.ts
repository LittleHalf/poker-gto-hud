import Anthropic from '@anthropic-ai/sdk'
import { dbRun, dbAll } from '../db/client.js'
import { getStats, type DbStats } from '../db/stats.js'
import { computeTag } from '../engine/stats.js'
import type { GameState } from './adviser.js'

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatContext {
  game_state?: Partial<GameState>
  current_recommendation?: string
  lambda?: number
  session_id?: string
}
export interface ChatResult { answer: string; follow_up_suggestions: string[] }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function handChat(
  question: string,
  context: ChatContext,
  history: ChatMessage[] = []
): Promise<ChatResult> {
  // Pre-fetch villain stats so buildSystemPrompt stays synchronous
  const villainStats = new Map<string, DbStats | null>()
  for (const v of context.game_state?.villains ?? []) {
    villainStats.set(v.player_id, await getStats(v.player_id))
  }

  const systemPrompt = buildSystemPrompt(context, villainStats)

  const messages: Anthropic.MessageParam[] = [
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ]

  let answer: string
  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: systemPrompt,
      messages,
    })
    answer = resp.content[0].type === 'text' ? resp.content[0].text : ''
    if (!answer) answer = 'No response from Claude. Check ANTHROPIC_API_KEY is set in server env vars.'
  } catch (err) {
    console.error('[chat] Claude API error:', err)
    answer = `Claude API error: ${err instanceof Error ? err.message : String(err)}. Make sure ANTHROPIC_API_KEY is set in your deployment environment.`
  }
  const suggestions = generateFollowUps(question, context)

  if (context.session_id) {
    await dbRun(
      'INSERT INTO chat_history (session_id, role, content) VALUES (?, ?, ?)',
      context.session_id, 'user', question
    )
    await dbRun(
      'INSERT INTO chat_history (session_id, role, content) VALUES (?, ?, ?)',
      context.session_id, 'assistant', answer
    )
  }

  return { answer, follow_up_suggestions: suggestions }
}

function buildSystemPrompt(ctx: ChatContext, villainStats: Map<string, DbStats | null>): string {
  const gs = ctx.game_state
  const lambda = ctx.lambda ?? 0.5
  const strategy = lambda < 0.2 ? 'GTO' : lambda > 0.8 ? 'Exploit' : 'Balanced GTO/Exploit'

  let villainContext = ''
  if (gs?.villains && gs.villains.length > 0) {
    villainContext = gs.villains.map(v => {
      const stats = villainStats.get(v.player_id)
      if (!stats) return `${v.position}: ${v.player_id} (no data)`
      const tag  = computeTag(stats)
      const vpip = stats.vpip_denom > 0 ? (stats.vpip_num / stats.vpip_denom * 100).toFixed(0) + '%' : 'N/A'
      const pfr  = stats.pfr_denom  > 0 ? (stats.pfr_num  / stats.pfr_denom  * 100).toFixed(0) + '%' : 'N/A'
      const af   = stats.af_calls   > 0 ? (stats.af_bets  / stats.af_calls).toFixed(2) : 'N/A'
      const f3b  = stats.fold_to_3bet_denom > 0 ? (stats.fold_to_3bet_num / stats.fold_to_3bet_denom * 100).toFixed(0) + '%' : 'N/A'
      const fcb  = stats.cbet_fold_denom    > 0 ? (stats.cbet_fold_num    / stats.cbet_fold_denom    * 100).toFixed(0) + '%' : 'N/A'
      return `  - ${v.position} [${tag}] (${stats.vpip_denom} hands): VPIP=${vpip}, PFR=${pfr}, AF=${af}, Fold→3bet=${f3b}, Fold→Cbet=${fcb}, Stack=${v.stack_bb}bb`
    }).join('\n')
  }

  return `You are an expert poker coach giving real-time advice during a live hand. Be concise and direct — the hero is mid-hand.

## Current Hand State
- Street: ${gs?.street ?? 'unknown'}
- Hero position: ${gs?.hero_position ?? 'unknown'}
- Hero cards: ${gs?.hero_cards?.join(' ') ?? 'unknown'}
- Board: ${gs?.board?.length ? gs.board.join(' ') : '(none)'}
- Pot: ${gs?.pot_bb?.toFixed(1) ?? '?'}bb
- To call: ${gs?.to_call_bb?.toFixed(1) ?? '0'}bb
- Hero stack: ${gs?.stack_bb?.toFixed(0) ?? '?'}bb
- Action history this street: ${gs?.action_history?.join(' → ') ?? 'none'}

## Villain Stats
${villainContext || '  (no villain data)'}

## Current Recommendation
${ctx.current_recommendation ?? 'none yet'}

## Strategy Mode
λ = ${lambda.toFixed(2)} (${strategy}) — hero's current GTO vs Exploit dial.

## Instructions
- Answer the hero's question directly. Reference specific villain stats when relevant.
- If asked about sizing deviations, explain EV impact using the villain's fold/call tendencies.
- Keep responses under 120 words. Be direct. Skip pleasantries.`
}

function generateFollowUps(question: string, ctx: ChatContext): string[] {
  const q = question.toLowerCase()
  const gs = ctx.game_state
  const all = [
    'Why is this better than folding?',
    'What sizing maximizes EV here?',
    `How is the ${gs?.villains?.[0]?.position ?? 'villain'} playing today?`,
    'What if I raise bigger?',
    'What if villain re-raises?',
    'Should I slow-play instead?',
    'What are my pot odds?',
    "What's my equity vs their range?",
    'When should I deviate from GTO here?',
  ]
  return all.filter(s => !q.includes(s.toLowerCase().slice(0, 10))).slice(0, 3)
}

export async function getChatHistory(session_id: string, limit = 20): Promise<ChatMessage[]> {
  const rows = await dbAll<{ role: string; content: string }>(
    'SELECT role, content FROM chat_history WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    session_id, limit
  )
  return rows.reverse().map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }))
}

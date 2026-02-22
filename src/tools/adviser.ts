import Anthropic from '@anthropic-ai/sdk'
import { getGtoAction } from '../engine/gto.js'
import { getExploitAction } from '../engine/exploit.js'
import { getStats } from '../db/stats.js'
import { computeTag } from '../engine/stats.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface GameState {
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER'
  hero_position: string
  hero_cards: string[]
  board: string[]
  pot_bb: number
  to_call_bb: number
  stack_bb: number
  villains: Array<{ player_id: string; position: string; stack_bb: number }>
  action_history: string[]
}

export interface Decision {
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE'
  sizing?: string
  reasoning: string
  confidence: number
  ev_estimate?: number
  gto_action: string
  exploit_action: string
}

export async function adviserGetDecision(
  game_state: GameState,
  lambda: number,
  screenshot?: string   // base64 JPEG data URL from the browser tab
): Promise<Decision> {
  const primaryVillain = game_state.villains[0]
  const villainStats = primaryVillain ? await getStats(primaryVillain.player_id) : null

  // Rule-based signals (used as context for Claude + as fallback)
  const gtoResult = getGtoAction(game_state)
  const exploitResult = getExploitAction(game_state, villainStats)

  const sampleSize = villainStats?.vpip_denom ?? 0
  const confidence = Math.min(1.0, sampleSize / 30)

  // Build villain context string
  let villainContext = 'No villain data yet (new player or first hands).'
  if (villainStats && sampleSize > 0) {
    const tag = computeTag(villainStats)
    const vpip = sampleSize > 0 ? `${(villainStats.vpip_num / sampleSize * 100).toFixed(0)}%` : 'N/A'
    const pfr  = villainStats.pfr_denom > 0 ? `${(villainStats.pfr_num / villainStats.pfr_denom * 100).toFixed(0)}%` : 'N/A'
    const af   = villainStats.af_calls > 0 ? (villainStats.af_bets / villainStats.af_calls).toFixed(2) : 'N/A'
    const f3b  = villainStats.fold_to_3bet_denom > 0 ? `${(villainStats.fold_to_3bet_num / villainStats.fold_to_3bet_denom * 100).toFixed(0)}%` : 'N/A'
    const fcb  = villainStats.cbet_fold_denom > 0 ? `${(villainStats.cbet_fold_num / villainStats.cbet_fold_denom * 100).toFixed(0)}%` : 'N/A'
    villainContext = `[${tag}] ${sampleSize} hands: VPIP=${vpip}, PFR=${pfr}, AF=${af}, Fold→3bet=${f3b}, Fold→Cbet=${fcb}, Stack=${primaryVillain.position} ${primaryVillain.stack_bb}bb`
  }

  const strategyMode = lambda < 0.2 ? 'Pure GTO — ignore villain tendencies'
    : lambda > 0.8 ? 'Maximum exploit — heavily weight villain tendencies'
    : `Balanced (λ=${lambda.toFixed(2)}) — blend GTO with villain reads`

  const prompt = `You are an expert poker GTO coach. Analyze this hand and give the optimal action.

Street: ${game_state.street}
Hero: ${game_state.hero_position}, holding ${game_state.hero_cards.join(' ')}
Board: ${game_state.board.length ? game_state.board.join(' ') : '(none — preflop)'}
Pot: ${game_state.pot_bb}bb | To call: ${game_state.to_call_bb}bb | Hero stack: ${game_state.stack_bb}bb
Recent action: ${game_state.action_history.slice(-6).join(' → ') || 'none'}
Villain: ${villainContext}
Strategy mode: ${strategyMode}
Rule-based signals: GTO=${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}, Exploit=${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}

Respond with ONLY a raw JSON object — no markdown, no code fences:
{"action":"FOLD|CHECK|CALL|BET|RAISE","sizing":"e.g. 2.5x or 67% pot (null if none)","reasoning":"one concise sentence explaining the key reason","confidence":0.0}`

  try {
    // If we have a screenshot, send it to Claude Vision for visual card reading
    const userContent: Anthropic.ContentBlockParam[] = []
    if (screenshot) {
      const base64 = screenshot.replace(/^data:image\/\w+;base64,/, '')
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
      } as Anthropic.ImageBlockParam)
      userContent.push({
        type: 'text',
        text: `This is a LIVE screenshot of the poker game taken right now.

IMPORTANT: Use the screenshot as the source of truth. Read directly from it:
- Hero's hole cards (bottom of table, the player labeled "justin" or with action buttons)
- Community cards on the board (center of table)
- Current street (preflop=no board cards, flop=3 cards, turn=4, river=5)
- Hero's stack size (number shown near hero's seat)
- Hero's position (look for D/BTN chip, SB/BB labels near players)
- Pot size (center of table)
- Amount to call (shown on the CALL button if visible)

The DOM-scraped values below are provided as hints but may be stale — trust the screenshot over them:
${prompt}`,
      } as Anthropic.TextBlockParam)
    } else {
      userContent.push({ type: 'text', text: prompt } as Anthropic.TextBlockParam)
    }

    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : ''
    // Strip any accidental markdown fences
    const jsonText = text.replace(/^```(?:json)?|```$/gm, '').trim()
    const parsed = JSON.parse(jsonText) as {
      action: Decision['action']
      sizing: string | null
      reasoning: string
      confidence: number
    }

    return {
      action: parsed.action,
      sizing: parsed.sizing ?? undefined,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence ?? confidence,
      gto_action: `${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}`,
      exploit_action: `${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}`,
    }
  } catch (err) {
    // Fallback to rule-based if Claude is unavailable or returns bad JSON
    console.error('[adviser] Claude failed, falling back to rule-based:', err)
    const effectiveLambda = lambda * confidence
    const finalAction = effectiveLambda >= 0.5 ? exploitResult.action : gtoResult.action
    const finalSizing = effectiveLambda >= 0.5 ? exploitResult.sizing : gtoResult.sizing
    const confidenceLabel = sampleSize < 5 ? `Low confidence (${sampleSize} hands)`
      : sampleSize < 30 ? `Medium confidence (${sampleSize} hands)`
      : `High confidence (${sampleSize} hands)`

    return {
      action: finalAction,
      sizing: finalSizing,
      reasoning: effectiveLambda >= 0.5
        ? `${exploitResult.reasoning} ${confidenceLabel}.`
        : `${gtoResult.reasoning}. ${confidenceLabel}.`,
      confidence,
      gto_action: `${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}`,
      exploit_action: `${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}`,
    }
  }
}

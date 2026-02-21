import { getGtoAction } from '../engine/gto.js'
import { getExploitAction } from '../engine/exploit.js'
import { getStats } from '../db/stats.js'

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
  lambda: number
): Promise<Decision> {
  // Fetch villain stats for primary villain (last aggressor or first villain)
  const primaryVillain = game_state.villains[0]
  const villainStats = primaryVillain ? await getStats(primaryVillain.player_id) : null

  // Get GTO baseline
  const gtoResult = getGtoAction(game_state)

  // Get exploit recommendation
  const exploitResult = getExploitAction(game_state, villainStats)

  // Compute confidence from sample size
  const sampleSize = villainStats?.vpip_denom ?? 0
  const confidence = Math.min(1.0, sampleSize / 30)

  // Lambda interpolation: blend GTO and exploit scores
  // When lambda is low or confidence is low, fall back toward GTO
  const effectiveLambda = lambda * confidence
  const finalAction = effectiveLambda >= 0.5 ? exploitResult.action : gtoResult.action
  const finalSizing = effectiveLambda >= 0.5 ? exploitResult.sizing : gtoResult.sizing

  const confidenceLabel =
    sampleSize < 5 ? `Low confidence (${sampleSize} hands — new player)`
    : sampleSize < 30 ? `Medium confidence (${sampleSize} hands)`
    : `High confidence (${sampleSize} hands)`

  let reasoning: string
  if (lambda < 0.1) {
    reasoning = `GTO play: ${gtoResult.reasoning}`
  } else if (effectiveLambda >= 0.5) {
    reasoning = `${exploitResult.reasoning} ${confidenceLabel}.`
  } else {
    reasoning = `Leaning GTO (${confidenceLabel}). ${gtoResult.reasoning}. Exploit signal: ${exploitResult.reasoning}`
  }

  return {
    action: finalAction,
    sizing: finalSizing,
    reasoning,
    confidence,
    gto_action: `${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}`,
    exploit_action: `${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}`,
  }
}

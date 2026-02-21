import { z } from 'zod'

export type PlayerTag = 'FISH' | 'MANIAC' | 'NIT' | 'REG' | 'UNKNOWN'
export type Street = 'WAITING' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'HAND_OVER'
export type Action = 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE'

export interface Decision {
  action: Action
  sizing?: string
  reasoning: string
  confidence: number
  ev_estimate?: number
  gto_action: string
  exploit_action: string
}

export interface VillainInfo {
  player_id: string
  position: string
  stack_bb: number
  name?: string
  tag?: PlayerTag
}

export interface GameState {
  street: Street
  hero_position: string | null
  hero_cards: string[]
  board: string[]
  pot_bb: number
  to_call_bb: number
  stack_bb: number
  villains: VillainInfo[]
  action_history: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PokerHudProps {
  session_id: string | null
  initial_state: GameState | null
  initial_decision: Decision | null
  lambda?: number
}

export const propSchema = z.object({
  session_id: z.string().nullable(),
  initial_state: z.any().nullable(),
  initial_decision: z.any().nullable(),
  lambda: z.number().optional(),
})

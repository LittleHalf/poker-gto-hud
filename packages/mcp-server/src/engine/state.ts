import type { GameEvent } from '../tools/ingest.js'

export type Street = 'WAITING' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'HAND_OVER'

export interface PlayerAction {
  player_id: string
  action: string
  amount_bb?: number
}

export interface HandState {
  session_id: string
  hand_id: string | null
  street: Street
  hero_position: string | null
  hero_cards: string[]
  board: string[]
  pot_bb: number
  players: Array<{
    id: string
    name: string
    position: string
    stack_bb: number
    active: boolean
  }>
  actions: Record<Street, PlayerAction[]>
  events: GameEvent[]
}

const STREET_ORDER: Street[] = ['WAITING', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'HAND_OVER']

// Per-session hand state
const sessionStates = new Map<string, HandState>()

function makeInitialState(session_id: string): HandState {
  return {
    session_id,
    hand_id: null,
    street: 'WAITING',
    hero_position: null,
    hero_cards: [],
    board: [],
    pot_bb: 0,
    players: [],
    actions: {
      WAITING: [], PREFLOP: [], FLOP: [], TURN: [],
      RIVER: [], SHOWDOWN: [], HAND_OVER: [],
    },
    events: [],
  }
}

export function processEvent(session_id: string, event: GameEvent): HandState {
  if (!sessionStates.has(session_id)) {
    sessionStates.set(session_id, makeInitialState(session_id))
  }
  const state = sessionStates.get(session_id)!
  state.events.push(event)

  switch (event.type) {
    case 'HAND_START': {
      // Reset for new hand
      const newState = makeInitialState(session_id)
      newState.hand_id = event.payload.hand_id as string ?? null
      newState.street = 'PREFLOP'
      newState.pot_bb = (event.payload.small_blind_bb as number ?? 0.5) + (event.payload.big_blind_bb as number ?? 1)
      newState.players = (event.payload.players as HandState['players']) ?? []
      newState.hero_position = event.payload.hero_position as string ?? null
      newState.events = [event]
      sessionStates.set(session_id, newState)
      return newState
    }

    case 'CARD_DEAL': {
      const cards = event.payload.cards as string[] ?? []
      const target = event.payload.target as string
      if (target === 'hero') {
        state.hero_cards = cards
      } else if (target === 'board') {
        state.board = [...state.board, ...cards]
        // Advance street based on board length
        if (state.board.length === 3) state.street = 'FLOP'
        else if (state.board.length === 4) state.street = 'TURN'
        else if (state.board.length === 5) state.street = 'RIVER'
      }
      break
    }

    case 'ACTION': {
      const action: PlayerAction = {
        player_id: event.payload.player_id as string,
        action: event.payload.action as string,
        amount_bb: event.payload.amount_bb as number | undefined,
      }
      if (!state.actions[state.street]) state.actions[state.street] = []
      state.actions[state.street].push(action)

      // Update pot
      if (action.action === 'CALL' || action.action === 'BET' || action.action === 'RAISE') {
        state.pot_bb += action.amount_bb ?? 0
      }

      // Mark folded players as inactive
      if (action.action === 'FOLD') {
        const p = state.players.find(pl => pl.id === action.player_id)
        if (p) p.active = false
      }
      break
    }

    case 'SHOWDOWN':
      state.street = 'SHOWDOWN'
      break

    case 'POT_WIN':
      state.street = 'HAND_OVER'
      break

    case 'PLAYER_JOIN': {
      const newPlayers = event.payload.players as HandState['players'] ?? []
      for (const np of newPlayers) {
        if (!state.players.find(p => p.id === np.id)) {
          state.players.push(np)
        }
      }
      break
    }
  }

  return state
}

export function getHandState(session_id: string): HandState | null {
  return sessionStates.get(session_id) ?? null
}

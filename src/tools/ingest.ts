import { processEvent, getHandState } from '../engine/state.js'
import { upsertPlayer } from '../db/players.js'
import { updateStats } from '../db/stats.js'
import { insertHandEvent } from '../db/hands.js'

export interface GameEvent {
  type: 'CARD_DEAL' | 'ACTION' | 'PLAYER_JOIN' | 'HAND_START' | 'SHOWDOWN' | 'POT_WIN'
  timestamp: number
  payload: Record<string, unknown>
}

export async function handIngest(event: GameEvent, session_id: string) {
  // Persist raw event
  insertHandEvent(session_id, event)

  // Update hand state machine
  const handState = processEvent(session_id, event)

  // Upsert players mentioned in this event
  if (event.type === 'PLAYER_JOIN' || event.type === 'HAND_START') {
    const players = event.payload.players as Array<{ id: string; name: string }> ?? []
    for (const p of players) {
      upsertPlayer(p.id, p.name)
    }
  }

  // Update villain stats on showdown or action
  if (event.type === 'ACTION') {
    const player_id = event.payload.player_id as string
    const action = event.payload.action as string
    if (player_id && action) {
      updateStats(player_id, action, handState)
    }
  }

  if (event.type === 'SHOWDOWN') {
    const players = event.payload.players as Array<{ id: string; action: string }> ?? []
    for (const p of players) {
      updateStats(p.id, 'SHOWDOWN', handState)
    }
  }

  return handState
}

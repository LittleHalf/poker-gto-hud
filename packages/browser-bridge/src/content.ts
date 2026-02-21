// Content script — runs injected into the PokerNow tab
// Observes the DOM and intercepts WebSocket frames to capture game events.

type GameEventType = 'CARD_DEAL' | 'ACTION' | 'PLAYER_JOIN' | 'HAND_START' | 'SHOWDOWN' | 'POT_WIN'

interface GameEvent {
  type: GameEventType
  timestamp: number
  payload: Record<string, unknown>
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sendEvent(event: GameEvent): void {
  chrome.runtime.sendMessage({ type: 'GAME_EVENT', event })
}

function parseCard(el: Element): string {
  // PokerNow card elements have data attributes or class names like "rank-A suit-h"
  const rank = el.getAttribute('data-rank') ?? el.className.match(/rank-(\w+)/)?.[1] ?? '?'
  const suit = el.getAttribute('data-suit') ?? el.className.match(/suit-(\w)/)?.[1] ?? '?'
  return `${rank}${suit}`
}

function getPlayerList(): Array<{ id: string; name: string; position: string; stack_bb: number }> {
  const players: Array<{ id: string; name: string; position: string; stack_bb: number }> = []
  document.querySelectorAll('.table-player').forEach((seat, idx) => {
    const nameEl = seat.querySelector('.table-player-name, .username')
    if (!nameEl) return
    const name = nameEl.textContent?.trim() ?? `Player${idx}`
    const stackEl = seat.querySelector('.table-player-stack, .player-stack')
    const stackText = stackEl?.textContent?.replace(/[^0-9.]/g, '') ?? '0'
    players.push({
      id: btoa(name).replace(/=/g, ''),  // simple ID from name
      name,
      position: `SEAT_${idx}`,
      stack_bb: parseFloat(stackText) || 0,
    })
  })
  return players
}

// ── DOM Observer ─────────────────────────────────────────────────────────────

let lastHandId: string | null = null

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue

      // Hero hole cards
      if (node.matches('.table-player.you .table-player-cards .card, .you-player .card')) {
        const cards = [...document.querySelectorAll('.table-player.you .card, .you-player .card')]
          .map(parseCard)
        if (cards.length === 2) {
          sendEvent({ type: 'CARD_DEAL', timestamp: Date.now(), payload: { target: 'hero', cards } })
        }
      }

      // Community cards (board)
      if (node.matches('.community-cards .card, .board .card')) {
        const board = [...document.querySelectorAll('.community-cards .card, .board .card')]
          .map(parseCard)
        sendEvent({ type: 'CARD_DEAL', timestamp: Date.now(), payload: { target: 'board', cards: board } })
      }

      // New hand start — detected when dealer button moves or hand number updates
      const handNumEl = node.querySelector?.('[data-hand-id], .hand-id, .hand-number')
      const handId = handNumEl?.getAttribute('data-hand-id') ?? handNumEl?.textContent?.trim() ?? null
      if (handId && handId !== lastHandId) {
        lastHandId = handId
        const players = getPlayerList()
        const heroEl = document.querySelector('.table-player.you, .you-player')
        const heroPosition = heroEl?.getAttribute('data-position') ?? detectHeroPosition()
        sendEvent({
          type: 'HAND_START',
          timestamp: Date.now(),
          payload: { hand_id: handId, players, hero_position: heroPosition, small_blind_bb: 0.5, big_blind_bb: 1 },
        })
      }
    }

    // Check for action buttons appearing (hero action time)
    if (mutation.type === 'attributes' || mutation.addedNodes.length > 0) {
      const actionBar = document.querySelector('.action-buttons, .player-actions-wrap')
      if (actionBar && !actionBar.classList.contains('hidden') && !actionBar.getAttribute('data-observed')) {
        actionBar.setAttribute('data-observed', 'true')
        attachActionListeners(actionBar)
      }

      // Detect showdown
      if (document.querySelector('.showdown-results, .showdown-overlay')) {
        const winners = [...document.querySelectorAll('.showdown-winner, .pot-winner')]
          .map(el => ({ id: btoa(el.textContent ?? '').replace(/=/g, ''), action: 'SHOWDOWN' }))
        if (winners.length > 0) {
          sendEvent({ type: 'SHOWDOWN', timestamp: Date.now(), payload: { players: winners } })
        }
      }
    }
  }
})

function detectHeroPosition(): string {
  const heroEl = document.querySelector('.table-player.you, .you-player, [data-you="true"]')
  if (!heroEl) return 'UNKNOWN'
  const posAttr = heroEl.getAttribute('data-position') ?? ''
  if (posAttr) return posAttr.toUpperCase()
  // Fall back to seat index
  const seats = [...document.querySelectorAll('.table-player')]
  const idx = seats.indexOf(heroEl as HTMLElement)
  const positionNames = ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO']
  return positionNames[idx] ?? `SEAT_${idx}`
}

function attachActionListeners(actionBar: Element): void {
  const heroEl = document.querySelector('.table-player.you, .you-player')
  const nameEl = heroEl?.querySelector('.table-player-name, .username')
  const heroName = nameEl?.textContent?.trim() ?? 'Hero'
  const heroId = btoa(heroName).replace(/=/g, '')

  actionBar.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const label = btn.textContent?.trim().toUpperCase() ?? ''
      let action = 'UNKNOWN'
      let amount_bb = 0

      if (label.includes('FOLD')) action = 'FOLD'
      else if (label.includes('CHECK')) action = 'CHECK'
      else if (label.includes('CALL')) {
        action = 'CALL'
        amount_bb = parseFloat(label.replace(/[^0-9.]/g, '')) || 0
      } else if (label.includes('RAISE') || label.includes('BET')) {
        action = label.includes('RAISE') ? 'RAISE' : 'BET'
        const sizeInput = document.querySelector<HTMLInputElement>('.raise-amount input, .bet-amount input')
        amount_bb = parseFloat(sizeInput?.value ?? '0') || 0
      }

      sendEvent({
        type: 'ACTION',
        timestamp: Date.now(),
        payload: { player_id: heroId, action, amount_bb, is_hero: true },
      })
    }, { once: true })
  })
}

// ── WebSocket Intercept ──────────────────────────────────────────────────────

function installWsProxy(): void {
  const OriginalWebSocket = window.WebSocket
  // @ts-expect-error patching global
  window.WebSocket = function (url: string, protocols?: string | string[]) {
    const ws = new OriginalWebSocket(url, protocols)
    const originalOnMessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')

    ws.addEventListener('message', (evt) => {
      try {
        const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : null
        if (!data) return

        // PokerNow specific frame patterns — adapt as needed
        if (data.type === 'G' || data.type === 'game_state') {
          parseWsGameState(data)
        }
      } catch {
        // Not JSON or not a game frame — ignore
      }
    })

    return ws
  }
  Object.assign(window.WebSocket, OriginalWebSocket)
}

function parseWsGameState(frame: Record<string, unknown>): void {
  // Parse raw PokerNow WebSocket frames
  // Frame shapes vary — this handles common patterns
  const action = frame.action ?? frame.a
  if (!action) return

  const player = (frame.player ?? frame.p) as Record<string, unknown> | undefined
  const playerId = player?.id as string | undefined
  const playerName = player?.name as string | undefined

  if (typeof action === 'string') {
    const eventPayload: Record<string, unknown> = {
      player_id: playerId ?? btoa(playerName ?? '').replace(/=/g, ''),
      action: action.toUpperCase(),
      amount_bb: frame.amount ?? frame.chips ?? 0,
    }
    sendEvent({ type: 'ACTION', timestamp: Date.now(), payload: eventPayload })
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

// Start observing DOM mutations
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'data-hand-id'],
})

// Install WebSocket proxy
installWsProxy()

// Announce players already on the table at load time
const initialPlayers = getPlayerList()
if (initialPlayers.length > 0) {
  sendEvent({ type: 'PLAYER_JOIN', timestamp: Date.now(), payload: { players: initialPlayers } })
}

console.log('[Poker GTO HUD] Content script loaded.')

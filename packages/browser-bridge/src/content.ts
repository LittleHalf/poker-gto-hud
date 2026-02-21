// Content script — injected into pokernow.com game tabs
// Reads game state from DOM, injects live HUD overlay, requests GTO decisions.

// ── Types ─────────────────────────────────────────────────────────────────────

interface GameEvent {
  type: string
  timestamp: number
  payload: Record<string, unknown>
}

interface GameState {
  street: string
  hero_position: string
  hero_cards: string[]
  board: string[]
  pot_bb: number
  to_call_bb: number
  stack_bb: number
  villains: Array<{ player_id: string; position: string; stack_bb: number }>
  action_history: string[]
}

interface Decision {
  action: string
  sizing?: string
  reasoning: string
  confidence: number
}

// ── HUD overlay ───────────────────────────────────────────────────────────────

const HUD_ID = 'pgtohud-overlay'
let hudEl: HTMLElement | null = null
let currentLambda = 0.5
let isWaitingForDecision = false
let lastDecisionState = ''

function injectHUD(): void {
  if (document.getElementById(HUD_ID)) return

  const el = document.createElement('div')
  el.id = HUD_ID
  el.innerHTML = `
    <div id="pgtohud-header">
      <span id="pgtohud-dot">●</span> GTO HUD
      <span id="pgtohud-minimize" title="Minimize">─</span>
    </div>
    <div id="pgtohud-body">
      <div id="pgtohud-status">Waiting for hand...</div>
      <div id="pgtohud-action"></div>
      <div id="pgtohud-reasoning"></div>
      <div id="pgtohud-villain"></div>
      <div id="pgtohud-lambda-row">
        <span>GTO</span>
        <input type="range" id="pgtohud-slider" min="0" max="100" value="50" step="5" />
        <span>Exploit</span>
      </div>
      <div id="pgtohud-lambda-label">λ = 0.50 · Balanced</div>
    </div>
  `

  Object.assign(el.style, {
    position: 'fixed',
    top: '80px',
    right: '16px',
    width: '220px',
    background: 'rgba(10,12,18,0.95)',
    border: '1px solid #1e3a5f',
    borderRadius: '8px',
    color: '#e0e0e0',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '12px',
    zIndex: '999999',
    boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
    userSelect: 'none',
  })

  // Inject styles
  const style = document.createElement('style')
  style.textContent = `
    #pgtohud-header {
      padding: 7px 10px;
      background: #0d1b2a;
      border-radius: 8px 8px 0 0;
      font-weight: 600;
      font-size: 12px;
      cursor: move;
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid #1e3a5f;
    }
    #pgtohud-dot { color: #555; font-size: 10px; }
    #pgtohud-dot.connected { color: #22c55e; }
    #pgtohud-dot.thinking  { color: #f59e0b; animation: pgtopulse 1s infinite; }
    @keyframes pgtopulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    #pgtohud-minimize {
      margin-left: auto;
      cursor: pointer;
      color: #666;
      font-size: 14px;
      line-height: 1;
    }
    #pgtohud-minimize:hover { color: #fff; }
    #pgtohud-body { padding: 8px 10px; }
    #pgtohud-status { color: #666; font-size: 11px; margin-bottom: 4px; }
    #pgtohud-action {
      font-size: 18px;
      font-weight: 700;
      color: #22c55e;
      margin: 4px 0;
      min-height: 24px;
    }
    #pgtohud-reasoning {
      font-size: 11px;
      color: #aaa;
      line-height: 1.4;
      margin-bottom: 6px;
      min-height: 16px;
    }
    #pgtohud-villain {
      font-size: 10px;
      color: #6b8cad;
      border-top: 1px solid #1e3a5f;
      padding-top: 5px;
      margin-bottom: 5px;
      min-height: 14px;
      line-height: 1.5;
    }
    #pgtohud-lambda-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: #555;
    }
    #pgtohud-slider {
      flex: 1;
      height: 3px;
      accent-color: #1d4ed8;
      cursor: pointer;
    }
    #pgtohud-lambda-label {
      font-size: 10px;
      color: #555;
      text-align: center;
      margin-top: 2px;
    }
  `
  document.head.appendChild(style)
  document.body.appendChild(el)
  hudEl = el

  // Drag
  makeDraggable(el, document.getElementById('pgtohud-header')!)

  // Minimize
  let minimized = false
  document.getElementById('pgtohud-minimize')!.addEventListener('click', () => {
    const body = document.getElementById('pgtohud-body')!
    minimized = !minimized
    body.style.display = minimized ? 'none' : 'block'
    document.getElementById('pgtohud-minimize')!.textContent = minimized ? '+' : '─'
  })

  // Lambda slider
  const slider = document.getElementById('pgtohud-slider') as HTMLInputElement
  slider.addEventListener('input', () => {
    currentLambda = parseInt(slider.value) / 100
    updateLambdaLabel()
    chrome.runtime.sendMessage({ type: 'SET_LAMBDA', lambda: currentLambda })
  })

  setHudStatus('Watching table...')
  setDot('connected')
}

function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  let ox = 0, oy = 0
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    ox = e.clientX - el.getBoundingClientRect().left
    oy = e.clientY - el.getBoundingClientRect().top
    const move = (e2: MouseEvent) => {
      el.style.left = `${e2.clientX - ox}px`
      el.style.top  = `${e2.clientY - oy}px`
      el.style.right = 'auto'
    }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

function setDot(state: 'connected' | 'thinking' | 'idle'): void {
  const dot = document.getElementById('pgtohud-dot')
  if (!dot) return
  dot.className = state === 'connected' ? 'connected' : state === 'thinking' ? 'thinking' : ''
}

function setHudStatus(msg: string): void {
  const el = document.getElementById('pgtohud-status')
  if (el) el.textContent = msg
}

function showDecision(decision: Decision, lambda: number): void {
  isWaitingForDecision = false
  setDot('connected')

  const actionEl = document.getElementById('pgtohud-action')
  const reasonEl = document.getElementById('pgtohud-reasoning')

  if (!actionEl || !reasonEl) return

  const actionText = decision.sizing
    ? `${decision.action} ${decision.sizing}`
    : decision.action

  // Color by action
  const color = decision.action === 'FOLD' ? '#ef4444'
    : decision.action === 'RAISE' || decision.action === 'BET' ? '#f59e0b'
    : '#22c55e'

  actionEl.style.color = color
  actionEl.textContent = actionText
  reasonEl.textContent = decision.reasoning.slice(0, 120)

  setHudStatus(`λ=${lambda.toFixed(2)} · conf ${Math.round((decision.confidence ?? 0.5) * 100)}%`)
  updateLambdaLabel()
}

function showVillain(profile: Record<string, unknown>): void {
  const el = document.getElementById('pgtohud-villain')
  if (!el) return
  const stats = profile.stats as Record<string, unknown> | null
  if (!stats) { el.textContent = ''; return }
  const pct = (v: unknown) => v !== null && v !== undefined ? `${(Number(v) * 100).toFixed(0)}%` : '?'
  el.innerHTML = `
    <strong>${String(profile.name ?? '?')} [${String(profile.tag ?? '?')}]</strong><br/>
    VPIP ${pct(stats.vpip)} · PFR ${pct(stats.pfr)} · AF ${stats.af !== null ? Number(stats.af).toFixed(1) : '?'}<br/>
    F/3b ${pct(stats.fold_to_3bet)} · F/Cb ${pct(stats.fold_to_cbet)} · n=${stats.sample_size}
  `
}

function updateLambdaLabel(): void {
  const el = document.getElementById('pgtohud-lambda-label')
  if (!el) return
  const label = currentLambda < 0.2 ? 'Pure GTO'
    : currentLambda > 0.8 ? 'Max Exploit'
    : 'Balanced'
  el.textContent = `λ = ${currentLambda.toFixed(2)} · ${label}`
}

// ── Game state extraction ─────────────────────────────────────────────────────

function parseCard(el: Element): string {
  const rank = el.getAttribute('data-rank') ?? el.className.match(/rank-(\w+)/)?.[1] ?? '?'
  const suit = el.getAttribute('data-suit') ?? el.className.match(/suit-(\w)/)?.[1] ?? '?'
  return `${rank}${suit}`
}

function parseStack(el: Element | null): number {
  if (!el) return 0
  return parseFloat(el.textContent?.replace(/[^0-9.]/g, '') ?? '0') || 0
}

function getHeroPosition(): string {
  const heroEl = document.querySelector('.table-player.you, .you-player, [data-you="true"]')
  if (!heroEl) return 'UNKNOWN'
  const pos = heroEl.getAttribute('data-position')
  if (pos) return pos.toUpperCase()
  const seats = [...document.querySelectorAll('.table-player')]
  const idx = seats.indexOf(heroEl as HTMLElement)
  return ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'][idx] ?? `SEAT_${idx}`
}

function extractGameState(): GameState | null {
  // Hero cards
  const heroCards = [...document.querySelectorAll('.table-player.you .card, .you-player .card, [data-you="true"] .card')]
    .map(parseCard).filter(c => c !== '??')
  if (heroCards.length === 0) return null

  // Board
  const board = [...document.querySelectorAll('.community-cards .card, .board .card, .table-cards .card')]
    .map(parseCard).filter(c => c !== '??')

  // Street
  const street = board.length === 0 ? 'PREFLOP'
    : board.length === 3 ? 'FLOP'
    : board.length === 4 ? 'TURN'
    : 'RIVER'

  // Pot
  const potEl = document.querySelector('.main-pot-value, .pot-value, [class*="pot"] .value, .total-pot')
  const pot_bb = parseStack(potEl)

  // Call amount from button label
  const callBtn = document.querySelector('button.call, [class*="call-button"], button[class*="call"]')
  const callText = callBtn?.textContent?.replace(/[^0-9.]/g, '') ?? '0'
  const to_call_bb = parseFloat(callText) || 0

  // Hero stack
  const heroEl = document.querySelector('.table-player.you, .you-player, [data-you="true"]')
  const heroStackEl = heroEl?.querySelector('.table-player-stack, .player-stack, [class*="stack"]')
  const stack_bb = parseStack(heroStackEl ?? null)

  // Villains
  const villains: GameState['villains'] = []
  document.querySelectorAll('.table-player:not(.you), .table-player:not([data-you="true"])').forEach((seat, idx) => {
    const nameEl = seat.querySelector('.table-player-name, .username, [class*="name"]')
    if (!nameEl) return
    const name = nameEl.textContent?.trim() ?? `Player${idx}`
    const stackEl = seat.querySelector('.table-player-stack, .player-stack, [class*="stack"]')
    const stack = parseStack(stackEl ?? null)
    const pos = seat.getAttribute('data-position')?.toUpperCase() ?? `SEAT_${idx}`
    villains.push({
      player_id: btoa(name).replace(/=/g, ''),
      position: pos,
      stack_bb: stack,
    })
  })

  return {
    street,
    hero_position: getHeroPosition(),
    hero_cards: heroCards,
    board,
    pot_bb,
    to_call_bb,
    stack_bb,
    villains,
    action_history: [],
  }
}

// ── Event sending ─────────────────────────────────────────────────────────────

function sendEvent(event: GameEvent): void {
  chrome.runtime.sendMessage({ type: 'GAME_EVENT', event })
}

// ── Decision trigger ──────────────────────────────────────────────────────────

let decisionDebounce: ReturnType<typeof setTimeout> | null = null

function triggerDecision(): void {
  if (isWaitingForDecision) return

  if (decisionDebounce) clearTimeout(decisionDebounce)
  decisionDebounce = setTimeout(() => {
    const state = extractGameState()
    if (!state) return

    // Avoid re-requesting the same state
    const stateKey = JSON.stringify([state.hero_cards, state.board, state.to_call_bb])
    if (stateKey === lastDecisionState) return
    lastDecisionState = stateKey

    isWaitingForDecision = true
    setDot('thinking')
    setHudStatus('Solving...')
    document.getElementById('pgtohud-action')!.textContent = ''
    document.getElementById('pgtohud-reasoning')!.textContent = ''

    chrome.runtime.sendMessage({ type: 'REQUEST_DECISION', game_state: state })

    // Look up primary villain
    if (state.villains.length > 0) {
      chrome.runtime.sendMessage({ type: 'LOOKUP_VILLAIN', player_id: state.villains[0].player_id })
    }
  }, 300)
}

// ── DOM observer ─────────────────────────────────────────────────────────────

const actionBarSeen = new WeakSet<Element>()

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    // Watch for action buttons appearing → hero's turn
    const actionBar = document.querySelector(
      '.action-buttons, .player-actions-wrap, [class*="action-buttons"], [class*="actions-wrap"]'
    )
    if (actionBar && !actionBarSeen.has(actionBar)) {
      const isVisible = (actionBar as HTMLElement).offsetParent !== null
        && !(actionBar as HTMLElement).classList.contains('hidden')
      if (isVisible) {
        actionBarSeen.add(actionBar)
        triggerDecision()
      }
    }

    // Card / board / hand-start events
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue

      if (node.matches('.table-player.you .card, .you-player .card') ||
          node.closest('.table-player.you, .you-player')) {
        const heroCards = [...document.querySelectorAll('.table-player.you .card, .you-player .card')]
          .map(parseCard)
        if (heroCards.length === 2) {
          sendEvent({ type: 'CARD_DEAL', timestamp: Date.now(), payload: { target: 'hero', cards: heroCards } })
        }
      }

      if (node.matches('.community-cards .card, .board .card') ||
          node.closest('.community-cards, .board')) {
        const board = [...document.querySelectorAll('.community-cards .card, .board .card')].map(parseCard)
        sendEvent({ type: 'CARD_DEAL', timestamp: Date.now(), payload: { target: 'board', cards: board } })
        // New street — reset decision gate
        lastDecisionState = ''
      }

      // New hand
      const handNumEl = node.querySelector?.('[data-hand-id], .hand-id, .hand-number')
      const handId = handNumEl?.getAttribute('data-hand-id') ?? handNumEl?.textContent?.trim()
      if (handId) {
        lastDecisionState = ''
        isWaitingForDecision = false
        document.getElementById('pgtohud-action')!.textContent = ''
        document.getElementById('pgtohud-reasoning')!.textContent = ''
        document.getElementById('pgtohud-villain')!.textContent = ''
        setHudStatus('New hand...')
        setDot('connected')

        const players = [...document.querySelectorAll('.table-player')].map((seat, idx) => {
          const name = seat.querySelector('.table-player-name, .username')?.textContent?.trim() ?? `P${idx}`
          return { id: btoa(name).replace(/=/g, ''), name, position: `SEAT_${idx}` }
        })
        sendEvent({ type: 'HAND_START', timestamp: Date.now(),
          payload: { hand_id: handId, players, hero_position: getHeroPosition() } })
      }
    }

    // Showdown
    if (document.querySelector('.showdown-results, .showdown-overlay')) {
      const winners = [...document.querySelectorAll('.showdown-winner, .pot-winner')]
        .map(el => ({ id: btoa(el.textContent ?? '').replace(/=/g, ''), action: 'SHOWDOWN' }))
      if (winners.length > 0) {
        sendEvent({ type: 'SHOWDOWN', timestamp: Date.now(), payload: { players: winners } })
        setHudStatus('Showdown')
        isWaitingForDecision = false
        lastDecisionState = ''
      }
    }
  }
})

// ── Incoming messages from background ────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DECISION_RESULT') {
    showDecision(message.decision as Decision, message.lambda as number)
  }
  if (message.type === 'VILLAIN_PROFILE') {
    showVillain(message.profile as Record<string, unknown>)
  }
})

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  injectHUD()

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-hand-id', 'style'],
  })

  // Announce existing players
  const players = [...document.querySelectorAll('.table-player')].map((seat, idx) => {
    const name = seat.querySelector('.table-player-name, .username')?.textContent?.trim() ?? `P${idx}`
    return { id: btoa(name).replace(/=/g, ''), name }
  }).filter(p => p.name)
  if (players.length > 0) {
    sendEvent({ type: 'PLAYER_JOIN', timestamp: Date.now(), payload: { players } })
  }

  console.log('[Poker GTO HUD] Content script + overlay loaded.')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

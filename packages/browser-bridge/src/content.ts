// Content script — injected into pokernow.com game tabs

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

// ── State ─────────────────────────────────────────────────────────────────────

const HUD_ID = 'pgtohud-overlay'
let currentLambda = 0.5
let isWaitingForDecision = false
let lastDecisionState = ''
let currentGameState: GameState | null = null
let currentRecommendation = ''
let isWaitingForChat = false

// ── HUD ───────────────────────────────────────────────────────────────────────

function injectHUD(): void {
  if (document.getElementById(HUD_ID)) return

  const style = document.createElement('style')
  style.textContent = `
    #pgtohud-overlay { position:fixed;top:80px;right:16px;width:250px;background:rgba(10,12,18,.96);border:1px solid #1e3a5f;border-radius:8px;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;z-index:999999;box-shadow:0 4px 24px rgba(0,0,0,.6);user-select:none; }
    #pgtohud-header { padding:7px 10px;background:#0d1b2a;border-radius:8px 8px 0 0;font-weight:600;font-size:12px;cursor:move;display:flex;align-items:center;gap:5px;border-bottom:1px solid #1e3a5f; }
    #pgtohud-dot { color:#555;font-size:10px;flex-shrink:0; }
    #pgtohud-dot.connected { color:#22c55e; }
    #pgtohud-dot.thinking  { color:#f59e0b;animation:pgtopulse 1s infinite; }
    @keyframes pgtopulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    #pgtohud-header button { background:none;border:none;cursor:pointer;font-size:12px;padding:2px 5px;border-radius:3px;color:#666; }
    #pgtohud-header button:hover { color:#fff;background:rgba(255,255,255,.1); }
    #pgtohud-min { margin-left:auto; }
    #pgtohud-body { padding:8px 10px; }
    #pgtohud-status { color:#666;font-size:10px;margin-bottom:2px; }
    #pgtohud-detected { color:#3b5a7a;font-size:9px;font-family:monospace;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    #pgtohud-action { font-size:20px;font-weight:700;color:#22c55e;margin:4px 0;min-height:26px; }
    #pgtohud-reasoning { font-size:11px;color:#aaa;line-height:1.4;margin-bottom:6px;min-height:16px; }
    #pgtohud-villain { font-size:10px;color:#6b8cad;border-top:1px solid #1e3a5f;padding-top:5px;margin-bottom:5px;min-height:14px;line-height:1.5; }
    #pgtohud-lambda-row { display:flex;align-items:center;gap:6px;font-size:10px;color:#555; }
    #pgtohud-slider { flex:1;height:3px;accent-color:#1d4ed8;cursor:pointer; }
    #pgtohud-lambda-label { font-size:10px;color:#555;text-align:center;margin-top:2px;margin-bottom:6px; }
    #pgtohud-chat { display:none;border-top:1px solid #1e3a5f;padding-top:6px;margin-top:4px; }
    #pgtohud-msgs { max-height:150px;overflow-y:auto;font-size:11px;line-height:1.4;margin-bottom:5px; }
    .pgto-user { color:#60a5fa;margin-bottom:3px; }
    .pgto-bot  { color:#d1d5db;margin-bottom:6px;padding-left:8px;border-left:2px solid #1e3a5f; }
    .pgto-wait { color:#555;font-style:italic;animation:pgtopulse 1s infinite; }
    #pgtohud-suggestions { display:flex;flex-wrap:wrap;gap:3px;margin-bottom:5px; }
    .pgto-sugg { background:#0d1b2a;border:1px solid #1e3a5f;color:#6b8cad;font-size:9px;padding:2px 5px;border-radius:10px;cursor:pointer; }
    .pgto-sugg:hover { border-color:#60a5fa;color:#60a5fa; }
    #pgtohud-input-row { display:flex;gap:4px; }
    #pgtohud-input { flex:1;background:#0d1b2a;border:1px solid #1e3a5f;border-radius:4px;color:#e0e0e0;font-size:11px;padding:4px 6px;outline:none; }
    #pgtohud-input:focus { border-color:#60a5fa; }
    #pgtohud-send { background:#1d4ed8;border:none;color:#fff;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:13px; }
    #pgtohud-send:hover { background:#2563eb; }
    #pgtohud-send:disabled { background:#333;color:#666;cursor:not-allowed; }
  `
  document.head.appendChild(style)

  const el = document.createElement('div')
  el.id = HUD_ID
  el.innerHTML = `
    <div id="pgtohud-header">
      <span id="pgtohud-dot">●</span> GTO HUD
      <button id="pgtohud-analyze" title="Analyze now">▶</button>
      <button id="pgtohud-chat-btn" title="Chat with Claude">💬</button>
      <span id="pgtohud-min" title="Minimize">─</span>
    </div>
    <div id="pgtohud-body">
      <div id="pgtohud-status">Watching table...</div>
      <div id="pgtohud-detected"></div>
      <div id="pgtohud-action"></div>
      <div id="pgtohud-reasoning"></div>
      <div id="pgtohud-villain"></div>
      <div id="pgtohud-lambda-row">
        <span>GTO</span>
        <input type="range" id="pgtohud-slider" min="0" max="100" value="50" step="5"/>
        <span>Exploit</span>
      </div>
      <div id="pgtohud-lambda-label">λ = 0.50 · Balanced</div>
      <div id="pgtohud-chat">
        <div id="pgtohud-msgs"></div>
        <div id="pgtohud-suggestions"></div>
        <div id="pgtohud-input-row">
          <input type="text" id="pgtohud-input" placeholder="Ask about this hand..."/>
          <button id="pgtohud-send">→</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(el)

  makeDraggable(el, document.getElementById('pgtohud-header')!)

  // Minimize
  let minimized = false
  document.getElementById('pgtohud-min')!.addEventListener('click', () => {
    minimized = !minimized
    document.getElementById('pgtohud-body')!.style.display = minimized ? 'none' : 'block'
    document.getElementById('pgtohud-min')!.textContent = minimized ? '+' : '─'
  })

  // Lambda slider
  const slider = document.getElementById('pgtohud-slider') as HTMLInputElement
  slider.addEventListener('input', () => {
    currentLambda = parseInt(slider.value) / 100
    updateLambdaLabel()
    chrome.runtime.sendMessage({ type: 'SET_LAMBDA', lambda: currentLambda })
  })

  // Analyze button
  document.getElementById('pgtohud-analyze')!.addEventListener('click', () => {
    lastDecisionState = ''
    isWaitingForDecision = false
    triggerDecision()
  })

  // Chat toggle
  let chatOpen = false
  document.getElementById('pgtohud-chat-btn')!.addEventListener('click', () => {
    chatOpen = !chatOpen
    document.getElementById('pgtohud-chat')!.style.display = chatOpen ? 'block' : 'none'
    if (chatOpen) (document.getElementById('pgtohud-input') as HTMLInputElement)?.focus()
  })

  // Chat send
  const doSend = () => {
    const input = document.getElementById('pgtohud-input') as HTMLInputElement
    const q = input.value.trim()
    if (!q || isWaitingForChat) return
    input.value = ''
    addMsg('user', `You: ${q}`)
    isWaitingForChat = true
    ;(document.getElementById('pgtohud-send') as HTMLButtonElement).disabled = true
    addMsg('wait', 'Claude is thinking...')
    chrome.runtime.sendMessage({
      type: 'CHAT_REQUEST',
      question: q,
      game_state: currentGameState,
      current_recommendation: currentRecommendation,
      lambda: currentLambda,
    })
  }
  document.getElementById('pgtohud-send')!.addEventListener('click', doSend)
  document.getElementById('pgtohud-input')!.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') doSend()
  })

  setDot('connected')
}

function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  let ox = 0, oy = 0
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    ox = e.clientX - el.getBoundingClientRect().left
    oy = e.clientY - el.getBoundingClientRect().top
    const move = (e2: MouseEvent) => { el.style.left = `${e2.clientX - ox}px`; el.style.top = `${e2.clientY - oy}px`; el.style.right = 'auto' }
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

function setDot(s: 'connected' | 'thinking' | 'idle'): void {
  const d = document.getElementById('pgtohud-dot')
  if (d) d.className = s === 'connected' ? 'connected' : s === 'thinking' ? 'thinking' : ''
}

function setHudStatus(msg: string): void {
  const el = document.getElementById('pgtohud-status')
  if (el) el.textContent = msg
}

function setDetected(state: GameState | null): void {
  const el = document.getElementById('pgtohud-detected')
  if (!el) return
  el.textContent = state ? `${state.hero_cards.join(' ')} | ${state.street} | pot ${state.pot_bb}bb` : ''
}

function showDecision(d: Decision, lambda: number): void {
  isWaitingForDecision = false
  setDot('connected')
  currentRecommendation = d.sizing ? `${d.action} ${d.sizing}` : d.action
  const color = d.action === 'FOLD' ? '#ef4444' : (d.action === 'RAISE' || d.action === 'BET') ? '#f59e0b' : '#22c55e'
  const actionEl = document.getElementById('pgtohud-action')
  const reasonEl = document.getElementById('pgtohud-reasoning')
  if (actionEl) { actionEl.style.color = color; actionEl.textContent = currentRecommendation }
  if (reasonEl) reasonEl.textContent = d.reasoning.slice(0, 140)
  setHudStatus(`λ=${lambda.toFixed(2)} · conf ${Math.round((d.confidence ?? 0.5) * 100)}%`)
  updateLambdaLabel()
}

function showVillain(profile: Record<string, unknown>): void {
  const el = document.getElementById('pgtohud-villain')
  if (!el) return
  const stats = profile.stats as Record<string, unknown> | null
  if (!stats) { el.textContent = ''; return }
  const pct = (v: unknown) => (v != null) ? `${(Number(v) * 100).toFixed(0)}%` : '?'
  el.innerHTML = `<strong>${profile.name ?? '?'} [${profile.tag ?? '?'}]</strong><br/>VPIP ${pct(stats.vpip)} · PFR ${pct(stats.pfr)} · AF ${stats.af != null ? Number(stats.af).toFixed(1) : '?'}<br/>F/3b ${pct(stats.fold_to_3bet)} · F/Cb ${pct(stats.fold_to_cbet)} · n=${stats.sample_size}`
}

function updateLambdaLabel(): void {
  const el = document.getElementById('pgtohud-lambda-label')
  if (el) el.textContent = `λ = ${currentLambda.toFixed(2)} · ${currentLambda < 0.2 ? 'Pure GTO' : currentLambda > 0.8 ? 'Max Exploit' : 'Balanced'}`
}

function addMsg(type: 'user' | 'bot' | 'wait', text: string): void {
  const msgsEl = document.getElementById('pgtohud-msgs')
  if (!msgsEl) return
  const div = document.createElement('div')
  div.className = type === 'user' ? 'pgto-user' : type === 'wait' ? 'pgto-wait' : 'pgto-bot'
  div.textContent = text
  msgsEl.appendChild(div)
  msgsEl.scrollTop = msgsEl.scrollHeight
}

function showSuggestions(suggestions: string[]): void {
  const el = document.getElementById('pgtohud-suggestions')
  if (!el) return
  el.innerHTML = ''
  for (const s of suggestions.slice(0, 3)) {
    const chip = document.createElement('span')
    chip.className = 'pgto-sugg'
    chip.textContent = s
    chip.addEventListener('click', () => {
      ;(document.getElementById('pgtohud-input') as HTMLInputElement).value = s
      document.getElementById('pgtohud-send')?.click()
    })
    el.appendChild(chip)
  }
}

// ── Game state extraction ─────────────────────────────────────────────────────

function parseCard(el: Element): string {
  const rank = el.getAttribute('data-rank')
  const suit = el.getAttribute('data-suit')
  if (rank && suit) return `${rank}${suit}`
  const cls = el.className || ''
  const rm = cls.match(/rank[-_]([AKQJT2-9]{1,2})/i)
  const sm = cls.match(/suit[-_]([shdc])/i)
  if (rm && sm) return `${rm[1].toUpperCase()}${sm[1].toLowerCase()}`
  const txt = el.textContent?.trim() ?? ''
  if (/^[AKQJT2-9]{1,2}[shdc♠♥♦♣]$/i.test(txt)) {
    return txt.replace('♠','s').replace('♥','h').replace('♦','d').replace('♣','c')
  }
  return '??'
}

function parseStack(el: Element | null): number {
  return parseFloat(el?.textContent?.replace(/[^0-9.]/g, '') ?? '0') || 0
}

function findHeroEl(): Element | null {
  return document.querySelector('.table-player.main-player')
    ?? document.querySelector('.table-player[data-you="true"]')
    ?? document.querySelector('.table-player.you')
    ?? document.querySelector('[class*="hero-player"]')
    ?? null
}

function findCards(container: Element | null): string[] {
  if (!container) return []
  for (const sel of ['.card:not(.card-back)', '[class*="card"]:not([class*="back"])', '.playing-card']) {
    const cards = [...container.querySelectorAll(sel)].map(parseCard).filter(c => c !== '??' && c.length >= 2)
    if (cards.length) return cards
  }
  return []
}

function extractGameState(): GameState | null {
  const heroEl = findHeroEl()

  // Hero cards
  let heroCards = heroEl ? findCards(heroEl) : []
  if (!heroCards.length) {
    for (const sel of ['.my-cards', '.hero-cards', '.hole-cards', '.player-cards-zone.main',
                        '.table-player.main-player .player-cards-zone']) {
      const c = findCards(document.querySelector(sel))
      if (c.length) { heroCards = c; break }
    }
  }
  if (!heroCards.length) { setDetected(null); return null }

  // Board
  let board: string[] = []
  for (const sel of ['.community-cards .card:not(.card-back)', '.board-cards .card:not(.card-back)',
                      '.board .card:not(.card-back)', '.table-cards .card:not(.card-back)',
                      '[class*="community"] .card:not(.card-back)', '[class*="board"] [class*="card"]:not([class*="back"])']) {
    const cards = [...document.querySelectorAll(sel)].map(parseCard).filter(c => c !== '??' && c.length >= 2)
    if (cards.length) { board = cards; break }
  }

  const street = board.length === 0 ? 'PREFLOP' : board.length === 3 ? 'FLOP' : board.length === 4 ? 'TURN' : 'RIVER'

  // Pot
  let pot_bb = 0
  for (const sel of ['.main-pot-value','.pot-value','.total-pot','.pot-amount','[class*="pot"] [class*="value"]']) {
    const el = document.querySelector(sel)
    if (el) { pot_bb = parseStack(el); break }
  }

  // Call amount
  let to_call_bb = 0
  for (const sel of ['button.call','button[class*="call"]','[class*="call-button"]','.action-button.call','[data-action="call"]']) {
    const btn = document.querySelector(sel)
    if (btn) { to_call_bb = parseFloat(btn.textContent?.replace(/[^0-9.]/g, '') ?? '0') || 0; break }
  }

  // Hero stack
  const heroStackEl = heroEl?.querySelector('.table-player-stack,.stack-value,[class*="chips"] [class*="value"],[class*="stack"] [class*="value"]')
  const stack_bb = parseStack(heroStackEl ?? null)

  // Position
  let hero_position = 'UNKNOWN'
  const pos = heroEl?.getAttribute('data-position')
  if (pos) {
    hero_position = pos.toUpperCase()
  } else {
    const seats = [...document.querySelectorAll('.table-player')]
    const idx = seats.indexOf(heroEl as HTMLElement)
    hero_position = ['BTN','SB','BB','UTG','MP','HJ','CO'][idx] ?? `SEAT_${idx}`
  }

  // Villains
  const villains: GameState['villains'] = []
  document.querySelectorAll('.table-player').forEach((seat, idx) => {
    if (seat === heroEl) return
    const nameEl = seat.querySelector('.table-player-name,.username,[class*="player-name"],[class*="username"]')
    const name = nameEl?.textContent?.trim()
    if (!name) return
    const stackEl = seat.querySelector('.table-player-stack,.stack-value,[class*="stack"] [class*="value"],[class*="chips"] [class*="value"]')
    villains.push({
      player_id: btoa(name).replace(/[+/=]/g, ''),
      position: seat.getAttribute('data-position')?.toUpperCase() ?? `SEAT_${idx}`,
      stack_bb: parseStack(stackEl ?? null),
    })
  })

  // Action history from game log
  const action_history: string[] = []
  for (const sel of ['.log-entry','.game-log-entry','[class*="log-entry"]','.timeline-entry']) {
    const entries = [...document.querySelectorAll(sel)]
    if (entries.length) {
      action_history.push(...entries.slice(-10).map(e => e.textContent?.trim() ?? '').filter(Boolean))
      break
    }
  }

  const state: GameState = { street, hero_position, hero_cards: heroCards, board, pot_bb, to_call_bb, stack_bb, villains, action_history }
  currentGameState = state
  setDetected(state)
  return state
}

// ── Event sending ─────────────────────────────────────────────────────────────

function sendEvent(event: GameEvent): void {
  chrome.runtime.sendMessage({ type: 'GAME_EVENT', event })
}

// ── Opponent action tracking ──────────────────────────────────────────────────

const seenLogEntries = new Set<string>()

function scanActionLog(): void {
  for (const sel of ['.log-entry','.game-log-entry','[class*="log-entry"]','.timeline-entry']) {
    for (const entry of document.querySelectorAll(sel)) {
      const text = entry.textContent?.trim() ?? ''
      if (!text || seenLogEntries.has(text)) continue
      seenLogEntries.add(text)
      const m = text.match(/^(.+?)\s+(raises?|calls?|checks?|folds?|bets?)/i)
      if (!m) continue
      const [, playerName, rawAction] = m
      const amount = parseFloat(text.match(/(\d+(?:\.\d+)?)\s*$/)?.[1] ?? '0') || 0
      sendEvent({
        type: 'ACTION',
        timestamp: Date.now(),
        payload: {
          player_id: btoa(playerName.trim()).replace(/[+/=]/g, ''),
          player_name: playerName.trim(),
          action: rawAction.toLowerCase().replace(/s$/, ''),
          amount,
        },
      })
    }
  }
}

// ── Decision trigger ──────────────────────────────────────────────────────────

let decisionDebounce: ReturnType<typeof setTimeout> | null = null

function triggerDecision(): void {
  if (isWaitingForDecision) return
  if (decisionDebounce) clearTimeout(decisionDebounce)
  decisionDebounce = setTimeout(() => {
    const state = extractGameState()
    if (!state) { setHudStatus('No cards detected — press ▶ to retry'); return }
    const key = JSON.stringify([state.hero_cards, state.board, state.to_call_bb])
    if (key === lastDecisionState) return
    lastDecisionState = key
    isWaitingForDecision = true
    setDot('thinking')
    setHudStatus('Solving...')
    const a = document.getElementById('pgtohud-action'); if (a) a.textContent = ''
    const r = document.getElementById('pgtohud-reasoning'); if (r) r.textContent = ''
    chrome.runtime.sendMessage({ type: 'REQUEST_DECISION', game_state: state })
    if (state.villains.length > 0) {
      chrome.runtime.sendMessage({ type: 'LOOKUP_VILLAIN', player_id: state.villains[0].player_id })
    }
  }, 300)
}

// ── DOM observer ─────────────────────────────────────────────────────────────

const actionBarSeen = new WeakSet<Element>()
const ACTION_SELECTORS = [
  '.action-buttons','.player-actions-wrap','.game-table-action-buttons',
  '.game-player-actions-container','[class*="action-buttons"]','[class*="actions-wrap"]',
]

const observer = new MutationObserver(() => {
  scanActionLog()

  // Action bar visible → hero's turn
  for (const sel of ACTION_SELECTORS) {
    const bar = document.querySelector(sel)
    if (bar && !actionBarSeen.has(bar)) {
      const s = getComputedStyle(bar as HTMLElement)
      if ((bar as HTMLElement).offsetParent !== null && s.display !== 'none' && s.visibility !== 'hidden') {
        actionBarSeen.add(bar)
        triggerDecision()
        break
      }
    }
  }
})

// ── Incoming messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DECISION_RESULT') {
    showDecision(message.decision as Decision, message.lambda as number)
  }
  if (message.type === 'VILLAIN_PROFILE') {
    showVillain(message.profile as Record<string, unknown>)
  }
  if (message.type === 'CHAT_RESPONSE') {
    isWaitingForChat = false
    ;(document.getElementById('pgtohud-send') as HTMLButtonElement).disabled = false
    // Remove thinking message
    const msgsEl = document.getElementById('pgtohud-msgs')
    const waiting = msgsEl?.querySelector('.pgto-wait')
    if (waiting) msgsEl!.removeChild(waiting)
    const result = message.result as { answer: string; follow_up_suggestions: string[] }
    addMsg('bot', result.answer)
    if (result.follow_up_suggestions?.length) showSuggestions(result.follow_up_suggestions)
  }
})

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  injectHUD()
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style','data-position'] })
  scanActionLog()

  const players = [...document.querySelectorAll('.table-player')].map((seat, idx) => {
    const name = seat.querySelector('.table-player-name,.username,[class*="player-name"]')?.textContent?.trim() ?? `P${idx}`
    return { id: btoa(name).replace(/[+/=]/g, ''), name, position: seat.getAttribute('data-position')?.toUpperCase() ?? `SEAT_${idx}` }
  }).filter(p => p.name)
  if (players.length) sendEvent({ type: 'PLAYER_JOIN', timestamp: Date.now(), payload: { players } })

  setTimeout(triggerDecision, 800)
  console.log('[Poker GTO HUD] Loaded.')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

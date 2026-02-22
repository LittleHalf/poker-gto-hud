// Content script — pokernow.com
// Primary data source: screenshot sent to Claude Vision every 2.5s
// DOM scraping only used for: action log (opponent stats) + chat context

interface GameEvent {
  type: string
  timestamp: number
  payload: Record<string, unknown>
}

interface AnalysisResult {
  is_active_hand: boolean
  is_hero_turn: boolean
  street: string
  hero_cards: string[]
  board: string[]
  pot_bb: number
  stack_bb: number
  hero_position: string
  to_call_bb: number
  action: string
  sizing?: string
  reasoning: string
  confidence: number
  gto_action?: string
  exploit_action?: string
}

// ── State ─────────────────────────────────────────────────────────────────────

const HUD_ID = 'pgtohud-overlay'
let currentLambda = 0.5
let lastAnalysis: AnalysisResult | null = null
let currentRecommendation = ''
let isWaitingForChat = false
let manualCards: string[] = []
let isAnalyzing = false

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
    #pgtohud-header button { background:none;border:none;cursor:pointer;padding:2px 5px;border-radius:3px;line-height:1; }
    #pgtohud-analyze { font-size:13px;color:#22c55e;font-weight:bold; }
    #pgtohud-analyze:hover { background:rgba(34,197,94,0.15); }
    #pgtohud-analyze:disabled { color:#333;cursor:not-allowed; }
    #pgtohud-chat-btn { font-size:12px;color:#60a5fa; }
    #pgtohud-chat-btn:hover { background:rgba(96,165,250,0.15); }
    #pgtohud-min { margin-left:auto;color:#555;font-size:14px; }
    #pgtohud-min:hover { color:#fff; }
    #pgtohud-body { padding:8px 10px; }
    #pgtohud-status { color:#666;font-size:10px;margin-bottom:2px; }
    #pgtohud-detected { color:#2d5a7a;font-size:9px;font-family:monospace;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    #pgtohud-action { font-size:22px;font-weight:700;color:#22c55e;margin:4px 0;min-height:28px; }
    #pgtohud-reasoning { font-size:11px;color:#aaa;line-height:1.4;margin-bottom:4px;min-height:14px; }
    #pgtohud-sub { font-size:10px;color:#555;margin-bottom:5px; }
    #pgtohud-villain { font-size:10px;color:#6b8cad;border-top:1px solid #1e3a5f;padding-top:5px;margin-bottom:5px;min-height:14px;line-height:1.5; }
    #pgtohud-lambda-row { display:flex;align-items:center;gap:6px;font-size:10px;color:#555; }
    #pgtohud-slider { flex:1;height:3px;accent-color:#1d4ed8;cursor:pointer; }
    #pgtohud-lambda-label { font-size:10px;color:#555;text-align:center;margin-top:2px;margin-bottom:6px; }
    #pgtohud-manual-row { display:flex;gap:3px;margin-bottom:5px; }
    #pgtohud-manual-input { flex:1;background:#0d1b2a;border:1px solid #1e3a5f;border-radius:4px;color:#e0e0e0;font-size:10px;padding:3px 6px;outline:none; }
    #pgtohud-manual-input:focus { border-color:#f59e0b; }
    #pgtohud-manual-set,#pgtohud-manual-clear { background:#1e3a5f;border:none;color:#aaa;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:10px; }
    #pgtohud-manual-set:hover { background:#1d4ed8;color:#fff; }
    #pgtohud-manual-clear:hover { background:#7f1d1d;color:#fff; }
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
      <button id="pgtohud-analyze" title="Analyze now (also runs every 2.5s)">▶</button>
      <button id="pgtohud-chat-btn" title="Chat with Claude">💬</button>
      <span id="pgtohud-min" title="Minimize">─</span>
    </div>
    <div id="pgtohud-body">
      <div id="pgtohud-status">Starting...</div>
      <div id="pgtohud-detected"></div>
      <div id="pgtohud-action"></div>
      <div id="pgtohud-reasoning"></div>
      <div id="pgtohud-sub"></div>
      <div id="pgtohud-villain"></div>
      <div id="pgtohud-lambda-row">
        <span>GTO</span>
        <input type="range" id="pgtohud-slider" min="0" max="100" value="50" step="5"/>
        <span>Exploit</span>
      </div>
      <div id="pgtohud-lambda-label">λ = 0.50 · Balanced</div>
      <div id="pgtohud-manual-row">
        <input type="text" id="pgtohud-manual-input" placeholder="Override cards: Ah Kd"/>
        <button id="pgtohud-manual-set">Set</button>
        <button id="pgtohud-manual-clear" style="display:none">✕</button>
      </div>
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

  // ▶ Analyze now
  document.getElementById('pgtohud-analyze')!.addEventListener('click', () => {
    requestAnalysis()
  })

  // Manual card override
  document.getElementById('pgtohud-manual-set')!.addEventListener('click', () => {
    const inp = document.getElementById('pgtohud-manual-input') as HTMLInputElement
    const cards = inp.value.trim().split(/[\s,]+/).filter(c => /^[AKQJTakqjt2-9]{1,2}[shdcSHDC]$/.test(c))
    if (cards.length < 2) { setStatus('Invalid — try e.g. Ah Kd'); return }
    manualCards = cards
    document.getElementById('pgtohud-manual-clear')!.style.display = 'inline'
    setStatus(`Manual cards set: ${cards.join(' ')}`)
    requestAnalysis()
  })
  document.getElementById('pgtohud-manual-input')!.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') document.getElementById('pgtohud-manual-set')?.click()
  })
  document.getElementById('pgtohud-manual-clear')!.addEventListener('click', () => {
    manualCards = []
    ;(document.getElementById('pgtohud-manual-input') as HTMLInputElement).value = ''
    document.getElementById('pgtohud-manual-clear')!.style.display = 'none'
    setStatus('Manual override cleared')
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
      game_state: lastAnalysis ? {
        street: lastAnalysis.street,
        hero_cards: lastAnalysis.hero_cards,
        board: lastAnalysis.board,
        pot_bb: lastAnalysis.pot_bb,
        stack_bb: lastAnalysis.stack_bb,
        hero_position: lastAnalysis.hero_position,
        to_call_bb: lastAnalysis.to_call_bb,
        villains: [],
        action_history: [],
      } : undefined,
      current_recommendation: currentRecommendation,
      lambda: currentLambda,
    })
  }
  document.getElementById('pgtohud-send')!.addEventListener('click', doSend)
  document.getElementById('pgtohud-input')!.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') doSend()
  })

  setDot('connected')
  setStatus('Ready — scanning every 2.5s')
}

function makeDraggable(el: HTMLElement, handle: HTMLElement): void {
  let ox = 0, oy = 0
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    ox = e.clientX - el.getBoundingClientRect().left
    oy = e.clientY - el.getBoundingClientRect().top
    const move = (e2: MouseEvent) => { el.style.left=`${e2.clientX-ox}px`; el.style.top=`${e2.clientY-oy}px`; el.style.right='auto' }
    const up = () => { document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up) }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

function setDot(s: 'connected'|'thinking'|'idle'): void {
  const d = document.getElementById('pgtohud-dot')
  if (d) d.className = s === 'connected' ? 'connected' : s === 'thinking' ? 'thinking' : ''
}
function setStatus(msg: string): void {
  const el = document.getElementById('pgtohud-status'); if (el) el.textContent = msg
}
function updateLambdaLabel(): void {
  const el = document.getElementById('pgtohud-lambda-label')
  if (el) el.textContent = `λ = ${currentLambda.toFixed(2)} · ${currentLambda<0.2?'Pure GTO':currentLambda>0.8?'Max Exploit':'Balanced'}`
}
function addMsg(type: 'user'|'bot'|'wait', text: string): void {
  const el = document.getElementById('pgtohud-msgs'); if (!el) return
  const div = document.createElement('div')
  div.className = type==='user'?'pgto-user':type==='wait'?'pgto-wait':'pgto-bot'
  div.textContent = text
  el.appendChild(div); el.scrollTop = el.scrollHeight
}
function showSuggestions(suggestions: string[]): void {
  const el = document.getElementById('pgtohud-suggestions'); if (!el) return
  el.innerHTML = ''
  for (const s of suggestions.slice(0,3)) {
    const chip = document.createElement('span')
    chip.className='pgto-sugg'; chip.textContent=s
    chip.addEventListener('click',()=>{ (document.getElementById('pgtohud-input') as HTMLInputElement).value=s; document.getElementById('pgtohud-send')?.click() })
    el.appendChild(chip)
  }
}

function showAnalysis(result: AnalysisResult): void {
  setDot('connected')
  isAnalyzing = false
  ;(document.getElementById('pgtohud-analyze') as HTMLButtonElement).disabled = false

  if (!result.is_active_hand) {
    // Show server error if present, otherwise just waiting
    const isError = result.reasoning?.startsWith('Server error') || result.reasoning?.startsWith('Cannot reach') || result.reasoning?.startsWith('Screenshot') || result.reasoning?.startsWith('Claude Vision error')
    if (isError) {
      setStatus(`⚠ ${result.reasoning}`)
      setDot('idle')
    } else {
      setStatus('Waiting for hand...')
      setDot('connected')
    }
    const a = document.getElementById('pgtohud-action'); if (a) { a.textContent=''; a.style.color='#22c55e' }
    const r = document.getElementById('pgtohud-reasoning'); if (r) r.textContent=''
    document.getElementById('pgtohud-detected')!.textContent = ''
    return
  }

  // Update detected state line
  const cards = result.hero_cards.join(' ') || '?'
  const board = result.board.length ? result.board.join(' ') : '-'
  document.getElementById('pgtohud-detected')!.textContent =
    `${cards} | ${board} | ${result.street} | pot ${result.pot_bb}bb | stack ${result.stack_bb}bb | ${result.hero_position}`

  // Action
  currentRecommendation = result.sizing ? `${result.action} ${result.sizing}` : result.action
  const color = result.action==='FOLD'?'#ef4444':(result.action==='RAISE'||result.action==='BET')?'#f59e0b':'#22c55e'
  const actionEl = document.getElementById('pgtohud-action')!
  actionEl.style.color = color
  actionEl.textContent = currentRecommendation

  document.getElementById('pgtohud-reasoning')!.textContent = result.reasoning.slice(0, 150)

  const sub = []
  if (result.gto_action) sub.push(`GTO: ${result.gto_action}`)
  if (result.exploit_action) sub.push(`Exploit: ${result.exploit_action}`)
  sub.push(`conf ${Math.round((result.confidence??0.5)*100)}%`)
  document.getElementById('pgtohud-sub')!.textContent = sub.join(' · ')

  if (result.is_hero_turn) {
    setStatus(`Your turn · λ=${currentLambda.toFixed(2)}`)
  } else {
    setStatus(`Watching · ${result.street}`)
  }

  lastAnalysis = result
}

function showVillain(profile: Record<string, unknown>): void {
  const el = document.getElementById('pgtohud-villain'); if (!el) return
  const stats = profile.stats as Record<string,unknown>|null
  if (!stats) { el.textContent=''; return }
  const pct = (v: unknown) => v!=null ? `${(Number(v)*100).toFixed(0)}%` : '?'
  el.innerHTML = `<strong>${profile.name??'?'} [${profile.tag??'?'}]</strong><br/>VPIP ${pct(stats.vpip)} · PFR ${pct(stats.pfr)} · AF ${stats.af!=null?Number(stats.af).toFixed(1):'?'}<br/>F/3b ${pct(stats.fold_to_3bet)} · F/Cb ${pct(stats.fold_to_cbet)} · n=${stats.sample_size}`
}

// ── Screenshot analysis trigger ───────────────────────────────────────────────

function requestAnalysis(): void {
  if (isAnalyzing) return
  isAnalyzing = true
  setDot('thinking')
  setStatus('Analyzing...')
  console.log('[GTO HUD] Sending SCREENSHOT_TICK, lambda=', currentLambda, 'manualCards=', manualCards)
  ;(document.getElementById('pgtohud-analyze') as HTMLButtonElement).disabled = true

  // Safety: always unlock after 10s so the timer never gets permanently stuck
  setTimeout(() => {
    if (isAnalyzing) {
      isAnalyzing = false
      setDot('connected')
      ;(document.getElementById('pgtohud-analyze') as HTMLButtonElement).disabled = false
    }
  }, 10000)

  chrome.runtime.sendMessage({
    type: 'SCREENSHOT_TICK',
    lambda: currentLambda,
    manual_cards: manualCards.length >= 2 ? manualCards : undefined,
  })
}

// ── Opponent action tracking ──────────────────────────────────────────────────

const seenLogEntries = new Set<string>()

function scanActionLog(): void {
  const selectors = ['.log-entry','.game-log-entry','[class*="log-entry"]','.timeline-entry','[class*="timeline"]','[class*="game-log"]']
  const found: Element[] = []
  for (const sel of selectors) {
    const els = [...document.querySelectorAll(sel)]
    if (els.length) { found.push(...els); break }
  }
  if (!found.length) {
    document.querySelectorAll('p,span,div,li').forEach(el => {
      const text = el.textContent?.trim()??''
      if (text.length>5&&text.length<100&&/\b(raises?|calls?|checks?|folds?|bets?)\b/i.test(text)&&el.children.length===0) found.push(el)
    })
  }
  for (const entry of found) {
    const text = entry.textContent?.trim()??''
    if (!text||seenLogEntries.has(text)) continue
    seenLogEntries.add(text)
    const m = text.match(/^(.+?)\s+(raises?|calls?|checks?|folds?|bets?)/i)
    if (!m) continue
    const [,playerName,rawAction] = m
    const amount = parseFloat(text.match(/(\d+(?:\.\d+)?)\s*$/)?.[1]??'0')||0
    chrome.runtime.sendMessage({
      type: 'GAME_EVENT',
      event: {
        type: 'ACTION',
        timestamp: Date.now(),
        payload: { player_id: btoa(playerName.trim()).replace(/[+/=]/g,''), player_name: playerName.trim(), action: rawAction.toLowerCase().replace(/s$/,''), amount },
      },
    })
  }
}

// ── Incoming messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ANALYSIS_RESULT') {
    console.log('[GTO HUD] ANALYSIS_RESULT received:', message.result)
    showAnalysis(message.result as AnalysisResult)
  }
  if (message.type === 'VILLAIN_PROFILE') {
    showVillain(message.profile as Record<string,unknown>)
  }
  if (message.type === 'CHAT_RESPONSE') {
    isWaitingForChat = false
    ;(document.getElementById('pgtohud-send') as HTMLButtonElement).disabled = false
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

  // Unconditional 2.5s screenshot ticker — no conditions, always fires
  setInterval(requestAnalysis, 2500)

  // Observe DOM for opponent action log updates
  new MutationObserver(scanActionLog).observe(document.body, {
    childList: true, subtree: true,
  })
  scanActionLog()

  // Initial analysis after a short delay
  setTimeout(requestAnalysis, 1000)

  console.log('[Poker GTO HUD] Loaded. Screenshot analysis every 2.5s.')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

// Background service worker

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

interface StoredSession {
  session_id: string
  source_url: string
  mcp_server_url: string
}

const DEFAULT_MCP_URL = 'https://gentle-grass-l9c8r.run.mcp-use.com'

// ── Storage ───────────────────────────────────────────────────────────────────

async function getSession(): Promise<StoredSession | null> {
  const result = await chrome.storage.local.get(['active_session', 'lambda'])
  return (result.active_session as StoredSession) ?? null
}

async function setSession(session: StoredSession): Promise<void> {
  await chrome.storage.local.set({ active_session: session })
}

async function getLambda(): Promise<number> {
  const result = await chrome.storage.local.get('lambda')
  return (result.lambda as number) ?? 0.5
}

// ── Event forwarding ─────────────────────────────────────────────────────────

async function forwardEvent(event: GameEvent): Promise<void> {
  const session = await getSession()
  if (!session) return

  try {
    await fetch(`${session.mcp_server_url}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, session_id: session.session_id }),
    })
  } catch (err) {
    console.error('[BG] ingest error:', err)
  }
}

// ── Decision request ─────────────────────────────────────────────────────────

async function captureScreenshot(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId)
    // Try with explicit windowId first, then fall back to current window
    if (tab.windowId) {
      try {
        return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 })
      } catch (e1) {
        console.warn('[BG] captureVisibleTab with windowId failed:', e1)
      }
    }
    // Fallback: capture without specifying window (uses current focused window)
    return await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 55 })
  } catch (err) {
    console.error('[BG] captureScreenshot failed:', err)
    return undefined
  }
}

async function requestDecision(game_state: GameState, tabId: number): Promise<void> {
  const session = await getSession()
  if (!session) return

  const lambda = await getLambda()

  // Capture screenshot so Claude can see the cards visually
  const screenshot = await captureScreenshot(tabId)

  try {
    const resp = await fetch(`${session.mcp_server_url}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_state, lambda, screenshot }),
    })

    if (!resp.ok) {
      console.error('[BG] decide failed', resp.status)
      return
    }

    const decision = await resp.json()
    chrome.tabs.sendMessage(tabId, { type: 'DECISION_RESULT', decision, lambda })
  } catch (err) {
    console.error('[BG] decide error:', err)
  }
}

// ── Villain lookup ────────────────────────────────────────────────────────────

async function lookupVillain(player_id: string, tabId: number): Promise<void> {
  const session = await getSession()
  if (!session) return

  try {
    const resp = await fetch(`${session.mcp_server_url}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id }),
    })
    if (!resp.ok) return
    const profile = await resp.json()
    chrome.tabs.sendMessage(tabId, { type: 'VILLAIN_PROFILE', profile })
  } catch (err) {
    console.error('[BG] lookup error:', err)
  }
}

// ── Session start ─────────────────────────────────────────────────────────────

async function startSession(source_url: string, mcp_server_url: string): Promise<StoredSession> {
  const resp = await fetch(`${mcp_server_url}/monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_url }),
  })
  if (!resp.ok) throw new Error(`monitor failed: ${resp.status}`)
  const { session_id } = await resp.json() as { session_id: string }
  const session: StoredSession = { session_id, source_url, mcp_server_url }
  await setSession(session)
  return session
}

// ── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id

  if (message.type === 'GAME_EVENT') {
    forwardEvent(message.event as GameEvent).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'REQUEST_DECISION') {
    if (tabId) requestDecision(message.game_state as GameState, tabId).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'SCREENSHOT_TICK') {
    if (tabId) handleScreenshotTick(message.lambda as number, message.manual_cards as string[]|undefined, message.action_history as string[]|undefined, tabId).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'LOOKUP_VILLAIN') {
    if (tabId) lookupVillain(message.player_id as string, tabId).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'SET_LAMBDA') {
    chrome.storage.local.set({ lambda: message.lambda }).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'START_SESSION') {
    const { source_url, mcp_server_url = DEFAULT_MCP_URL } = message as { source_url: string; mcp_server_url?: string }
    startSession(source_url, mcp_server_url)
      .then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'GET_SESSION') {
    getSession().then(session => sendResponse({ session })).catch(console.error)
    return true
  }

  if (message.type === 'CHAT_REQUEST') {
    if (tabId) handleChat(message as ChatRequest, tabId).catch(console.error)
    sendResponse({ ok: true })
    return true
  }
})

interface ChatRequest {
  type: string
  question: string
  game_state?: GameState
  current_recommendation?: string
  lambda?: number
}

async function handleChat(message: ChatRequest, tabId: number): Promise<void> {
  const session = await getSession()
  const mcpUrl = session?.mcp_server_url ?? DEFAULT_MCP_URL

  try {
    const resp = await fetch(`${mcpUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: message.question,
        game_state: message.game_state,
        current_recommendation: message.current_recommendation,
        lambda: message.lambda ?? 0.5,
        session_id: session?.session_id,
      }),
    })
    if (!resp.ok) { console.error('[BG] chat failed', resp.status); return }
    const result = await resp.json()
    chrome.tabs.sendMessage(tabId, { type: 'CHAT_RESPONSE', result })
  } catch (err) {
    console.error('[BG] chat error:', err)
  }
}

// ── Auto-start on pokernow.com ────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!tab.url?.includes('pokernow.com/games/')) return

  const session = await getSession()
  if (session?.source_url === tab.url) return

  try {
    await startSession(tab.url, DEFAULT_MCP_URL)
    console.log('[BG] Auto-started session for', tab.url)
  } catch (err) {
    console.error('[BG] Auto-start failed:', err)
  }
})

function sendAnalysisError(tabId: number, reason: string): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'ANALYSIS_RESULT',
    result: {
      is_active_hand: false, is_hero_turn: false,
      street: 'PREFLOP', hero_cards: [], board: [],
      pot_bb: 0, stack_bb: 0, hero_position: 'UNKNOWN', to_call_bb: 0,
      action: 'WAIT', reasoning: reason, confidence: 0,
    },
  })
}

async function handleScreenshotTick(lambda: number, manualCards: string[]|undefined, actionHistory: string[]|undefined, tabId: number): Promise<void> {
  const session = await getSession()
  const mcpUrl = session?.mcp_server_url ?? DEFAULT_MCP_URL

  const screenshot = await captureScreenshot(tabId)
  if (!screenshot) {
    sendAnalysisError(tabId, 'Screenshot capture failed — ensure pokernow.com tab is visible')
    return
  }

  try {
    const resp = await fetch(`${mcpUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot, lambda, manual_cards: manualCards, action_history: actionHistory, session_id: session?.session_id }),
    })
    if (!resp.ok) {
      sendAnalysisError(tabId, `Server error ${resp.status} — redeploy from Manufact dashboard`)
      console.error('[BG] analyze failed', resp.status)
      return
    }
    const result = await resp.json()
    chrome.tabs.sendMessage(tabId, { type: 'ANALYSIS_RESULT', result })
  } catch (err) {
    sendAnalysisError(tabId, `Cannot reach server — check Manufact deployment`)
    console.error('[BG] analyze error:', err)
  }
}

console.log('[Poker GTO HUD] Background service worker running.')

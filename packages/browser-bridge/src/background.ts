// Background service worker — receives GameEvents from content script,
// forwards them to the MCP server via HTTP POST.

interface GameEvent {
  type: string
  timestamp: number
  payload: Record<string, unknown>
}

interface StoredSession {
  session_id: string
  source_url: string
  mcp_server_url: string
}

const DEFAULT_MCP_URL = 'https://gentle-grass-l9c8r.run.mcp-use.com'

// ── Storage helpers ──────────────────────────────────────────────────────────

async function getSession(): Promise<StoredSession | null> {
  const result = await chrome.storage.local.get('active_session')
  return (result.active_session as StoredSession) ?? null
}

async function setSession(session: StoredSession): Promise<void> {
  await chrome.storage.local.set({ active_session: session })
}

// ── Event forwarding ─────────────────────────────────────────────────────────

async function forwardEvent(event: GameEvent): Promise<void> {
  const session = await getSession()
  if (!session) {
    console.warn('[BG] No active session — drop event', event.type)
    return
  }

  const body = JSON.stringify({ event, session_id: session.session_id })

  try {
    const resp = await fetch(`${session.mcp_server_url}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    if (!resp.ok) {
      console.error('[BG] Ingest failed', resp.status, await resp.text())
    }
  } catch (err) {
    console.error('[BG] Network error forwarding event:', err)
  }
}

// ── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GAME_EVENT') {
    forwardEvent(message.event as GameEvent).catch(console.error)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'START_SESSION') {
    // Called by popup or devtools panel to register the game URL
    const { source_url, mcp_server_url = DEFAULT_MCP_URL } = message as {
      source_url: string; mcp_server_url?: string
    }
    startSession(source_url, mcp_server_url)
      .then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: String(err) }))
    return true  // Keep channel open for async response
  }

  if (message.type === 'GET_SESSION') {
    getSession().then(session => sendResponse({ session })).catch(console.error)
    return true
  }
})

async function startSession(source_url: string, mcp_server_url: string): Promise<StoredSession> {
  const resp = await fetch(`${mcp_server_url}/monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_url }),
  })

  if (!resp.ok) throw new Error(`monitor_start failed: ${resp.status}`)

  const { session_id } = await resp.json() as { session_id: string }
  const session: StoredSession = { session_id, source_url, mcp_server_url }
  await setSession(session)
  return session
}

// ── Tab monitoring ────────────────────────────────────────────────────────────

// Auto-start session when user navigates to a PokerNow game tab
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!tab.url?.includes('pokernow.club/games/')) return

  const session = await getSession()
  if (session?.source_url === tab.url) return  // Already monitoring this tab

  try {
    const mcpUrl = DEFAULT_MCP_URL
    await startSession(tab.url, mcpUrl)
    console.log('[BG] Auto-started session for', tab.url)
  } catch (err) {
    console.error('[BG] Auto-start session failed:', err)
  }
})

console.log('[Poker GTO HUD] Background service worker running.')

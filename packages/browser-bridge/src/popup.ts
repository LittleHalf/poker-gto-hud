export {}

const dot       = document.getElementById('dot')!
const statusEl  = document.getElementById('status')!
const session   = document.getElementById('session')!
const table     = document.getElementById('table')!
const server    = document.getElementById('server')!
const btn       = document.getElementById('btn') as HTMLButtonElement
const log       = document.getElementById('log')!

function setConnected(s: { session_id: string; source_url: string; mcp_server_url: string }) {
  dot.className = 'dot connected'
  statusEl.textContent = 'Connected'
  statusEl.className = 'value ok'
  session.textContent = s.session_id.slice(0, 8) + '…'
  table.textContent = s.source_url.replace('https://', '').slice(0, 30)
  server.textContent = s.mcp_server_url.replace('https://', '').slice(0, 30)
  btn.textContent = 'Reconnect'
  btn.disabled = false
}

function setDisconnected() {
  dot.className = 'dot'
  statusEl.textContent = 'No session'
  statusEl.className = 'value warn'
  session.textContent = '—'
  btn.textContent = 'Start Session'
  btn.disabled = false
}

function setError(msg: string) {
  dot.className = 'dot error'
  statusEl.textContent = 'Error'
  statusEl.className = 'value err'
  log.textContent = msg
}

// Load current session from background
chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (resp) => {
  if (chrome.runtime.lastError) {
    setError(chrome.runtime.lastError.message ?? 'Runtime error')
    return
  }
  if (resp?.session) {
    setConnected(resp.session)
  } else {
    setDisconnected()
  }
})

// Manual start / reconnect from current tab
btn.addEventListener('click', async () => {
  btn.disabled = true
  btn.textContent = 'Starting…'
  log.textContent = ''

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''

  if (!url.includes('pokernow.com')) {
    log.textContent = 'Navigate to a pokernow.com game first.'
    btn.disabled = false
    btn.textContent = 'Start Session'
    return
  }

  chrome.runtime.sendMessage(
    { type: 'START_SESSION', source_url: url },
    (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        setError(resp?.error ?? chrome.runtime.lastError?.message ?? 'Failed')
        btn.disabled = false
        btn.textContent = 'Retry'
        return
      }
      setConnected(resp.session)
    }
  )
})

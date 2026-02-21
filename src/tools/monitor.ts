import { randomUUID } from 'crypto'
import { dbRun, IS_PG } from '../db/client.js'

interface MonitorResult {
  session_id: string
  source_url: string
  started_at: string
}

export const activeSessions = new Map<string, { source_url: string; started_at: string }>()

export async function monitorStart(source_url: string): Promise<MonitorResult> {
  const session_id = randomUUID()
  const started_at = new Date().toISOString()

  activeSessions.set(session_id, { source_url, started_at })

  if (IS_PG) {
    await dbRun(
      `INSERT INTO sessions (id, source_url, started_at, status)
       VALUES (?, ?, ?, 'active')
       ON CONFLICT(id) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         started_at = EXCLUDED.started_at,
         status = EXCLUDED.status`,
      session_id, source_url, started_at
    )
  } else {
    await dbRun(
      `INSERT OR REPLACE INTO sessions (id, source_url, started_at, status)
       VALUES (?, ?, ?, 'active')`,
      session_id, source_url, started_at
    )
  }

  return { session_id, source_url, started_at }
}

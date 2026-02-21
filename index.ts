import { MCPServer, object, text, widget } from 'mcp-use/server'
import { z } from 'zod'
import { monitorStart } from './src/tools/monitor.js'
import { handIngest } from './src/tools/ingest.js'
import { dbLookup } from './src/tools/lookup.js'
import { adviserGetDecision } from './src/tools/adviser.js'
import { sessionSummary } from './src/tools/session.js'
import { handChat, getChatHistory } from './src/tools/chat.js'

// ── Shared schemas ────────────────────────────────────────────────────────────

const GameEventSchema = z.object({
  type: z.enum(['CARD_DEAL', 'ACTION', 'PLAYER_JOIN', 'HAND_START', 'SHOWDOWN', 'POT_WIN']),
  timestamp: z.number(),
  payload: z.record(z.string(), z.unknown()),
})

const GameStateSchema = z.object({
  street: z.enum(['PREFLOP', 'FLOP', 'TURN', 'RIVER']),
  hero_position: z.string().describe('BTN, CO, HJ, SB, BB, UTG, etc.'),
  hero_cards: z.array(z.string()).max(2),
  board: z.array(z.string()).max(5),
  pot_bb: z.number(),
  to_call_bb: z.number(),
  stack_bb: z.number(),
  villains: z.array(z.object({
    player_id: z.string(),
    position: z.string(),
    stack_bb: z.number(),
  })),
  action_history: z.array(z.string()),
})

// ── Server ───────────────────────────────────────────────────────────────────

const server = new MCPServer({
  name: 'poker-gto-hud',
  title: 'Poker GTO + Exploit HUD',
  version: '0.1.0',
  description: 'Real-time GTO vs Exploit poker advisor with live LLM coaching',
  baseUrl: process.env.MCP_URL || 'http://localhost:3000',
  favicon: 'favicon.ico',
  websiteUrl: 'https://manufact.com',
  icons: [{ src: 'icon.svg', mimeType: 'image/svg+xml', sizes: ['512x512'] }],
})

// ── Tool: monitor_start ───────────────────────────────────────────────────────

server.tool(
  {
    name: 'monitor_start',
    description: 'Register a PokerNow game tab URL to monitor. Returns a session_id for all subsequent calls.',
    schema: z.object({
      source_url: z.string().url().describe('URL of the PokerNow game tab'),
    }),
    widget: {
      name: 'poker-hud',
      invoking: 'Starting session...',
      invoked: 'HUD ready',
    },
  },
  async ({ source_url }) => {
    const result = await monitorStart(source_url)
    return widget({
      props: {
        session_id: result.session_id,
        initial_state: null,
        initial_decision: null,
      },
      output: text(`Session started. ID: ${result.session_id}`),
    })
  }
)

// ── Tool: hand_ingest ─────────────────────────────────────────────────────────

server.tool(
  {
    name: 'hand_ingest',
    description: 'Receive a live GameEvent from the Chrome extension and update the hand state machine.',
    schema: z.object({
      event: GameEventSchema,
      session_id: z.string(),
    }),
  },
  async ({ event, session_id }) => {
    const state = await handIngest(event, session_id)
    return object(JSON.parse(JSON.stringify(state)))
  }
)

// ── Tool: db_lookup ───────────────────────────────────────────────────────────

server.tool(
  {
    name: 'db_lookup',
    description: 'Fetch persistent stats and profile for a villain. Returns VPIP, PFR, AF, fold frequencies, tag (FISH/NIT/REG/MANIAC), and any LLM-generated notes.',
    schema: z.object({
      player_id: z.string().describe('Player identifier (SHA-256 of display name)'),
    }),
  },
  async ({ player_id }) => {
    const profile = await dbLookup(player_id)
    return object(JSON.parse(JSON.stringify(profile)))
  }
)

// ── Tool: adviser_get_decision ────────────────────────────────────────────────

server.tool(
  {
    name: 'adviser_get_decision',
    description: 'Get a GTO + exploit recommendation for the current game state. Lambda=0 is pure GTO, Lambda=1 is max exploit.',
    schema: z.object({
      game_state: GameStateSchema,
      lambda: z.number().min(0).max(1).default(0.5).describe('0=GTO, 1=max exploit'),
    }),
    widget: {
      name: 'poker-hud',
      invoking: 'Thinking...',
      invoked: 'Decision ready',
    },
  },
  async ({ game_state, lambda }) => {
    const decision = await adviserGetDecision(game_state, lambda)
    return widget({
      props: {
        session_id: null,
        initial_state: game_state,
        initial_decision: decision,
        lambda,
      },
      output: text(
        `${decision.action}${decision.sizing ? ' ' + decision.sizing : ''} — ${decision.reasoning.slice(0, 80)}...`
      ),
    })
  }
)

// ── Tool: session_summary ─────────────────────────────────────────────────────

server.tool(
  {
    name: 'session_summary',
    description: 'Get session stats: hands played, hero decision breakdown, EV loss.',
    schema: z.object({}),
  },
  async () => {
    const summary = await sessionSummary()
    return object(JSON.parse(JSON.stringify(summary)))
  }
)

// ── Tool: hand_chat ───────────────────────────────────────────────────────────

server.tool(
  {
    name: 'hand_chat',
    description: `Ask Claude anything about the current hand — "what if I raise bigger?", "why fold here?", "how is this villain playing?", "should I deviate from the recommendation?". Claude receives full game context, villain stats, and current recommendation to answer concisely.`,
    schema: z.object({
      question: z.string().min(1).describe('Natural language question about the hand'),
      game_state: GameStateSchema.partial().optional().describe('Current game state snapshot'),
      current_recommendation: z.string().optional().describe('Current adviser recommendation string'),
      lambda: z.number().min(0).max(1).optional().describe('Current λ setting'),
      session_id: z.string().optional().describe('Session ID for chat history persistence'),
    }),
  },
  async ({ question, game_state, current_recommendation, lambda, session_id }) => {
    const history = session_id ? await getChatHistory(session_id, 10) : []
    const result = await handChat(
      question,
      { game_state, current_recommendation, lambda, session_id },
      history
    )
    return object(JSON.parse(JSON.stringify(result)))
  }
)

// ── REST endpoints for Chrome extension ──────────────────────────────────────

// Allow requests from Chrome extensions and any origin
server.app.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  c.res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
})

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS })

server.app.options('/monitor', preflight)
server.app.options('/ingest',  preflight)
server.app.options('/decide',  preflight)
server.app.options('/lookup',  preflight)
server.app.options('/chat',    preflight)

server.app.post('/monitor', async (c) => {
  const { source_url } = await c.req.json<{ source_url: string }>()
  const result = await monitorStart(source_url)
  return c.json(result)
})

server.app.post('/ingest', async (c) => {
  const { event, session_id } = await c.req.json<{ event: Parameters<typeof handIngest>[0]; session_id: string }>()
  const state = await handIngest(event, session_id)
  return c.json(JSON.parse(JSON.stringify(state)))
})

server.app.post('/decide', async (c) => {
  const { game_state, lambda = 0.5 } = await c.req.json<{ game_state: Parameters<typeof adviserGetDecision>[0]; lambda?: number }>()
  const decision = await adviserGetDecision(game_state, lambda)
  return c.json(JSON.parse(JSON.stringify(decision)))
})

server.app.post('/lookup', async (c) => {
  const { player_id } = await c.req.json<{ player_id: string }>()
  const profile = await dbLookup(player_id)
  return c.json(JSON.parse(JSON.stringify(profile)))
})

server.app.post('/chat', async (c) => {
  const { question, game_state, current_recommendation, lambda, session_id } =
    await c.req.json<{ question: string; game_state?: Parameters<typeof handChat>[1]['game_state']; current_recommendation?: string; lambda?: number; session_id?: string }>()
  const history = session_id ? await getChatHistory(session_id, 10) : []
  const result = await handChat(question, { game_state, current_recommendation, lambda, session_id }, history)
  return c.json(JSON.parse(JSON.stringify(result)))
})

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen().then(() => {
  console.log('poker-gto-hud MCP server running')
})

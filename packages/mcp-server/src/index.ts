import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { monitorStart } from './tools/monitor.js'
import { handIngest } from './tools/ingest.js'
import { dbLookup } from './tools/lookup.js'
import { adviserGetDecision } from './tools/adviser.js'
import { sessionSummary } from './tools/session.js'

const server = new McpServer({
  name: 'poker-live-mcp',
  version: '0.1.0',
})

// Tool: monitor_start
server.tool(
  'monitor_start',
  'Register a game tab URL to begin monitoring. Returns a session_id.',
  {
    source_url: z.string().url().describe('The URL of the PokerNow game tab to monitor'),
  },
  async ({ source_url }) => {
    const result = await monitorStart(source_url)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

// Tool: hand_ingest
server.tool(
  'hand_ingest',
  'Receive a live GameEvent from the browser bridge and update the hand state machine.',
  {
    event: z.object({
      type: z.enum(['CARD_DEAL', 'ACTION', 'PLAYER_JOIN', 'HAND_START', 'SHOWDOWN', 'POT_WIN']),
      timestamp: z.number(),
      payload: z.record(z.unknown()),
    }).describe('GameEvent from the Chrome extension'),
    session_id: z.string().describe('Session ID returned by monitor_start'),
  },
  async ({ event, session_id }) => {
    const result = await handIngest(event, session_id)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

// Tool: db_lookup
server.tool(
  'db_lookup',
  'Fetch persistent stats and profile for a villain by player_id.',
  {
    player_id: z.string().describe('SHA-256 hash of the player display name'),
  },
  async ({ player_id }) => {
    const result = await dbLookup(player_id)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

// Tool: adviser_get_decision
server.tool(
  'adviser_get_decision',
  'Get a GTO + exploit recommendation for the current game state.',
  {
    game_state: z.object({
      street: z.enum(['PREFLOP', 'FLOP', 'TURN', 'RIVER']),
      hero_position: z.string().describe('BTN, CO, HJ, SB, BB, UTG, etc.'),
      hero_cards: z.array(z.string()).max(2).describe('e.g. ["Ah", "Kd"]'),
      board: z.array(z.string()).max(5).describe('Community cards e.g. ["Qs", "7d", "2c"]'),
      pot_bb: z.number().describe('Current pot in big blinds'),
      to_call_bb: z.number().describe('Amount to call in big blinds (0 if checking)'),
      stack_bb: z.number().describe('Hero stack in big blinds'),
      villains: z.array(z.object({
        player_id: z.string(),
        position: z.string(),
        stack_bb: z.number(),
      })).describe('Active villains'),
      action_history: z.array(z.string()).describe('Actions this street e.g. ["UTG raise 3x", "BTN call"]'),
    }),
    lambda: z.number().min(0).max(1).describe('0 = pure GTO, 1 = max exploit'),
  },
  async ({ game_state, lambda }) => {
    const result = await adviserGetDecision(game_state, lambda)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

// Tool: session_summary
server.tool(
  'session_summary',
  'Get a summary of the current session: P&L, hands played, biggest pots.',
  {},
  async () => {
    const result = await sessionSummary()
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
)

// Start server
const transport = new StdioServerTransport()
await server.connect(transport)
console.error('poker-live-mcp server running on stdio')

# Poker GTO + Exploit HUD

A real-time poker assistant that captures live game state via a Chrome extension and delivers split-second GTO vs. Exploit advice through an MCP-powered HUD widget.

> **Disclaimer:** This tool is intended for study and practice in private/friendly games only. Review and comply with the terms of service of any poker platform before use.

## Architecture

```
PokerNow Browser Tab
  └─ Chrome Extension (content.ts)
       ├─ MutationObserver → card deals, bets, folds, showdowns
       └─ WebSocket proxy → intercept raw game frames
           │
           ▼ GameEvent (JSON)
  Chrome Background (background.ts)
       └─ HTTP POST → MCP Server
           │
           ▼
  MCP Server (poker-live-mcp)
       ├─ State Machine (current hand)
       ├─ DB Layer (SQLite / Supabase)
       ├─ GTO Engine + Exploit Engine (λ dial)
       └─ Notifications → HUD Widget
           │
           ▼
  HUD React Widget
       ├─ Pot odds, hand strength
       ├─ Villain tags (FISH / NIT / MANIAC / REG)
       ├─ Bold recommendation + "Why?"
       └─ λ slider (Safe GTO ↔ Max Exploit)
```

## Project Structure

```
poker-gto-hud/
├── packages/
│   ├── mcp-server/        # MCP server with GTO/exploit engine
│   └── browser-bridge/    # Chrome Extension MV3
├── supabase/
│   └── schema.sql         # Postgres schema (optional hosted DB)
├── .mcp.json              # MCP server connection config
├── manufact.yml           # Manufact deployment + observability
└── package.json           # Root workspace
```

## Quick Start

### Prerequisites
- Node.js >= 20
- npm >= 9
- Chrome browser

### Setup

```bash
# Install all dependencies
npm install

# Build all packages
npm run build

# Start the MCP server (dev mode)
npm run dev
```

### Loading the Chrome Extension

1. Build the browser bridge: `npm run build --workspace=packages/browser-bridge`
2. Open Chrome → `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" → select `packages/browser-bridge/dist/`
5. Navigate to a PokerNow game tab

### Using the HUD

The HUD widget is served as an MCP resource. Connect via Claude Code or any MCP-compatible client using the `.mcp.json` config.

## MCP Tools

| Tool | Description |
|------|-------------|
| `monitor_start` | Register a game tab to monitor |
| `hand_ingest` | Receive live game events |
| `db_lookup` | Fetch persistent stats for a villain |
| `adviser_get_decision` | Get GTO + exploit recommendation |
| `session_summary` | Session P&L and stats |

## Lambda (λ) Slider

- **λ = 0**: Pure GTO — balanced, unexploitable strategy
- **λ = 0.5**: Hybrid — leans on villain tendencies when confidence is high
- **λ = 1**: Max Exploit — maximally exploits villain's leaks

Confidence scales with sample size: < 5 hands = Low, 5–20 = Medium, > 30 = High.

## Player Tags

Tags are computed live from stats:
- **FISH**: VPIP > 40%, PFR < 10%
- **MANIAC**: VPIP > 40%, PFR > 30%
- **NIT**: VPIP < 15%
- **REG**: Everything else

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DB_CONNECTION_STRING` | SQLite file path or Postgres URL |
| `ANTHROPIC_API_KEY` | For LLM-generated opponent notes |

## License

MIT

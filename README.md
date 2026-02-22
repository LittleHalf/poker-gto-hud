# Poker GTO + Exploit HUD

A real-time poker coaching assistant that uses **Claude Vision** to read live screenshots from PokerNow, classify opponents, and deliver instant GTO vs. exploit recommendations through a heads-up overlay — all powered by an MCP server deployed on Manufact Cloud.

> **Disclaimer:** This tool is intended for study and practice in private/friendly games only. Review and comply with the terms of service of any poker platform before use.

---

## What It Does

Every 2.5 seconds, the Chrome extension captures a screenshot of your PokerNow tab and sends it to a Claude-powered MCP server. Claude Vision reads the screenshot directly — cards, board, pot, stacks, positions, and opponent bets — then returns an optimal action with reasoning. No fragile DOM scraping.

- **Claude Vision reads the game state** from screenshots (hole cards, board, pot, stacks, positions)
- **GTO engine** provides balanced, unexploitable baseline strategy with hand charts by position
- **Exploit engine** adjusts based on villain tendencies (VPIP, PFR, AF, fold-to-3bet, fold-to-cbet)
- **Lambda (λ) slider** blends GTO and exploit in real time — 0 = pure GTO, 1 = max exploit
- **Opponent profiling** tracks stats across hands and auto-tags each player (FISH / NIT / MANIAC / REG)
- **Live chat panel** — ask Claude anything mid-hand: "why fold here?", "what if I raise bigger?", "how is this villain playing?"
- **Multi-street context** — action history from previous streets feeds into each new analysis

---

## Architecture

```
PokerNow Browser Tab
  └── Chrome Extension (Manifest V3)
        ├── content.ts  — injects HUD overlay, sends SCREENSHOT_TICK every 2.5s
        └── background.ts  — captures tab screenshot → POST /analyze to MCP server
                │
                ▼  JPEG screenshot + lambda + action history
        MCP Server (Hono / mcp-use, deployed on Manufact Cloud)
                ├── /analyze   — Claude Vision reads screenshot → ScreenshotAnalysis
                ├── /decide    — Claude Haiku + rule-based GTO/exploit → Decision
                ├── /ingest    — receives GameEvents, updates hand state machine
                ├── /lookup    — returns villain stats + tag from DB
                └── /chat      — conversational hand coaching (Claude Haiku)
                        │
                        ▼  JSON decision + reasoning
        HUD Overlay (injected into PokerNow tab)
                ├── Street, board, hero cards, pot, stack
                ├── Recommended action + sizing + reasoning
                ├── GTO signal vs. Exploit signal
                ├── Villain tags (FISH / NIT / MANIAC / REG)
                ├── Lambda slider
                └── Live chat panel (ask Claude anything)
```

---

## Project Structure

```
poker-gto-hud/
├── index.ts                    # MCP server entry — tools + REST endpoints
├── src/
│   ├── tools/
│   │   ├── adviser.ts          # Claude Vision (analyzeScreenshot) + Claude Haiku (adviserGetDecision)
│   │   ├── chat.ts             # Conversational coaching (handChat)
│   │   ├── ingest.ts           # Hand state machine, event processing
│   │   ├── lookup.ts           # Villain DB lookup
│   │   ├── monitor.ts          # Session registration
│   │   └── session.ts          # Session summary stats
│   ├── engine/
│   │   ├── gto.ts              # Position-based opening/calling ranges, GTO action logic
│   │   ├── exploit.ts          # Villain-stat-driven exploit adjustments
│   │   └── stats.ts            # VPIP/PFR/AF computation + player tagging
│   └── db/
│       └── stats.ts            # SQLite / Postgres persistence for villain stats
├── packages/
│   └── browser-bridge/         # Chrome Extension MV3
│       ├── src/
│       │   ├── content.ts      # HUD overlay, screenshot ticker, chat UI
│       │   └── background.ts   # Service worker, captureVisibleTab, fetch relay
│       └── manifest.json
└── widgets/
    └── poker-hud/              # React widget (rendered inside MCP client / Manufact)
```

---

## Key Technical Decisions

### Claude Vision as the Source of Truth
DOM scraping on PokerNow is brittle — class names change, state is async, and cards are rendered as SVGs. Instead, every 2.5 seconds we capture a JPEG screenshot and send it to Claude Vision (`claude-haiku-4-5-20251001`). The prompt instructs Claude to:
- Count community cards in the center row only to determine street (0=PREFLOP, 3=FLOP, 4=TURN, 5=RIVER)
- Identify hero's turn by detecting CALL/FOLD/CHECK/BET/RAISE buttons
- Read yellow/gold highlighted chip amounts as opponent bets
- Never recommend CHECK when there's an amount to call

### Dual-Engine Advisory (GTO + Exploit)
Two independent engines each produce a signal:
- **GTO engine** — looks up position/street in hand range charts, applies pot odds math
- **Exploit engine** — reads villain stats and deviates (e.g., over-fold vs. high AF, bluff-catch vs. high fold-to-cbet)

Claude Haiku blends both signals using the λ parameter, with natural language reasoning.

### Opponent Profiling
Each player gets a `player_id` (SHA-256 of display name). The DB tracks:
- `vpip_num / vpip_denom` — voluntarily put money in pot
- `pfr_num / pfr_denom` — preflop raise frequency
- `af_bets / af_calls` — aggression factor
- `fold_to_3bet_num / fold_to_3bet_denom`
- `cbet_fold_num / cbet_fold_denom`

Tags update live as hands complete.

---

## Quick Start

### Prerequisites
- Node.js >= 20
- npm >= 9
- Chrome browser
- Anthropic API key

### Local Development

```bash
# Install all dependencies
npm install

# Build the MCP server
npm run build

# Start in dev mode
npm run dev
```

### Loading the Chrome Extension

```bash
# Build the extension
cd packages/browser-bridge && npm run build
```

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `packages/browser-bridge/dist/`
4. Navigate to a PokerNow game — the HUD overlay appears automatically

### Deploying the MCP Server

The server is deployed on [Manufact Cloud](https://manufact.com). Set these environment variables / secrets before deploying:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Required — Claude Vision + Haiku calls |
| `DB_CONNECTION_STRING` | SQLite file path or Postgres URL (default: `./poker.db`) |
| `MCP_URL` | Public URL of the deployed server |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `monitor_start` | Register a PokerNow game tab to monitor; returns `session_id` |
| `hand_ingest` | Receive a live `GameEvent` (CARD_DEAL, ACTION, HAND_START, etc.) |
| `db_lookup` | Fetch persistent stats, tag, and notes for a villain |
| `adviser_get_decision` | Get GTO + exploit recommendation from game state |
| `hand_chat` | Ask Claude anything about the current hand |
| `session_summary` | Session stats: hands played, decision breakdown, EV loss |

## REST Endpoints (Chrome Extension API)

| Endpoint | Body | Response |
|----------|------|----------|
| `POST /analyze` | `{ screenshot, lambda, manual_cards?, action_history? }` | `ScreenshotAnalysis` — full game state + recommended action |
| `POST /decide` | `{ game_state, lambda, screenshot? }` | `Decision` — action, sizing, reasoning |
| `POST /ingest` | `{ event, session_id }` | Updated hand state |
| `POST /lookup` | `{ player_id }` | Villain profile + stats |
| `POST /chat` | `{ question, game_state?, current_recommendation?, lambda?, session_id? }` | Chat response |
| `POST /monitor` | `{ source_url }` | `{ session_id }` |

---

## Lambda (λ) Slider

| Value | Behavior |
|-------|----------|
| λ = 0 | Pure GTO — balanced, unexploitable. Ignores villain tendencies. |
| λ = 0.5 | Balanced — blends GTO with villain reads when confidence is sufficient. |
| λ = 1 | Max Exploit — maximally adjusts based on villain leaks. |

Exploit confidence scales with sample size: < 5 hands = Low, 5–29 = Medium, ≥ 30 = High.

---

## Player Tags

Computed live from accumulated stats:

| Tag | Criteria |
|-----|----------|
| FISH | VPIP > 40%, PFR < 10% — loose passive |
| MANIAC | VPIP > 40%, PFR > 30% — loose aggressive |
| NIT | VPIP < 15% — extremely tight |
| REG | Everything else — standard player |

---

## Manual Card Override

If Claude Vision misreads your hole cards (e.g., low image quality), type your cards in the HUD input (e.g., `Ah Kd`) to override. The override is sent with every subsequent screenshot tick and takes priority over Vision output.

---

## License

MIT

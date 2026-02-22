import Anthropic from '@anthropic-ai/sdk'
import { getGtoAction } from '../engine/gto.js'
import { getExploitAction } from '../engine/exploit.js'
import { getStats } from '../db/stats.js'
import { computeTag } from '../engine/stats.js'

export interface ScreenshotAnalysis {
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

export async function analyzeScreenshot(
  screenshot: string,
  lambda: number,
  manualCards?: string[],
  actionHistory?: string[],
  boardCrop?: string,
  heroCrop?: string,
  actionCrop?: string,
): Promise<ScreenshotAnalysis> {
  const base64 = screenshot.replace(/^data:image\/\w+;base64,/, '')
  const strategyMode = lambda < 0.2 ? 'Pure GTO' : lambda > 0.8 ? 'Max Exploit' : `Balanced GTO/Exploit (λ=${lambda.toFixed(2)})`
  const manualNote = manualCards?.length
    ? `\nHero's hole cards are CONFIRMED as: ${manualCards.join(' ')} (user override — ignore hole cards in all images).`
    : ''
  const historyNote = actionHistory?.length
    ? `\nKnown action history from previous streets:\n${actionHistory.join('\n')}`
    : ''

  // ── Build the content blocks ────────────────────────────────────────────────
  // When crops are available we send 3 focused images with clear labels so
  // Claude never confuses the board region with the hero-cards region.
  const content: Anthropic.ContentBlockParam[] = []

  if (boardCrop && heroCrop && actionCrop) {
    const boardB64  = boardCrop.replace(/^data:image\/\w+;base64,/, '')
    const heroB64   = heroCrop.replace(/^data:image\/\w+;base64,/, '')
    const actionB64 = actionCrop.replace(/^data:image\/\w+;base64,/, '')

    content.push(
      // Image 1 — board region
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: boardB64 } } as Anthropic.ImageBlockParam,
      { type: 'text', text: `IMAGE 1 — BOARD AREA (upper-center of table, extended down to include bet pills):
Task 1 — COUNT BOARD CARDS: Count white rounded-rectangle cards with visible rank+suit in the center horizontal row.
- 0 cards → PREFLOP | 3 cards → FLOP | 4 cards → TURN | 5 cards → RIVER
- Ignore pot number (plain number at top, no card background), ignore "POKER NOW PLUS" banner text

Task 2 — OPPONENT BET: Look for a YELLOW-GREEN rounded pill/oval shape with a number inside it.
- It appears to the LEFT or RIGHT of the board cards, near an opponent's seat
- The number inside is the opponent's bet amount (e.g. "75", "1020")
- An opponent may also show "All In" text next to their name — if so, note their bet amount from the pill
- Record the bet amount; the action area (Image 3) will confirm the exact to_call_bb from the CALL/ALL IN button` } as Anthropic.TextBlockParam,

      // Image 2 — hero cards
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: heroB64 } } as Anthropic.ImageBlockParam,
      { type: 'text', text: `IMAGE 2 — HERO SEAT AREA (bottom-center of the table):
Task 1 — HERO'S HOLE CARDS: The hero's 2 personal cards are face-up with white rounded-rectangle backgrounds near the bottom of this image. Read both cards' rank and suit.${manualNote ? `\nOVERRIDE: ${manualNote}` : ''}

Task 2 — POSITION: Look for a white circular chip with a blue "D" on it anywhere in this image. Whoever has this chip at their seat is the BTN (dealer). The hero's seat is at the bottom of this image — if the D chip is here, hero is BTN. If D chip is not visible here, check the full screenshot.` } as Anthropic.TextBlockParam,

      // Image 3 — action area
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: actionB64 } } as Anthropic.ImageBlockParam,
      { type: 'text', text: `IMAGE 3 — ACTION AREA (bottom of the screen, action buttons):
DETERMINING to_call_bb — check for these button labels (in priority order):
  1. "CALL [number]" (e.g. "CALL 75") → to_call_bb = that number
  2. "ALL IN [number]" (e.g. "ALL IN 860") → to_call_bb = that number (hero calls by going all-in)
  3. Only "CHECK" visible, no CALL or ALL IN → to_call_bb = 0
  4. "BET" or "RAISE" only → to_call_bb = 0
Never return to_call_bb = 0 if a CALL or ALL IN button shows a number.

DETERMINING is_hero_turn:
- "YOUR TURN" text visible → is_hero_turn = true
- "EXTRA TIME ACTIVATED" text visible → is_hero_turn = true (hero is deciding with extra time)
- Bright colored action buttons (green ALL IN/CALL, red FOLD) are active → is_hero_turn = true
- No buttons visible, or buttons appear greyed/inactive → is_hero_turn = false` } as Anthropic.TextBlockParam,

      // Image 4 — full screenshot for context (pot, stacks, position)
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } } as Anthropic.ImageBlockParam,
      { type: 'text', text: `IMAGE 4 — FULL SCREENSHOT (for pot, stacks, and position):
Use this image ONLY for:
- Pot size: plain number at the top-center of the table (NOT a card)
- Hero's stack: number near the hero's seat at the bottom
- Position: white circular chip with blue "D" = BTN. In PokerNow this chip sits directly above or beside a player's cards at their seat. SB/BB text labels appear near other seats.

━━ SYNTHESIZE ALL IMAGES AND RECOMMEND ACTION ━━${historyNote}

Strategy: ${strategyMode}
Consider full hand context. Factor in aggression from previous streets.
Never recommend CHECK if to_call_bb > 0. Never recommend FOLD if to_call_bb = 0.
If no active hand is in progress, set is_active_hand: false.

━━ RESPOND WITH ONLY RAW JSON (no markdown, no code fences) ━━
{"is_active_hand":true,"is_hero_turn":true,"street":"FLOP","hero_cards":["Ts","9d"],"board":["Kd","Kc","8d"],"pot_bb":318,"stack_bb":652,"hero_position":"BB","to_call_bb":278,"action":"FOLD","sizing":null,"reasoning":"T9 has insufficient equity vs KK8 board facing a pot-sized bet","confidence":0.88,"gto_action":"FOLD","exploit_action":"FOLD"}` } as Anthropic.TextBlockParam,
    )
  } else {
    // Fallback: single full screenshot with full prompt
    const prompt = `You are an expert poker GTO coach with computer vision. Analyze this pokernow.com screenshot.${manualNote}${historyNote}

COMMUNITY CARDS: horizontal row in the upper-center of the green felt. Each card has a white rounded-rectangle background, large rank at top, large suit symbol centered. Count only those: 0=PREFLOP, 3=FLOP, 4=TURN, 5=RIVER. The pot number at the top-center is NOT a card.
HERO CARDS: 2 face-up cards at the bottom of the screen near the hero's seat. Do NOT count toward board total.
HERO TURN: active CALL/FOLD/CHECK/BET/RAISE buttons at bottom = is_hero_turn true. Greyed/absent = false.
BETS: CALL button shows to_call_bb. Yellow-green pill shapes near seats show bet amounts.
POT: plain number at top-center of table. STACKS: numbers under player names. POSITION: white circular D chip = BTN.
Strategy: ${strategyMode}. Never CHECK if to_call_bb > 0. Never FOLD if to_call_bb = 0.
If no active hand: is_active_hand: false.
RESPOND WITH ONLY RAW JSON:
{"is_active_hand":true,"is_hero_turn":true,"street":"FLOP","hero_cards":["Ts","9d"],"board":["Kd","Kc","8d"],"pot_bb":318,"stack_bb":652,"hero_position":"BB","to_call_bb":278,"action":"FOLD","sizing":null,"reasoning":"T9 has insufficient equity vs KK8 board","confidence":0.88,"gto_action":"FOLD","exploit_action":"FOLD"}`
    content.push(
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } } as Anthropic.ImageBlockParam,
      { type: 'text', text: prompt } as Anthropic.TextBlockParam,
    )
  }

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content }],
    })

    const text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : ''
    const jsonText = text.replace(/^```(?:json)?|```$/gm, '').trim()
    const parsed = JSON.parse(jsonText) as ScreenshotAnalysis

    // If manual cards provided, override
    if (manualCards?.length) parsed.hero_cards = manualCards

    return parsed
  } catch (err) {
    console.error('[adviser] analyzeScreenshot failed:', err)
    return {
      is_active_hand: false, is_hero_turn: false,
      street: 'PREFLOP', hero_cards: manualCards ?? [], board: [],
      pot_bb: 0, stack_bb: 0, hero_position: 'UNKNOWN', to_call_bb: 0,
      action: 'WAIT',
      reasoning: `Claude Vision error: ${err instanceof Error ? err.message : String(err)}`,
      confidence: 0,
    }
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface GameState {
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER'
  hero_position: string
  hero_cards: string[]
  board: string[]
  pot_bb: number
  to_call_bb: number
  stack_bb: number
  villains: Array<{ player_id: string; position: string; stack_bb: number }>
  action_history: string[]
}

export interface Decision {
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE'
  sizing?: string
  reasoning: string
  confidence: number
  ev_estimate?: number
  gto_action: string
  exploit_action: string
}

export async function adviserGetDecision(
  game_state: GameState,
  lambda: number,
  screenshot?: string   // base64 JPEG data URL from the browser tab
): Promise<Decision> {
  const primaryVillain = game_state.villains[0]
  const villainStats = primaryVillain ? await getStats(primaryVillain.player_id) : null

  // Rule-based signals (used as context for Claude + as fallback)
  const gtoResult = getGtoAction(game_state)
  const exploitResult = getExploitAction(game_state, villainStats)

  const sampleSize = villainStats?.vpip_denom ?? 0
  const confidence = Math.min(1.0, sampleSize / 30)

  // Build villain context string
  let villainContext = 'No villain data yet (new player or first hands).'
  if (villainStats && sampleSize > 0) {
    const tag = computeTag(villainStats)
    const vpip = sampleSize > 0 ? `${(villainStats.vpip_num / sampleSize * 100).toFixed(0)}%` : 'N/A'
    const pfr  = villainStats.pfr_denom > 0 ? `${(villainStats.pfr_num / villainStats.pfr_denom * 100).toFixed(0)}%` : 'N/A'
    const af   = villainStats.af_calls > 0 ? (villainStats.af_bets / villainStats.af_calls).toFixed(2) : 'N/A'
    const f3b  = villainStats.fold_to_3bet_denom > 0 ? `${(villainStats.fold_to_3bet_num / villainStats.fold_to_3bet_denom * 100).toFixed(0)}%` : 'N/A'
    const fcb  = villainStats.cbet_fold_denom > 0 ? `${(villainStats.cbet_fold_num / villainStats.cbet_fold_denom * 100).toFixed(0)}%` : 'N/A'
    villainContext = `[${tag}] ${sampleSize} hands: VPIP=${vpip}, PFR=${pfr}, AF=${af}, Fold→3bet=${f3b}, Fold→Cbet=${fcb}, Stack=${primaryVillain.position} ${primaryVillain.stack_bb}bb`
  }

  const strategyMode = lambda < 0.2 ? 'Pure GTO — ignore villain tendencies'
    : lambda > 0.8 ? 'Maximum exploit — heavily weight villain tendencies'
    : `Balanced (λ=${lambda.toFixed(2)}) — blend GTO with villain reads`

  const prompt = `You are an expert poker GTO coach. Analyze this hand and give the optimal action.

Street: ${game_state.street}
Hero: ${game_state.hero_position}, holding ${game_state.hero_cards.join(' ')}
Board: ${game_state.board.length ? game_state.board.join(' ') : '(none — preflop)'}
Pot: ${game_state.pot_bb}bb | To call: ${game_state.to_call_bb}bb | Hero stack: ${game_state.stack_bb}bb
Recent action: ${game_state.action_history.slice(-6).join(' → ') || 'none'}
Villain: ${villainContext}
Strategy mode: ${strategyMode}
Rule-based signals: GTO=${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}, Exploit=${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}

Respond with ONLY a raw JSON object — no markdown, no code fences:
{"action":"FOLD|CHECK|CALL|BET|RAISE","sizing":"e.g. 2.5x or 67% pot (null if none)","reasoning":"one concise sentence explaining the key reason","confidence":0.0}`

  try {
    // If we have a screenshot, send it to Claude Vision for visual card reading
    const userContent: Anthropic.ContentBlockParam[] = []
    if (screenshot) {
      const base64 = screenshot.replace(/^data:image\/\w+;base64,/, '')
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
      } as Anthropic.ImageBlockParam)
      userContent.push({
        type: 'text',
        text: `This is a LIVE screenshot of the poker game taken right now.

IMPORTANT: Use the screenshot as the source of truth. Read directly from it:
- Hero's hole cards (bottom of table, the player labeled "justin" or with action buttons)
- Community cards on the board (center of table)
- Current street (preflop=no board cards, flop=3 cards, turn=4, river=5)
- Hero's stack size (number shown near hero's seat)
- Hero's position (look for D/BTN chip, SB/BB labels near players)
- Pot size (center of table)
- Amount to call (shown on the CALL button if visible)

The DOM-scraped values below are provided as hints but may be stale — trust the screenshot over them:
${prompt}`,
      } as Anthropic.TextBlockParam)
    } else {
      userContent.push({ type: 'text', text: prompt } as Anthropic.TextBlockParam)
    }

    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = resp.content[0].type === 'text' ? resp.content[0].text.trim() : ''
    // Strip any accidental markdown fences
    const jsonText = text.replace(/^```(?:json)?|```$/gm, '').trim()
    const parsed = JSON.parse(jsonText) as {
      action: Decision['action']
      sizing: string | null
      reasoning: string
      confidence: number
    }

    return {
      action: parsed.action,
      sizing: parsed.sizing ?? undefined,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence ?? confidence,
      gto_action: `${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}`,
      exploit_action: `${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}`,
    }
  } catch (err) {
    // Fallback to rule-based if Claude is unavailable or returns bad JSON
    console.error('[adviser] Claude failed, falling back to rule-based:', err)
    const effectiveLambda = lambda * confidence
    const finalAction = effectiveLambda >= 0.5 ? exploitResult.action : gtoResult.action
    const finalSizing = effectiveLambda >= 0.5 ? exploitResult.sizing : gtoResult.sizing
    const confidenceLabel = sampleSize < 5 ? `Low confidence (${sampleSize} hands)`
      : sampleSize < 30 ? `Medium confidence (${sampleSize} hands)`
      : `High confidence (${sampleSize} hands)`

    return {
      action: finalAction,
      sizing: finalSizing,
      reasoning: effectiveLambda >= 0.5
        ? `${exploitResult.reasoning} ${confidenceLabel}.`
        : `${gtoResult.reasoning}. ${confidenceLabel}.`,
      confidence,
      gto_action: `${gtoResult.action}${gtoResult.sizing ? ' ' + gtoResult.sizing : ''}`,
      exploit_action: `${exploitResult.action}${exploitResult.sizing ? ' ' + exploitResult.sizing : ''}`,
    }
  }
}

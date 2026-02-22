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
  actionHistory?: string[]
): Promise<ScreenshotAnalysis> {
  const base64 = screenshot.replace(/^data:image\/\w+;base64,/, '')
  const strategyMode = lambda < 0.2 ? 'Pure GTO' : lambda > 0.8 ? 'Max Exploit' : `Balanced GTO/Exploit (λ=${lambda.toFixed(2)})`
  const manualNote = manualCards?.length
    ? `\nHero's hole cards are CONFIRMED as: ${manualCards.join(' ')} (user override — do NOT read cards from screenshot).`
    : ''
  const historyNote = actionHistory?.length
    ? `\nKnown action history from previous streets:\n${actionHistory.join('\n')}`
    : ''

  const prompt = `You are an expert poker GTO coach with computer vision. Analyze this pokernow.com screenshot carefully.${manualNote}${historyNote}

━━ STEP 1: READ THE SCREENSHOT ━━

HERO'S HOLE CARDS — located at the BOTTOM of the screen near the hero's seat:
- These are YOUR 2 personal cards, fixed for the entire hand
- They sit at the bottom-left or bottom-center near the hero's chip stack and name
- They do NOT change when community cards are revealed on the board
- Do NOT count these toward the board card total
- If manual cards are provided above, use those instead and skip reading from the screenshot

COMMUNITY CARDS (board) — the cards laid out HORIZONTALLY IN THE UPPER-CENTER of the table:
- These are strictly the shared cards in the center of the green felt, clearly separated from any player's seat area
- They appear in a single horizontal row in the middle of the table
- Do NOT count the hero's 2 hole cards at the bottom — those are personal cards, not board cards
- Do NOT count any face-down cards (card backs) — only face-up cards with visible rank and suit
- Do NOT count cards shown in a promotional overlay or banner
- Count ONLY the face-up cards in that center board row:
  - 0 board cards = PREFLOP
  - EXACTLY 3 board cards = FLOP
  - EXACTLY 4 board cards = TURN
  - EXACTLY 5 board cards = RIVER
- If you see a "POKER NOW PLUS" or any promotional banner overlapping the center, ignore the banner text and count only the actual card faces beneath/around it

HERO IDENTIFICATION — the hero is the player with action buttons at the bottom:
- Look for buttons labeled CALL, FOLD, CHECK, BET, RAISE at the bottom of the screen
- "YOUR TURN" text or highlighted action area also indicates it's hero's turn
- If no action buttons are visible or they appear greyed out → is_hero_turn = false

OPPONENT BETS — in PokerNow, bets appear as a YELLOW-GREEN rounded pill/oval shape with the bet amount number inside it, placed near the betting player's seat:
- The CALL button at the bottom shows the exact amount hero must call → use that as to_call_bb
- If CALL button is visible with a number: to_call_bb = that number, action cannot be CHECK
- If only CHECK button is visible: to_call_bb = 0

POT: the number shown above the board cards labeled "pot"
STACKS: numbers shown below each player's name
POSITION: look for a white circular chip with a blue "D" on it — that player is BTN. Players immediately to the left are SB then BB. Text labels "SB" and "BB" may also appear near those seats.

IMPORTANT — CARDS vs TEXT:
- Cards always appear on a WHITE rectangular background with large, bold rank and suit
- Do NOT read player names, chat text, promotional banners, UI buttons, or stack numbers as cards
- Only read rank (A K Q J T 9 8 7 6 5 4 3 2) + suit (s/h/d/c or ♠♥♦♣) from white-background card elements
- Red suit symbols = hearts or diamonds; black = spades or clubs

━━ STEP 2: RECOMMEND ACTION ━━

Strategy: ${strategyMode}

Consider the full hand context including previous streets. If there was aggression on the flop and we're now on the turn, factor that in. If opponent bet/raised on a previous street, weight their range accordingly.

IMPORTANT: Never recommend CHECK if to_call_bb > 0. Never recommend FOLD if to_call_bb = 0.

If no active hand is in progress, set is_active_hand: false.

━━ RESPOND WITH ONLY RAW JSON (no markdown, no code fences) ━━
{"is_active_hand":true,"is_hero_turn":true,"street":"FLOP","hero_cards":["Ts","9d"],"board":["Kd","Kc","8d"],"pot_bb":318,"stack_bb":652,"hero_position":"BB","to_call_bb":278,"action":"FOLD","sizing":null,"reasoning":"T9 has insufficient equity vs KK8 board facing a pot-sized bet","confidence":0.88,"gto_action":"FOLD","exploit_action":"FOLD"}`

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } } as Anthropic.ImageBlockParam,
          { type: 'text', text: prompt } as Anthropic.TextBlockParam,
        ],
      }],
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

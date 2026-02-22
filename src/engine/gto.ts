import { readFileSync } from 'fs'
import { join } from 'path'
import type { GameState } from '../tools/adviser.js'

// Load precomputed GTO charts from project root data/
let gtoCharts: GtoCharts
try {
  const raw = readFileSync(join(process.cwd(), 'data/gto_charts.json'), 'utf-8')
  gtoCharts = JSON.parse(raw)
} catch {
  gtoCharts = getDefaultCharts()
}

interface GtoCharts {
  preflop: {
    opening_ranges: Record<string, string[]>
    threebet_ranges: Record<string, string[]>
    calling_ranges: Record<string, string[]>
  }
  postflop: {
    cbet_frequency: Record<string, number>
    check_raise_frequency: Record<string, number>
    fold_frequency: Record<string, number>
  }
}

export interface GtoResult {
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE'
  sizing?: string
  reasoning: string
  range_percentile?: number
}

export function getGtoAction(state: GameState): GtoResult {
  if (state.street === 'PREFLOP') return getPreflopGtoAction(state)
  return getPostflopGtoAction(state)
}

// ── Preflop ───────────────────────────────────────────────────────────────────

function getPreflopGtoAction(state: GameState): GtoResult {
  const pos = normalizePosition(state.hero_position)
  const hand = canonicalHand(state.hero_cards)
  const openingRange  = gtoCharts.preflop.opening_ranges[pos]  ?? []
  const threebetRange = gtoCharts.preflop.threebet_ranges[pos] ?? []
  const callingRange  = gtoCharts.preflop.calling_ranges[pos]  ?? []

  const hasRaise = state.action_history.some(a =>
    a.toLowerCase().includes('raise') || a.toLowerCase().includes('3-bet') || a.toLowerCase().includes('3bet')
  )

  if (hasRaise) {
    if (threebetRange.includes(hand)) {
      return { action: 'RAISE', sizing: '3x', reasoning: `${hand} is in GTO 3-bet range from ${pos}` }
    }
    if (callingRange.includes(hand)) {
      return { action: 'CALL', reasoning: `${hand} is in GTO calling range vs raise from ${pos}` }
    }
    return { action: 'FOLD', reasoning: `${hand} is outside GTO defend range from ${pos} vs a raise` }
  }

  if (openingRange.includes(hand)) {
    const sizing = (pos === 'BTN' || pos === 'CO') ? '2.5x' : '3x'
    return { action: 'RAISE', sizing, reasoning: `${hand} is in GTO opening range from ${pos}` }
  }

  return { action: 'FOLD', reasoning: `${hand} is outside GTO opening range from ${pos}` }
}

// ── Postflop ──────────────────────────────────────────────────────────────────

function getPostflopGtoAction(state: GameState): GtoResult {
  const potOdds    = state.to_call_bb > 0 ? state.to_call_bb / (state.pot_bb + state.to_call_bb) : 0
  const texture    = getBoardTexture(state.board)
  const strength   = estimateHandStrength(state.hero_cards, state.board)
  const spr        = state.stack_bb / Math.max(state.pot_bb, 1)

  if (state.to_call_bb === 0) {
    // No bet to face — decide whether to bet or check
    if (strength >= 0.70) {
      const sizing = spr < 3 ? '100% pot' : '67% pot'
      return { action: 'BET', sizing, reasoning: `GTO value bet ${sizing} — strong hand (${pct(strength)}) on ${texture} board` }
    }
    if (strength >= 0.55) {
      return { action: 'BET', sizing: '50% pot', reasoning: `GTO standard bet — top pair/good equity (${pct(strength)}) on ${texture} board` }
    }
    if (strength >= 0.38 && texture === 'dry') {
      return { action: 'BET', sizing: '33% pot', reasoning: `GTO probe — dry ${texture} board, balanced range bets small` }
    }
    // Check medium/weak hands to protect checking range
    return { action: 'CHECK', reasoning: `GTO check — medium/weak equity (${pct(strength)}) on ${texture} board, protect check range` }
  }

  // Facing a bet
  if (strength >= 0.72) {
    return { action: 'RAISE', sizing: '2.5x', reasoning: `GTO raise — strong hand (${pct(strength)}), build pot and deny equity` }
  }
  if (strength > potOdds + 0.08) {
    return { action: 'CALL', reasoning: `GTO call — equity ${pct(strength)} exceeds pot odds ${pct(potOdds)}` }
  }
  if (strength < potOdds - 0.05) {
    return { action: 'FOLD', reasoning: `GTO fold — equity ${pct(strength)} below pot odds ${pct(potOdds)}` }
  }
  return { action: 'CALL', reasoning: `GTO borderline call — equity ${pct(strength)} ≈ pot odds ${pct(potOdds)}` }
}

// ── Hand strength estimation (exported for exploit engine) ────────────────────

const RANKS = '23456789TJQKA'
const rankIdx = (r: string) => RANKS.indexOf(r.toUpperCase())

export function estimateHandStrength(heroCards: string[], board: string[]): number {
  if (heroCards.length < 2 || board.length < 3) return 0.40

  const hero   = heroCards.map(c => c.toUpperCase())
  const boardU = board.map(c => c.toUpperCase())
  const all    = [...hero, ...boardU]

  const allRanks  = all.map(c => c[0])
  const allSuits  = all.map(c => c[1])
  const heroRanks = hero.map(c => c[0])
  const heroSuits = hero.map(c => c[1])
  const brdRanks  = boardU.map(c => c[0])

  // Rank counts across all 5-7 cards
  const rCount = new Map<string, number>()
  for (const r of allRanks) rCount.set(r, (rCount.get(r) ?? 0) + 1)

  // Suit counts
  const sCount = new Map<string, number>()
  for (const s of allSuits) sCount.set(s, (sCount.get(s) ?? 0) + 1)

  const maxRank = Math.max(...rCount.values())
  const pairs   = [...rCount.values()].filter(v => v >= 2).length

  // Flush / flush draw
  const hasFlush     = [...sCount.values()].some(v => v >= 5)
  const hasFlushDraw = heroSuits.some(s => (sCount.get(s) ?? 0) >= 4)

  // Straight check
  const uIdx = [...new Set(allRanks.map(rankIdx))].sort((a, b) => a - b)
  let maxConsec = 1, consec = 1
  for (let i = 1; i < uIdx.length; i++) {
    consec = uIdx[i] === uIdx[i - 1] + 1 ? consec + 1 : 1
    maxConsec = Math.max(maxConsec, consec)
  }
  const wheel       = [0,1,2,3,12].every(i => uIdx.includes(i))
  const hasStraight = maxConsec >= 5 || wheel
  const hasStraightDraw = maxConsec >= 4

  // ── Made hand strength ────────────────────────────────────────────────────
  if (hasStraight && hasFlush) return 0.99
  if (maxRank >= 4)             return 0.97    // Quads
  if (maxRank === 3 && pairs >= 2) return 0.94 // Full house
  if (hasFlush)                 return 0.88
  if (hasStraight)              return 0.85
  if (maxRank === 3)            return 0.80    // Trips

  if (pairs >= 2) {
    const brdPaired = brdRanks.some((r, i, a) => a.indexOf(r) !== i)
    return brdPaired ? 0.65 : 0.72             // Two pair
  }

  if (pairs === 1) {
    const pairedRank = [...rCount.entries()].find(([, v]) => v >= 2)?.[0]
    if (!pairedRank) return 0.50
    const heroMadePair = heroRanks.includes(pairedRank)
    const sortedBrd    = brdRanks.map(rankIdx).sort((a, b) => b - a)
    if (!heroMadePair) return 0.30             // Board pair only (hero unpaired)
    const pr = rankIdx(pairedRank)
    if (pr > sortedBrd[0]) return 0.72         // Overpair
    if (pr === sortedBrd[0]) return 0.62       // Top pair
    if (pr === sortedBrd[1]) return 0.52       // Middle pair
    return 0.42                                 // Bottom pair
  }

  // No pair — draws or air
  const topBrd  = Math.max(...brdRanks.map(rankIdx))
  const ovrcrds = heroRanks.filter(r => rankIdx(r) > topBrd).length

  if (hasFlushDraw && hasStraightDraw) return 0.46
  if (hasFlushDraw)  return 0.38
  if (hasStraightDraw) return 0.32
  if (ovrcrds >= 2)  return 0.28
  if (ovrcrds === 1) return 0.22
  return 0.15                                   // Air
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normalizePosition(pos: string | null): string {
  if (!pos) return 'BTN'
  const cleaned = pos.toLowerCase().replace(/_\d+$/, '').replace(/^seat\d*$/, 'btn').trim()
  const map: Record<string, string> = {
    'button': 'BTN', 'btn': 'BTN', 'd': 'BTN', 'dealer': 'BTN',
    'cutoff': 'CO',  'co': 'CO',
    'hijack': 'HJ',  'hj': 'HJ',
    'sb': 'SB', 'small blind': 'SB', 'small_blind': 'SB',
    'bb': 'BB', 'big blind': 'BB',   'big_blind': 'BB',
    'utg': 'UTG', 'under the gun': 'UTG',
    'mp': 'MP',  'middle position': 'MP',
    'unknown': 'BTN',
  }
  return map[cleaned] ?? cleaned.toUpperCase()
}

function canonicalHand(cards: string[]): string {
  if (cards.length < 2) return 'unknown'
  const [c1, c2] = cards.map(c => c.toUpperCase())
  const r1 = c1[0], s1 = c1[1], r2 = c2[0], s2 = c2[1]
  const suited = s1 === s2 ? 's' : 'o'
  return rankIdx(r1) >= rankIdx(r2) ? `${r1}${r2}${suited}` : `${r2}${r1}${suited}`
}

export function getBoardTexture(board: string[]): string {
  if (board.length === 0) return 'dry'
  const suits   = board.map(c => c.slice(-1))
  const unique  = new Set(suits).size
  const rankSet = board.map(c => rankIdx(c[0])).sort((a, b) => a - b)
  let maxGap = 0
  for (let i = 1; i < rankSet.length; i++) maxGap = Math.max(maxGap, rankSet[i] - rankSet[i-1])

  if (unique === 1) return 'monotone'
  if (unique === 2) return 'two-tone'
  if (maxGap <= 2 && board.length >= 3) return 'connected'
  return 'rainbow'
}

function pct(n: number): string { return `${(n * 100).toFixed(0)}%` }

// ── Default charts ────────────────────────────────────────────────────────────

function getDefaultCharts(): GtoCharts {
  const premiums    = ['AAs', 'KKs', 'QQs', 'JJs', 'TTs', 'AKs', 'AKo', 'AQs']
  const broadOpen   = ['99s', '88s', '77s', '66s', 'AJs', 'AJo', 'ATs', 'ATo', 'KQs', 'KQo', 'AQo', 'QJs', 'QJo', 'JTs']
  const midOpen     = ['55s', '44s', '33s', '22s', 'A9s', 'A9o', 'A8s', 'A7s', 'A6s', 'A5s', 'A4s', 'A3s', 'A2s',
                       'KJs', 'KJo', 'KTs', 'KTo', 'QTs', 'QTo', 'J9s', 'T9s', 'T8s', '98s', '97s', '87s', '76s']
  const lateOpen    = ['K9s', 'K9o', 'Q9s', 'J8s', 'T7s', '96s', '86s', '75s', '65s', '64s', '54s', '53s',
                       'K8s', 'K7s', 'K6s', 'K5s', 'K4s', 'Q8s', 'J7s', 'A5o', 'A4o', 'A3o', 'A2o']
  const threebetHands = ['AAs', 'KKs', 'QQs', 'JJs', 'TTs', 'AKs', 'AKo', 'AQs', 'AQo', 'AJs', 'KQs']
  const callHands   = ['99s', '88s', '77s', '66s', '55s', '44s', '33s', '22s',
                       'AQo', 'AJs', 'AJo', 'ATs', 'KQs', 'KQo', 'KJs', 'QJs', 'JTs', 'T9s', '98s']

  return {
    preflop: {
      opening_ranges: {
        UTG: [...premiums, ...broadOpen.slice(0, 8)],
        MP:  [...premiums, ...broadOpen],
        HJ:  [...premiums, ...broadOpen, ...midOpen.slice(0, 12)],
        CO:  [...premiums, ...broadOpen, ...midOpen],
        BTN: [...premiums, ...broadOpen, ...midOpen, ...lateOpen],
        SB:  [...premiums, ...broadOpen, ...midOpen, ...lateOpen.slice(0, 15)],
        BB:  [],
      },
      threebet_ranges: {
        UTG: threebetHands.slice(0, 6),
        MP:  threebetHands.slice(0, 8),
        HJ:  threebetHands.slice(0, 9),
        CO:  threebetHands,
        BTN: [...threebetHands, 'A5s', 'A4s', 'A3s', 'A2s'],
        SB:  threebetHands,
        BB:  [...threebetHands, 'A5s', 'A4s'],
      },
      calling_ranges: {
        UTG: callHands.slice(0, 5),
        MP:  callHands.slice(0, 8),
        HJ:  callHands.slice(0, 12),
        CO:  callHands,
        BTN: [...callHands, 'A9o', 'A8o', 'K9s', 'QTs', 'J9s', '87s', '76s'],
        SB:  callHands,
        BB:  [...callHands, 'A9o', 'A8o', 'K9s', 'Q9s', 'J9s', 'T8s', '97s', '86s', '75s'],
      },
    },
    postflop: {
      cbet_frequency:        { dry: 0.65, rainbow: 0.55, 'two-tone': 0.45, monotone: 0.30, connected: 0.40 },
      check_raise_frequency: { dry: 0.15, rainbow: 0.20, 'two-tone': 0.25, monotone: 0.20, connected: 0.22 },
      fold_frequency:        { dry: 0.35, rainbow: 0.40, 'two-tone': 0.45, monotone: 0.50, connected: 0.42 },
    },
  }
}

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
    opening_ranges: Record<string, string[]>    // position → hands
    threebet_ranges: Record<string, string[]>   // position → hands
    calling_ranges: Record<string, string[]>    // position → hands
  }
  postflop: {
    cbet_frequency: Record<string, number>      // board_texture → frequency
    check_raise_frequency: Record<string, number>
    fold_frequency: Record<string, number>
  }
}

export interface GtoResult {
  action: 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE'
  sizing?: string
  reasoning: string
  range_percentile?: number  // How strong hero's hand is within range (0–1)
}

export function getGtoAction(state: GameState): GtoResult {
  if (state.street === 'PREFLOP') {
    return getPreflopGtoAction(state)
  }
  return getPostflopGtoAction(state)
}

function getPreflopGtoAction(state: GameState): GtoResult {
  const pos = normalizePosition(state.hero_position)
  const hand = canonicalHand(state.hero_cards)
  const openingRange = gtoCharts.preflop.opening_ranges[pos] ?? []
  const threebetRange = gtoCharts.preflop.threebet_ranges[pos] ?? []
  const callingRange = gtoCharts.preflop.calling_ranges[pos] ?? []

  const hasRaise = state.action_history.some(a => a.toLowerCase().includes('raise') || a.toLowerCase().includes('3-bet'))

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
    const sizingBb = pos === 'BTN' || pos === 'CO' ? '2.5x' : '3x'
    return { action: 'RAISE', sizing: sizingBb, reasoning: `${hand} is in GTO opening range from ${pos}` }
  }

  return { action: 'FOLD', reasoning: `${hand} is outside GTO opening range from ${pos}` }
}

function getPostflopGtoAction(state: GameState): GtoResult {
  const potOdds = state.to_call_bb > 0 ? state.to_call_bb / (state.pot_bb + state.to_call_bb) : 0
  const boardTexture = getBoardTexture(state.board)
  const cbetFreq = gtoCharts.postflop.cbet_frequency[boardTexture] ?? 0.5
  const foldFreq = gtoCharts.postflop.fold_frequency[boardTexture] ?? 0.4

  if (state.to_call_bb === 0) {
    // Facing check — decide to bet or check
    if (Math.random() < cbetFreq) {
      return {
        action: 'BET',
        sizing: '67% pot',
        reasoning: `GTO c-bet frequency on ${boardTexture} board is ${(cbetFreq * 100).toFixed(0)}%`,
      }
    }
    return {
      action: 'CHECK',
      reasoning: `GTO check frequency on ${boardTexture} board is ${((1 - cbetFreq) * 100).toFixed(0)}%`,
    }
  }

  // Facing a bet — pot odds decision
  const handStrength = estimateHandStrength(state.hero_cards, state.board)
  if (handStrength > potOdds + 0.1) {
    return {
      action: 'CALL',
      reasoning: `Hand strength ${(handStrength * 100).toFixed(0)}% exceeds pot odds ${(potOdds * 100).toFixed(0)}%`,
    }
  }

  if (handStrength < foldFreq) {
    return {
      action: 'FOLD',
      reasoning: `Hand strength ${(handStrength * 100).toFixed(0)}% below GTO fold threshold on ${boardTexture} board`,
    }
  }

  return {
    action: 'CALL',
    reasoning: `Borderline call — hand strength ${(handStrength * 100).toFixed(0)}% near pot odds ${(potOdds * 100).toFixed(0)}%`,
  }
}

function normalizePosition(pos: string | null): string {
  if (!pos) return 'BTN'
  const map: Record<string, string> = {
    'button': 'BTN', 'btn': 'BTN',
    'cutoff': 'CO', 'co': 'CO',
    'hijack': 'HJ', 'hj': 'HJ',
    'sb': 'SB', 'small blind': 'SB',
    'bb': 'BB', 'big blind': 'BB',
    'utg': 'UTG', 'under the gun': 'UTG',
    'mp': 'MP', 'middle position': 'MP',
  }
  return map[pos.toLowerCase()] ?? pos.toUpperCase()
}

function canonicalHand(cards: string[]): string {
  if (cards.length < 2) return 'unknown'
  const ranks = '23456789TJQKA'
  const [c1, c2] = cards.map(c => c.toUpperCase())
  const r1 = c1[0], s1 = c1[1]
  const r2 = c2[0], s2 = c2[1]
  const suited = s1 === s2 ? 's' : 'o'
  if (ranks.indexOf(r1) >= ranks.indexOf(r2)) {
    return `${r1}${r2}${suited}`
  }
  return `${r2}${r1}${suited}`
}

function getBoardTexture(board: string[]): string {
  if (board.length === 0) return 'dry'
  const suits = board.map(c => c.slice(-1))
  const uniqueSuits = new Set(suits).size
  if (uniqueSuits === 1) return 'monotone'
  if (uniqueSuits === 2) return 'two-tone'
  return 'rainbow'
}

// Simplified hand strength heuristic (0–1)
function estimateHandStrength(heroCards: string[], board: string[]): number {
  if (heroCards.length < 2 || board.length < 3) return 0.4
  const allCards = [...heroCards, ...board].map(c => c.toUpperCase())
  const ranks = allCards.map(c => c[0])
  const rankCounts = new Map<string, number>()
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1)
  const maxCount = Math.max(...rankCounts.values())

  if (maxCount >= 4) return 0.97  // Quads
  if (maxCount === 3) return 0.85  // Trips / FH
  const pairs = [...rankCounts.values()].filter(v => v === 2).length
  if (pairs >= 2) return 0.75      // Two pair
  if (pairs === 1) return 0.55     // One pair
  return 0.30                       // High card
}

function getDefaultCharts(): GtoCharts {
  const premiums = ['AAs', 'KKs', 'QQs', 'JJs', 'TTs', 'AKs', 'AKo', 'AQs']
  const broadOpeners = ['99s', '88s', '77s', '66s', 'AJs', 'AJo', 'ATs', 'KQs', 'KQo', 'AQo', 'QJs', 'JTs']
  const latePosition = ['55s', '44s', '33s', '22s', 'A9s', 'A8s', 'A7s', 'K9s', 'KTs', 'QTs', 'J9s', 'T9s']
  const threebetHands = ['AAs', 'KKs', 'QQs', 'JJs', 'AKs', 'AKo']
  const callHands = ['99s', '88s', '77s', '66s', 'AQo', 'AJs', 'KQs']

  return {
    preflop: {
      opening_ranges: {
        UTG: premiums,
        MP: [...premiums, ...broadOpeners.slice(0, 6)],
        HJ: [...premiums, ...broadOpeners],
        CO: [...premiums, ...broadOpeners, ...latePosition.slice(0, 8)],
        BTN: [...premiums, ...broadOpeners, ...latePosition],
        SB: [...premiums, ...broadOpeners, ...latePosition.slice(0, 10)],
        BB: [],
      },
      threebet_ranges: {
        UTG: threebetHands,
        MP: threebetHands,
        HJ: threebetHands,
        CO: [...threebetHands, 'TTs', 'AQs'],
        BTN: [...threebetHands, 'TTs', 'AQs', 'AQo', 'KQs'],
        SB: [...threebetHands, 'TTs', 'AQs'],
        BB: [...threebetHands, 'TTs'],
      },
      calling_ranges: {
        UTG: callHands.slice(0, 3),
        MP: callHands.slice(0, 4),
        HJ: callHands.slice(0, 5),
        CO: callHands,
        BTN: [...callHands, '55s', '44s', '33s', '22s'],
        SB: callHands,
        BB: [...callHands, '55s', '44s'],
      },
    },
    postflop: {
      cbet_frequency: {
        'dry': 0.65,
        'rainbow': 0.55,
        'two-tone': 0.45,
        'monotone': 0.30,
      },
      check_raise_frequency: {
        'dry': 0.15,
        'rainbow': 0.20,
        'two-tone': 0.25,
        'monotone': 0.20,
      },
      fold_frequency: {
        'dry': 0.35,
        'rainbow': 0.40,
        'two-tone': 0.45,
        'monotone': 0.50,
      },
    },
  }
}

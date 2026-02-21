/**
 * Poker GTO HUD Widget
 *
 * React component that connects to the poker-live-mcp server via the MCP
 * resource pattern. Renders live game state, villain tags, and adviser
 * recommendations with a λ slider.
 *
 * Usage (mcp-use pattern):
 *   import Hud from './resources/hud.tsx'
 *   <Hud mcpUrl="http://localhost:3000" sessionId={sessionId} />
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type PlayerTag = 'FISH' | 'MANIAC' | 'NIT' | 'REG' | 'UNKNOWN'
type Street = 'WAITING' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'HAND_OVER'
type Action = 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE'

interface Decision {
  action: Action
  sizing?: string
  reasoning: string
  confidence: number
  ev_estimate?: number
  gto_action: string
  exploit_action: string
}

interface VillainInfo {
  player_id: string
  position: string
  name: string
  tag: PlayerTag
  stack_bb: number
}

interface GameState {
  street: Street
  hero_position: string | null
  hero_cards: string[]
  board: string[]
  pot_bb: number
  to_call_bb: number
  stack_bb: number
  villains: VillainInfo[]
  action_history: string[]
}

interface SessionStats {
  hands_played: number
  session_start: string | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TAG_COLORS: Record<PlayerTag, string> = {
  FISH: '#3b82f6',      // blue
  MANIAC: '#ef4444',    // red
  NIT: '#6b7280',       // gray
  REG: '#10b981',       // green
  UNKNOWN: '#9ca3af',   // light gray
}

const ACTION_COLORS: Record<Action, string> = {
  FOLD: '#ef4444',
  CHECK: '#6b7280',
  CALL: '#3b82f6',
  BET: '#f59e0b',
  RAISE: '#8b5cf6',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CardDisplay({ card }: { card: string }) {
  const rank = card.slice(0, -1)
  const suit = card.slice(-1)
  const suitSymbols: Record<string, string> = { h: '♥', d: '♦', s: '♠', c: '♣' }
  const isRed = suit === 'h' || suit === 'd'
  return (
    <span style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
      background: '#fff', border: '1px solid #374151', borderRadius: 4,
      padding: '2px 6px', margin: '0 2px', minWidth: 28,
      color: isRed ? '#dc2626' : '#111827',
      fontWeight: 700, fontSize: 14, lineHeight: 1.2,
    }}>
      <span>{rank}</span>
      <span style={{ fontSize: 12 }}>{suitSymbols[suit] ?? suit}</span>
    </span>
  )
}

function TagBadge({ tag }: { tag: PlayerTag }) {
  return (
    <span style={{
      background: TAG_COLORS[tag], color: '#fff', borderRadius: 4,
      padding: '1px 5px', fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
    }}>
      {tag}
    </span>
  )
}

function ConfidenceBar({ confidence, sampleSize }: { confidence: number; sampleSize: number }) {
  const filled = Math.round(confidence * 10)
  const label = sampleSize < 5 ? 'Low' : sampleSize < 30 ? 'Medium' : 'High'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span style={{ color: '#9ca3af' }}>Confidence:</span>
      <span style={{ letterSpacing: 1, color: '#d1d5db' }}>
        {'█'.repeat(filled)}{'░'.repeat(10 - filled)}
      </span>
      <span style={{ color: '#e5e7eb' }}>{label} ({sampleSize} hands)</span>
    </div>
  )
}

// ── Main HUD Component ────────────────────────────────────────────────────────

interface HudProps {
  mcpUrl?: string
  sessionId?: string
}

export default function PokerHud({ mcpUrl = 'http://localhost:3000', sessionId }: HudProps) {
  const [gameState, setGameState] = useState<GameState>({
    street: 'WAITING',
    hero_position: null,
    hero_cards: [],
    board: [],
    pot_bb: 0,
    to_call_bb: 0,
    stack_bb: 100,
    villains: [],
    action_history: [],
  })
  const [decision, setDecision] = useState<Decision | null>(null)
  const [lambda, setLambda] = useState(0.5)
  const [sessionStats, setSessionStats] = useState<SessionStats>({ hands_played: 0, session_start: null })
  const [loading, setLoading] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch adviser decision
  const fetchDecision = useCallback(async (state: GameState, lam: number) => {
    if (state.street === 'WAITING' || state.street === 'HAND_OVER') return
    setLoading(true)
    setError(null)

    try {
      const resp = await fetch(`${mcpUrl}/adviser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_state: {
            street: state.street,
            hero_position: state.hero_position,
            hero_cards: state.hero_cards,
            board: state.board,
            pot_bb: state.pot_bb,
            to_call_bb: state.to_call_bb,
            stack_bb: state.stack_bb,
            villains: state.villains.map(v => ({
              player_id: v.player_id,
              position: v.position,
              stack_bb: v.stack_bb,
            })),
            action_history: state.action_history,
          },
          lambda: lam,
        }),
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const result = await resp.json() as Decision
      setDecision(result)
      setFlash(true)
      setTimeout(() => setFlash(false), 600)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [mcpUrl])

  // Debounced lambda changes
  const handleLambdaChange = (val: number) => {
    setLambda(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchDecision(gameState, val)
    }, 200)
  }

  // Poll game state from MCP server
  useEffect(() => {
    if (!sessionId) return
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${mcpUrl}/state?session_id=${sessionId}`)
        if (!resp.ok) return
        const state = await resp.json() as GameState
        setGameState(prev => {
          const changed = JSON.stringify(prev) !== JSON.stringify(state)
          if (changed) fetchDecision(state, lambda)
          return state
        })
      } catch { /* network error — silently continue */ }
    }, 500)

    // Session stats
    const statsInterval = setInterval(async () => {
      try {
        const resp = await fetch(`${mcpUrl}/session_summary`)
        if (resp.ok) setSessionStats(await resp.json() as SessionStats)
      } catch { /* ignore */ }
    }, 10000)

    return () => { clearInterval(interval); clearInterval(statsInterval) }
  }, [sessionId, mcpUrl, lambda, fetchDecision])

  // ── Mock mode (no sessionId) ──────────────────────────────────────────────
  useEffect(() => {
    if (sessionId) return
    // Load with demo data for widget preview
    setGameState({
      street: 'PREFLOP',
      hero_position: 'BTN',
      hero_cards: ['Ah', 'Kd'],
      board: [],
      pot_bb: 1.5,
      to_call_bb: 1,
      stack_bb: 100,
      villains: [
        { player_id: 'v1', position: 'UTG', name: 'AlphaDog', tag: 'NIT', stack_bb: 87 },
        { player_id: 'v2', position: 'HJ', name: 'FishFace', tag: 'FISH', stack_bb: 220 },
        { player_id: 'v3', position: 'CO', name: 'Maniac99', tag: 'MANIAC', stack_bb: 45 },
        { player_id: 'v4', position: 'SB', name: 'ProfReg', tag: 'REG', stack_bb: 100 },
      ],
      action_history: ['UTG fold', 'HJ fold', 'CO raise 3x', 'SB fold'],
    })
    setDecision({
      action: 'RAISE',
      sizing: '3x',
      reasoning: 'CO (MANIAC) raises frequently; 3-bet for value with AKo. Villain folds to 3-bets 72% of the time.',
      confidence: 0.87,
      ev_estimate: 2.3,
      gto_action: 'RAISE 3x',
      exploit_action: 'RAISE 3x',
    })
    setSessionStats({ hands_played: 23, session_start: new Date(Date.now() - 3600000).toISOString() })
  }, [sessionId])

  const potOdds = gameState.to_call_bb > 0
    ? ((gameState.to_call_bb / (gameState.pot_bb + gameState.to_call_bb)) * 100).toFixed(0)
    : null

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: 380, background: '#111827', color: '#f9fafb',
      fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13,
      borderRadius: 10, border: '1px solid #374151',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)', overflow: 'hidden',
    }}>
      {/* Top bar */}
      <div style={{
        background: '#1f2937', padding: '8px 14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid #374151',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {gameState.hero_cards.map((c, i) => <CardDisplay key={i} card={c} />)}
          {gameState.hero_cards.length === 0 && (
            <span style={{ color: '#6b7280' }}>Waiting for cards...</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#9ca3af' }}>
          <span>Pot: <strong style={{ color: '#f9fafb' }}>{gameState.pot_bb.toFixed(1)}bb</strong></span>
          {potOdds && <span>Odds: <strong style={{ color: '#f9fafb' }}>{potOdds}%</strong></span>}
          <span style={{ background: '#374151', borderRadius: 4, padding: '1px 6px', color: '#e5e7eb' }}>
            {gameState.hero_position ?? '—'}
          </span>
        </div>
      </div>

      {/* Table view — villain seats */}
      <div style={{ padding: '8px 14px', borderBottom: '1px solid #374151' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {gameState.villains.map(v => (
            <div key={v.player_id} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#1f2937', borderRadius: 6, padding: '3px 8px',
              border: '1px solid #374151', fontSize: 11,
            }}>
              <TagBadge tag={v.tag} />
              <span style={{ color: '#9ca3af' }}>{v.position}</span>
              <span style={{ color: '#e5e7eb' }}>{v.name}</span>
              <span style={{ color: '#6b7280' }}>{v.stack_bb.toFixed(0)}bb</span>
            </div>
          ))}
          {gameState.hero_position && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              background: '#065f46', borderRadius: 6, padding: '3px 8px',
              border: '1px solid #10b981', fontSize: 11,
            }}>
              <span style={{ color: '#34d399' }}>◆</span>
              <span style={{ color: '#6ee7b7' }}>{gameState.hero_position} (YOU)</span>
              <span style={{ color: '#a7f3d0' }}>{gameState.stack_bb.toFixed(0)}bb</span>
            </div>
          )}
        </div>
      </div>

      {/* Board cards */}
      {gameState.board.length > 0 && (
        <div style={{ padding: '6px 14px', borderBottom: '1px solid #374151', display: 'flex', gap: 4 }}>
          <span style={{ color: '#6b7280', fontSize: 11, marginRight: 4 }}>{gameState.street}:</span>
          {gameState.board.map((c, i) => <CardDisplay key={i} card={c} />)}
        </div>
      )}

      {/* Decision box */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid #374151',
        background: flash ? '#1e3a2f' : 'transparent',
        transition: 'background 0.3s',
      }}>
        {loading && <div style={{ color: '#6b7280', fontSize: 12 }}>Thinking...</div>}
        {error && <div style={{ color: '#ef4444', fontSize: 12 }}>Error: {error}</div>}
        {decision && !loading && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 18 }}>▶</span>
              <span style={{
                fontSize: 16, fontWeight: 700,
                color: ACTION_COLORS[decision.action] ?? '#f9fafb',
              }}>
                {decision.action}{decision.sizing ? ` ${decision.sizing}` : ''}
              </span>
              {decision.ev_estimate !== undefined && (
                <span style={{ marginLeft: 'auto', color: '#10b981', fontSize: 12 }}>
                  EV: +{decision.ev_estimate.toFixed(1)}bb
                </span>
              )}
            </div>
            <div
              style={{ color: '#d1d5db', fontSize: 12, cursor: 'pointer' }}
              onClick={() => setShowReasoning(r => !r)}
            >
              <span style={{ color: '#6b7280' }}>Why: </span>
              {showReasoning
                ? decision.reasoning
                : decision.reasoning.slice(0, 60) + (decision.reasoning.length > 60 ? '... ▼' : '')}
            </div>
            {showReasoning && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
                <div>GTO: {decision.gto_action}</div>
                <div>Exploit: {decision.exploit_action}</div>
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <ConfidenceBar
                confidence={decision.confidence}
                sampleSize={Math.round(decision.confidence * 30)}
              />
            </div>
          </>
        )}
        {!decision && !loading && (
          <div style={{ color: '#6b7280', fontSize: 12 }}>Waiting for action...</div>
        )}
      </div>

      {/* Lambda slider */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #374151' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
          <span>Safe GTO</span>
          <span style={{ color: '#9ca3af' }}>λ = {lambda.toFixed(2)}</span>
          <span>Max Exploit</span>
        </div>
        <input
          type="range" min={0} max={1} step={0.05}
          value={lambda}
          onChange={e => handleLambdaChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: '#8b5cf6' }}
        />
      </div>

      {/* Session footer */}
      <div style={{
        padding: '6px 14px', background: '#1f2937',
        display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280',
      }}>
        <span>
          Hands: <strong style={{ color: '#e5e7eb' }}>{sessionStats.hands_played}</strong>
        </span>
        <span style={{ color: '#374151' }}>poker-gto-hud v0.1</span>
        <span>
          Street: <strong style={{ color: '#e5e7eb' }}>{gameState.street}</strong>
        </span>
      </div>
    </div>
  )
}

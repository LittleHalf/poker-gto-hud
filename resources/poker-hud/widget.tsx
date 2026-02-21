import {
  McpUseProvider,
  useWidget,
  useCallTool,
  type WidgetMetadata,
} from 'mcp-use/react'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import type {
  PokerHudProps,
  GameState,
  Decision,
  Action,
  PlayerTag,
  ChatMessage,
  VillainInfo,
} from './types'
import { propSchema } from './types'
import '../styles.css'

// ── Widget metadata ───────────────────────────────────────────────────────────

export const widgetMetadata: WidgetMetadata = {
  description: 'Live Poker GTO + Exploit HUD with Claude coaching chat',
  props: propSchema,
  exposeAsTool: false,
  metadata: {
    prefersBorder: false,
    invoking: 'Loading HUD...',
    invoked: 'HUD ready',
  },
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TAG_COLOR: Record<PlayerTag, string> = {
  FISH: 'bg-blue-500 text-white',
  MANIAC: 'bg-red-500 text-white',
  NIT: 'bg-gray-500 text-white',
  REG: 'bg-emerald-500 text-white',
  UNKNOWN: 'bg-gray-600 text-gray-200',
}

const ACTION_COLOR: Record<Action, string> = {
  FOLD:  'text-red-400',
  CHECK: 'text-gray-400',
  CALL:  'text-blue-400',
  BET:   'text-amber-400',
  RAISE: 'text-purple-400',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PlayingCard({ card }: { card: string }) {
  if (!card || card.length < 2) return null
  const rank = card.slice(0, -1).toUpperCase()
  const suit = card.slice(-1).toLowerCase()
  const suitMap: Record<string, string> = { h: '♥', d: '♦', s: '♠', c: '♣' }
  const isRed = suit === 'h' || suit === 'd'
  return (
    <span className={`inline-flex flex-col items-center bg-white rounded px-1.5 py-0.5 mx-0.5
      font-bold text-sm leading-tight border border-gray-300 min-w-[24px]
      ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
      <span>{rank}</span>
      <span className="text-xs">{suitMap[suit] ?? suit}</span>
    </span>
  )
}

function TagBadge({ tag }: { tag: PlayerTag }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TAG_COLOR[tag]}`}>
      {tag}
    </span>
  )
}

function ConfidenceBar({ confidence, label }: { confidence: number; label: string }) {
  const filled = Math.round(confidence * 10)
  return (
    <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
      <span>Confidence:</span>
      <span className="tracking-wider text-gray-300 font-mono">
        {'█'.repeat(filled)}{'░'.repeat(10 - filled)}
      </span>
      <span className="text-gray-300">{label}</span>
    </div>
  )
}

function VillainSeat({ villain }: { villain: VillainInfo }) {
  return (
    <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2 py-1
      border border-gray-700 text-xs">
      {villain.tag && <TagBadge tag={villain.tag} />}
      <span className="text-gray-400">{villain.position}</span>
      <span className="text-gray-200">{villain.name ?? villain.player_id.slice(0, 8)}</span>
      <span className="text-gray-500">{villain.stack_bb.toFixed(0)}bb</span>
    </div>
  )
}

// ── Chat Panel ────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  gameState: GameState | null
  decision: Decision | null
  lambda: number
  sessionId: string | null
}

function ChatPanel({ gameState, decision, lambda, sessionId }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: 'Ask me anything about this hand — sizing, villain tendencies, when to deviate, EV tradeoffs...',
    },
  ])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([
    'What if I raise a bit more?',
    'Why this action vs folding?',
    'How is this villain playing?',
  ])
  const bottomRef = useRef<HTMLDivElement>(null)

  // useCallTool uses a reactive pattern: call callTool(), then watch data/isPending
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { callTool: callChat, data: chatData, isPending: chatPending } = useCallTool('hand_chat') as any

  // Watch for completed chat responses
  useEffect(() => {
    if (chatPending || !chatData) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sc = (chatData as any)?.structuredContent as { answer?: string; follow_up_suggestions?: string[] } | undefined
    const answer = sc?.answer ?? '(no response)'
    const newSuggestions = sc?.follow_up_suggestions
    setMessages(prev => {
      // Don't double-add if already there
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.content === answer) return prev
      return [...prev, { role: 'assistant' as const, content: answer }]
    })
    if (newSuggestions?.length) setSuggestions(newSuggestions)
    setPending(false)
  }, [chatData, chatPending])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback((question: string) => {
    if (!question.trim() || pending || chatPending) return
    const userMsg: ChatMessage = { role: 'user', content: question }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setPending(true)

    callChat({
      question,
      game_state: gameState ?? undefined,
      current_recommendation: decision
        ? `${decision.action}${decision.sizing ? ' ' + decision.sizing : ''}: ${decision.reasoning}`
        : undefined,
      lambda,
      session_id: sessionId ?? undefined,
    })
  }, [callChat, gameState, decision, lambda, sessionId, pending, chatPending])

  return (
    <div className="flex flex-col border-t border-gray-700">
      {/* Chat header */}
      <div className="px-3 py-2 bg-gray-800/60 flex items-center gap-2">
        <span className="text-purple-400 text-sm">◈</span>
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
          Ask Claude
        </span>
        <span className="text-xs text-gray-500 ml-1">
          — sizing, deviations, villain reads
        </span>
      </div>

      {/* Messages */}
      <div className="flex flex-col gap-2 px-3 py-2 max-h-52 overflow-y-auto">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[90%]
              ${m.role === 'user'
                ? 'self-end bg-purple-900/60 text-purple-100 border border-purple-700/40'
                : 'self-start bg-gray-800 text-gray-200 border border-gray-700'
              }`}
          >
            {m.content}
          </div>
        ))}
        {pending && (
          <div className="self-start bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5">
            <span className="text-xs text-gray-400 animate-pulse">Claude is thinking...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestion chips */}
      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => send(s)}
            disabled={pending}
            className="text-[10px] px-2 py-1 rounded-full border border-gray-600 text-gray-400
              hover:border-purple-500 hover:text-purple-300 transition-colors cursor-pointer
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-3 pb-3">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send(input)}
          placeholder="What if I raise more? How's this villain playing?..."
          disabled={pending}
          className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-xs
            text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500
            disabled:opacity-50"
        />
        <button
          onClick={() => send(input)}
          disabled={pending || !input.trim()}
          className="px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs
            font-semibold rounded-lg transition-colors cursor-pointer
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Ask
        </button>
      </div>
    </div>
  )
}

// ── Main HUD Component ────────────────────────────────────────────────────────

const DEMO_STATE: GameState = {
  street: 'PREFLOP',
  hero_position: 'BTN',
  hero_cards: ['Ah', 'Kd'],
  board: [],
  pot_bb: 1.5,
  to_call_bb: 1,
  stack_bb: 100,
  villains: [
    { player_id: 'v1', position: 'UTG', name: 'AlphaDog', tag: 'NIT', stack_bb: 87 },
    { player_id: 'v2', position: 'HJ',  name: 'FishFace', tag: 'FISH', stack_bb: 220 },
    { player_id: 'v3', position: 'CO',  name: 'Maniac99', tag: 'MANIAC', stack_bb: 45 },
    { player_id: 'v4', position: 'SB',  name: 'ProfReg', tag: 'REG', stack_bb: 100 },
  ],
  action_history: ['UTG fold', 'HJ fold', 'CO raise 3x', 'SB fold'],
}

const DEMO_DECISION: Decision = {
  action: 'RAISE',
  sizing: '3x',
  reasoning: 'CO [MANIAC] raises wide; 3-bet AKo for value. Villain folds to 3-bets 72%.',
  confidence: 0.87,
  ev_estimate: 2.3,
  gto_action: 'RAISE 3x',
  exploit_action: 'RAISE 3x',
}

const PokerHud: React.FC = () => {
  const { props, isPending } = useWidget<PokerHudProps>()

  const [lambda, setLambda] = useState<number>(props?.lambda ?? 0.5)
  const [showReasoning, setShowReasoning] = useState(false)
  const [flash, setFlash] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { callTool: getDecision, data: decisionData, isPending: loadingDecision } =
    useCallTool('adviser_get_decision') as any

  const gameState: GameState = props?.initial_state ?? DEMO_STATE
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decision: Decision | null =
    ((decisionData as any)?.structuredContent as Decision | undefined) ??
    props?.initial_decision ??
    DEMO_DECISION
  const sessionId = props?.session_id ?? null

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshDecision = useCallback((lam: number, state: GameState) => {
    if (state.street === 'WAITING' || state.street === 'HAND_OVER') return
    getDecision({ game_state: state, lambda: lam })
    setFlash(true)
    setTimeout(() => setFlash(false), 600)
  }, [getDecision])

  const handleLambda = (val: number) => {
    setLambda(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => refreshDecision(val, gameState), 200)
  }

  if (isPending) {
    return (
      <McpUseProvider>
        <div className="w-[420px] bg-gray-900 rounded-xl border border-gray-700 p-6">
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-gray-700 rounded w-1/2" />
            <div className="h-8 bg-gray-700 rounded" />
            <div className="h-16 bg-gray-700 rounded" />
          </div>
        </div>
      </McpUseProvider>
    )
  }

  const potOdds = gameState.to_call_bb > 0
    ? ((gameState.to_call_bb / (gameState.pot_bb + gameState.to_call_bb)) * 100).toFixed(0)
    : null

  const confidenceLabel =
    decision
      ? decision.confidence < 0.17 ? `Low (${Math.round(decision.confidence * 30)} hands)`
        : decision.confidence < 0.67 ? `Medium (${Math.round(decision.confidence * 30)} hands)`
        : `High (${Math.round(decision.confidence * 30)} hands)`
      : ''

  return (
    <McpUseProvider>
      <div className="w-[420px] bg-gray-900 text-gray-100 font-mono text-sm
        rounded-xl border border-gray-700 shadow-2xl overflow-hidden select-none">

        {/* ── Top bar: hero cards + pot ──────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-800
          border-b border-gray-700">
          <div className="flex items-center gap-1">
            {gameState.hero_cards.length > 0
              ? gameState.hero_cards.map((c, i) => <PlayingCard key={i} card={c} />)
              : <span className="text-gray-500 text-xs">Waiting for cards...</span>
            }
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span>Pot: <strong className="text-white">{gameState.pot_bb.toFixed(1)}bb</strong></span>
            {potOdds && <span>Odds: <strong className="text-white">{potOdds}%</strong></span>}
            <span className="bg-gray-700 rounded px-1.5 py-0.5 text-gray-200 font-semibold">
              {gameState.hero_position ?? '—'}
            </span>
          </div>
        </div>

        {/* ── Board cards ────────────────────────────────────────────────── */}
        {gameState.board.length > 0 && (
          <div className="flex items-center gap-1 px-4 py-2 bg-gray-850 border-b border-gray-700">
            <span className="text-gray-500 text-xs mr-1">{gameState.street}:</span>
            {gameState.board.map((c, i) => <PlayingCard key={i} card={c} />)}
          </div>
        )}

        {/* ── Villain seats ─────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-gray-700">
          {gameState.villains.map(v => <VillainSeat key={v.player_id} villain={v} />)}
          {gameState.hero_position && (
            <div className="flex items-center gap-1.5 bg-emerald-900/40 rounded-lg px-2 py-1
              border border-emerald-700/50 text-xs">
              <span className="text-emerald-400">◆</span>
              <span className="text-emerald-300 font-semibold">{gameState.hero_position} (YOU)</span>
              <span className="text-emerald-500">{gameState.stack_bb.toFixed(0)}bb</span>
            </div>
          )}
        </div>

        {/* ── Decision box ──────────────────────────────────────────────── */}
        <div className={`px-4 py-3 border-b border-gray-700 transition-colors duration-300
          ${flash ? 'bg-emerald-950/30' : 'bg-gray-900'}`}>
          {loadingDecision
            ? <span className="text-gray-500 text-xs animate-pulse">Computing recommendation...</span>
            : decision
              ? (
                <>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-base">▶</span>
                    <span className={`text-lg font-bold ${ACTION_COLOR[decision.action]}`}>
                      {decision.action}{decision.sizing ? ` ${decision.sizing}` : ''}
                    </span>
                    {decision.ev_estimate !== undefined && (
                      <span className="ml-auto text-emerald-400 text-xs font-semibold">
                        EV +{decision.ev_estimate.toFixed(1)}bb
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => setShowReasoning(r => !r)}
                    className="text-xs text-gray-300 text-left w-full cursor-pointer"
                  >
                    <span className="text-gray-500">Why: </span>
                    {showReasoning
                      ? decision.reasoning
                      : decision.reasoning.slice(0, 70) + (decision.reasoning.length > 70 ? '... ▼' : '')
                    }
                  </button>

                  {showReasoning && (
                    <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                      <div>GTO baseline: <span className="text-gray-400">{decision.gto_action}</span></div>
                      <div>Exploit play: <span className="text-gray-400">{decision.exploit_action}</span></div>
                    </div>
                  )}

                  <ConfidenceBar confidence={decision.confidence} label={confidenceLabel} />
                </>
              )
              : <span className="text-gray-500 text-xs">Waiting for action...</span>
          }
        </div>

        {/* ── λ slider ─────────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-b border-gray-700">
          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
            <span>◀ Safe GTO</span>
            <span className="text-gray-400 font-mono">λ = {lambda.toFixed(2)}</span>
            <span>Max Exploit ▶</span>
          </div>
          <input
            type="range" min={0} max={1} step={0.05}
            value={lambda}
            onChange={e => handleLambda(parseFloat(e.target.value))}
            className="w-full accent-purple-500 cursor-pointer"
          />
        </div>

        {/* ── Chat toggle button ────────────────────────────────────────── */}
        <button
          onClick={() => setChatOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-2 bg-gray-800/60
            border-b border-gray-700 hover:bg-gray-800 transition-colors cursor-pointer text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="text-purple-400">◈</span>
            <span className="text-gray-300 font-semibold">Ask Claude</span>
            <span className="text-gray-500">— live coaching chat</span>
          </div>
          <span className="text-gray-500">{chatOpen ? '▲' : '▼'}</span>
        </button>

        {/* ── Chat panel ───────────────────────────────────────────────── */}
        {chatOpen && (
          <ChatPanel
            gameState={gameState}
            decision={decision}
            lambda={lambda}
            sessionId={sessionId}
          />
        )}

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div className="flex justify-between items-center px-4 py-2 bg-gray-800/40 text-xs text-gray-500">
          <span>Street: <strong className="text-gray-300">{gameState.street}</strong></span>
          <span className="text-gray-700">poker-gto-hud v0.1</span>
          <span>Actions: <strong className="text-gray-300">{gameState.action_history.length}</strong></span>
        </div>
      </div>
    </McpUseProvider>
  )
}

export default PokerHud

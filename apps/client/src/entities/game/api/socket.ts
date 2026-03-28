import { useEffect, useRef, useCallback } from 'react'
import { useGameStore } from '@/entities/game/model/store'
import type { ServerEvent, ClientEvent } from '@mafia-ai/types'

const WS_URL = import.meta.env.VITE_SERVER_WS_URL || 'wss://server-production-dd31.up.railway.app/ws'
const MAX_RECONNECT_RETRIES = 5
const RECONNECT_DELAY_MS = 2000

const PLAYER_TRANSCRIPT_CLEAR_DELAY = 4000

export function useGameSocket() {
  const ws = useRef<WebSocket | null>(null)
  const isConnecting = useRef(false)
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriesRef = useRef(0)
  const intentionalClose = useRef(false)
  const pendingMessages = useRef<ClientEvent[]>([])
  const onBinaryRef = useRef<((data: ArrayBuffer) => void) | null>(null)
  const playerClearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const narratorSafetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const narratorFreezeTime = useRef<number | null>(null)

  useEffect(() => {
    intentionalClose.current = false
    retriesRef.current = 0

    function connect() {
      if (isConnecting.current || ws.current?.readyState === WebSocket.OPEN) {
        return
      }

      isConnecting.current = true
      const socket = new WebSocket(WS_URL)
      ws.current = socket

      socket.onopen = () => {
        isConnecting.current = false
        retriesRef.current = 0
        console.log(`[WS] Connected to ${WS_URL}`)

        // Flush pending messages
        for (const msg of pendingMessages.current) {
          socket.send(JSON.stringify(msg))
        }
        pendingMessages.current = []
      }

      socket.onmessage = async (event) => {
        // Binary message = Gemini audio
        if (event.data instanceof Blob) {
          const buffer = await event.data.arrayBuffer()
          if (buffer.byteLength > 0) {
            console.log(`[AUDIO-IN] GM audio chunk: ${buffer.byteLength}b`)
          }
          onBinaryRef.current?.(buffer)
          return
        }

        let msg: ServerEvent
        try {
          msg = JSON.parse(event.data)
        } catch (err) {
          console.error('Failed to parse server message:', err)
          return
        }

        const { setGameState, setPlayerId, setMyRole, setFishjamToken, addVote, clearVotes } = useGameStore.getState()

        switch (msg.type) {
          case 'room_joined':
            setPlayerId(msg.playerId)
            setGameState(msg.state)
            useGameStore.getState().setActiveVoiceAgent(msg.state.activeVoiceAgentId ?? null)
            useGameStore.getState().setAgentsMuted(msg.state.agentsMuted ?? false)
            useGameStore.getState().setSelectedAgentIds(msg.state.selectedAgentIds ?? [])
            if (msg.fishjamToken) {
              setFishjamToken(msg.fishjamToken)
            }
            console.log(`[WS] Joined room as playerId=${msg.playerId}, phase=${msg.state.phase}, players=${msg.state.players.length}`)
            break
          case 'game_started':
            setGameState(msg.state)
            useGameStore.getState().setAgentsMuted(msg.state.agentsMuted ?? false)
            useGameStore.getState().setSelectedAgentIds(msg.state.selectedAgentIds ?? [])
            break
          case 'role_assigned':
            setMyRole(msg.role)
            break
          case 'phase_changed': {
            console.log(`[WS] Phase → ${msg.phase}`)
            setGameState(msg.state)
            useGameStore.getState().setAgentsMuted(msg.state.agentsMuted ?? false)
            useGameStore.getState().setSelectedAgentIds(msg.state.selectedAgentIds ?? [])
            if (msg.phase === 'voting') {
              clearVotes()
            }
            // Clear investigation result only when a new night starts (not on day/voting transitions)
            if (msg.phase === 'night') {
              useGameStore.getState().setInvestigationResult(null)
              useGameStore.getState().setNightActionSubmitted(false)
            }
            // Close any open night action window when leaving night phase
            if (msg.phase !== 'night') useGameStore.getState().setNightActionWindowOpen(false)
            // Cancel previous safety timer (from earlier phase)
            if (narratorSafetyTimer.current) {
              clearTimeout(narratorSafetyTimer.current)
              narratorSafetyTimer.current = null
            }

            // Only freeze timer for phases that have a narrator announcement
            const phasesWithNarrator = ['night', 'day', 'voting', 'game_over']
            if (phasesWithNarrator.includes(msg.phase)) {
              narratorFreezeTime.current = Date.now()
              useGameStore.getState().setNarratorSpeaking(true)
              // Safety: unfreeze if narrator never fires turnComplete within 12s
              narratorSafetyTimer.current = setTimeout(() => {
                if (useGameStore.getState().isNarratorSpeaking) {
                  useGameStore.getState().setNarratorSpeaking(false)
                }
              }, 12_000)
            }
            break
          }
          case 'player_eliminated': {
            const { gameState, setGameState } = useGameStore.getState()
            if (gameState) {
              setGameState({
                ...gameState,
                players: gameState.players.map((p) =>
                  p.id === msg.playerId ? { ...p, status: 'dead' as const } : p
                ),
              })
            }
            break
          }
          case 'vote_cast': {
            addVote(msg.fromId, msg.targetId)
            break
          }
          case 'vote_result':
            break
          case 'speaker_changed': {
            const { setCurrentSpeaker } = useGameStore.getState()
            setCurrentSpeaker(msg.speakerId)
            break
          }
          case 'night_action_prompt': {
            useGameStore.getState().setNightActionWindowOpen(true)
            break
          }
          case 'night_action_received': {
            useGameStore.getState().setNightActionWindowOpen(false)
            useGameStore.getState().setNightActionSubmitted(true)
            break
          }
          case 'investigation_result': {
            const { setInvestigationResult } = useGameStore.getState()
            setInvestigationResult({ targetName: msg.targetName, targetRole: msg.targetRole })
            break
          }
          case 'transcript': {
            const { appendGeminiTranscript, appendPlayerTranscript, clearPlayerTranscript, setNarratorSpeaking } = useGameStore.getState()
            if (msg.speaker === 'gemini') {
              const clean = msg.text
                .replace(/`\w+\([^`]*\)`/g, '')
                .replace(/<ctrl\d+>/g, '')
                .trim()
              setNarratorSpeaking(true)
              if (clean) {
                appendGeminiTranscript(clean)
                console.log(`[GM] Said: "${clean.slice(0, 120)}"`)
              }
            } else {
              const label = msg.playerName ?? 'Unknown'
              console.log(`[MIC] Server heard ${label}: "${msg.text.slice(0, 120)}"`)
              appendPlayerTranscript(label, msg.text)
              // Reset debounced clear timer for this player
              const existing = playerClearTimers.current.get(label)
              if (existing) clearTimeout(existing)
              const timer = setTimeout(() => {
                clearPlayerTranscript(label)
                playerClearTimers.current.delete(label)
              }, PLAYER_TRANSCRIPT_CLEAR_DELAY)
              playerClearTimers.current.set(label, timer)
            }
            break
          }
          case 'transcript_clear': {
            const { clearTranscript, setNarratorSpeaking } = useGameStore.getState()
            clearTranscript()
            setNarratorSpeaking(false)
            narratorFreezeTime.current = null
            break
          }
          case 'suspicion_update': {
            const { updateSuspicion } = useGameStore.getState()
            updateSuspicion(msg.playerId, msg.score, msg.reason)
            break
          }
          case 'behavioral_note': {
            const { addBehavioralNote } = useGameStore.getState()
            addBehavioralNote(msg.playerName, msg.note)
            break
          }
          case 'stress_alert': {
            useGameStore.getState().setPlayerStress(msg.playerId, msg.level)
            break
          }
          case 'agent_mute_changed': {
            useGameStore.getState().setActiveVoiceAgent(msg.activeAgentId)
            break
          }
          case 'agents_mute_changed': {
            useGameStore.getState().setAgentsMuted(msg.muted)
            break
          }
          case 'agent_selection_changed': {
            useGameStore.getState().setSelectedAgentIds(msg.selectedAgentIds)
            break
          }
          case 'game_over':
            setGameState(msg.state)
            break
          case 'error':
            console.error('Server error:', msg.message)
            break
        }
      }

      socket.onerror = (error) => {
        console.error('[WS] WebSocket error:', error)
      }

      socket.onclose = (event) => {
        isConnecting.current = false
        ws.current = null
        console.warn(`[WS] Disconnected (code=${event.code}, reason="${event.reason || 'none'}", intentional=${intentionalClose.current})`)

        if (!intentionalClose.current && retriesRef.current < MAX_RECONNECT_RETRIES) {
          retriesRef.current += 1
          console.log(`[WS] Reconnecting... attempt ${retriesRef.current}/${MAX_RECONNECT_RETRIES}`)
          reconnectTimeout.current = setTimeout(connect, RECONNECT_DELAY_MS)
        } else if (!intentionalClose.current) {
          console.error('[WS] Max reconnect retries reached — gave up')
        }
      }
    }

    connect()

    return () => {
      intentionalClose.current = true
      pendingMessages.current = []
      playerClearTimers.current.forEach((t) => clearTimeout(t))
      playerClearTimers.current.clear()
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current)
        reconnectTimeout.current = null
      }
      ws.current?.close()
    }
  }, [])

  const send = useCallback((event: ClientEvent) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(event))
    } else {
      // Queue message to send when socket opens
      pendingMessages.current.push(event)
    }
  }, [])

  const setOnBinary = useCallback((cb: (data: ArrayBuffer) => void) => {
    onBinaryRef.current = cb
  }, [])

  return { send, wsRef: ws, setOnBinary }
}

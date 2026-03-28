import { useEffect, useRef, useCallback } from 'react'
import { useGameStore } from '@/entities/game/model/store'
import type { ServerEvent, ClientEvent } from '@mafia-ai/types'

const WS_URL = import.meta.env.VITE_SERVER_WS_URL || 'wss://server-production-dd31.up.railway.app/ws'
const MAX_RECONNECT_RETRIES = 5
const RECONNECT_DELAY_MS = 2000

export function useGameSocket() {
  const ws = useRef<WebSocket | null>(null)
  const isConnecting = useRef(false)
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriesRef = useRef(0)
  const intentionalClose = useRef(false)
  const pendingMessages = useRef<ClientEvent[]>([])
  const onBinaryRef = useRef<((data: ArrayBuffer) => void) | null>(null)

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
        console.log('Connected to server')
        isConnecting.current = false
        retriesRef.current = 0

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

        console.log(`%c[WS] ${msg.type}`, 'color: #888', 'players:', (msg as any).state?.players?.length ?? '-')

        switch (msg.type) {
          case 'room_joined':
            setPlayerId(msg.playerId)
            setGameState(msg.state)
            console.log('%c[WS] Joined as', 'color: #4ade80', msg.playerId, 'players:', msg.state.players.map((p: any) => p.name))
            if (msg.fishjamToken) {
              setFishjamToken(msg.fishjamToken)
            }
            break
          case 'game_started':
            setGameState(msg.state)
            break
          case 'role_assigned':
            setMyRole(msg.role)
            break
          case 'phase_changed':
            setGameState(msg.state)
            if (msg.phase === 'voting') {
              clearVotes()
            }
            break
          case 'player_eliminated':
            break
          case 'vote_cast': {
            addVote(msg.fromId, msg.targetId)
            const gameState = useGameStore.getState().gameState
            const voterName = gameState?.players.find((p) => p.id === msg.fromId)?.name || msg.fromId
            const targetName = gameState?.players.find((p) => p.id === msg.targetId)?.name || msg.targetId
            console.log(`%c[Vote] ${voterName} → ${targetName}`, 'color: #e11d48; font-weight: bold')
            break
          }
          case 'vote_result':
            console.log('Vote result:', msg.eliminatedId, msg.votes)
            break
          case 'speaker_changed': {
            const { setCurrentSpeaker } = useGameStore.getState()
            setCurrentSpeaker(msg.speakerId)
            // Clear speaker after 3 seconds
            setTimeout(() => {
              const current = useGameStore.getState().currentSpeakerId
              if (current === msg.speakerId) setCurrentSpeaker(null)
            }, 3000)
            break
          }
          case 'investigation_result':
            console.log(`%c[Investigation] ${msg.targetName} is ${msg.targetRole}`, 'color: #a78bfa; font-weight: bold')
            break
          case 'transcript': {
            const { setLastTranscript } = useGameStore.getState()
            setLastTranscript({ speaker: msg.speaker, text: msg.text })
            if (msg.speaker === 'gemini') {
              console.log(`%c[Gemini] ${msg.text}`, 'color: #fbbf24; font-weight: bold; font-size: 14px')
            } else {
              console.log(`%c[Player] ${msg.text}`, 'color: #60a5fa')
            }
            break
          }
          case 'suspicion_update': {
            const { updateSuspicion } = useGameStore.getState()
            updateSuspicion(msg.playerId, msg.score, msg.reason)
            console.log(`%c[Suspicion] ${msg.playerName}: ${msg.score}/10 — ${msg.reason}`, 'color: #f97316; font-weight: bold')
            break
          }
          case 'behavioral_note': {
            const { addBehavioralNote } = useGameStore.getState()
            addBehavioralNote(msg.playerName, msg.note)
            console.log(`%c[Behavior] ${msg.playerName}: ${msg.note}`, 'color: #ec4899')
            break
          }
          case 'bot_speech': {
            const { setPendingBotSpeech } = useGameStore.getState()
            setPendingBotSpeech({ playerName: msg.playerName, message: msg.message })
            console.log(`%c[Bot:${msg.playerName}] ${msg.message}`, 'color: #22d3ee; font-weight: bold')
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
        console.error('WebSocket error:', error)
      }

      socket.onclose = () => {
        console.log('Disconnected from server')
        isConnecting.current = false
        ws.current = null

        if (!intentionalClose.current && retriesRef.current < MAX_RECONNECT_RETRIES) {
          retriesRef.current += 1
          console.log(`Reconnecting in ${RECONNECT_DELAY_MS}ms (attempt ${retriesRef.current}/${MAX_RECONNECT_RETRIES})...`)
          reconnectTimeout.current = setTimeout(connect, RECONNECT_DELAY_MS)
        }
      }
    }

    connect()

    return () => {
      intentionalClose.current = true
      pendingMessages.current = []
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

import type { ServerWebSocket } from 'bun'
import type { ClientEvent } from '@mafia-ai/types'
import { GameManager } from '../game/GameManager'
import type { FishjamService } from '../fishjam/FishjamService'

const games = new Map<string, GameManager>()
// Map game room IDs to Fishjam room IDs
const fishjamRooms = new Map<string, string>()

let fishjamService: FishjamService | null = null

export function setFishjamService(service: FishjamService | null) {
  fishjamService = service
}

export function getOrCreateGame(roomId: string): GameManager {
  let game = games.get(roomId)
  if (!game) {
    game = new GameManager(roomId)
    games.set(roomId, game)
  }
  return game
}

export async function handleClientEvent(
  ws: ServerWebSocket<{ playerId: string }>,
  event: ClientEvent
) {
  switch (event.type) {
    case 'join_room': {
      // Validate player name
      const playerName = event.playerName?.trim()
      if (!playerName) {
        ws.send(JSON.stringify({ type: 'error', message: 'Player name cannot be empty' }))
        return
      }
      if (playerName.length > 20) {
        ws.send(JSON.stringify({ type: 'error', message: 'Player name must be 20 characters or less' }))
        return
      }

      // Cancel pending cleanup if someone is joining
      const pendingCleanup = cleanupTimers.get(event.roomId)
      if (pendingCleanup) {
        clearTimeout(pendingCleanup)
        cleanupTimers.delete(event.roomId)
      }

      const game = getOrCreateGame(event.roomId)
      const playerId = crypto.randomUUID()
      ws.data.playerId = playerId
      game.addPlayer(ws, playerId, playerName)

      // Create Fishjam room if needed, then add peer
      let fishjamToken: string | undefined
      if (fishjamService) {
        try {
          let fjRoomId = fishjamRooms.get(event.roomId)
          if (!fjRoomId) {
            fjRoomId = await fishjamService.createRoom()
            fishjamRooms.set(event.roomId, fjRoomId)
          }
          const { token, peerId } = await fishjamService.addPeer(fjRoomId, { name: playerName })
          fishjamToken = token
          game.mapFishjamPeer(peerId, playerName)
          // Set Fishjam room ID on game so AgentBridge can join
          game.setFishjamRoomId(fjRoomId)
        } catch (err) {
          console.error('Fishjam error:', err)
        }
      }

      ws.send(
        JSON.stringify({
          type: 'room_joined',
          playerId,
          state: game.getPublicState(),
          fishjamToken,
        })
      )

      // Notify others
      game.broadcastEvent({
        type: 'phase_changed',
        phase: game.phase,
        state: game.getPublicState(),
      })
      break
    }

    case 'start_game': {
      const game = findGameByPlayer(ws.data.playerId)
      if (!game) return
      const result = game.startGame()
      if ('error' in result) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }))
      }
      break
    }

    case 'cast_vote': {
      const game = findGameByPlayer(ws.data.playerId)
      if (!game) return
      game.castVote(ws.data.playerId, event.targetId)
      break
    }

    case 'night_action': {
      const game = findGameByPlayer(ws.data.playerId)
      if (!game) return
      game.handleNightAction(ws.data.playerId, event.targetId)
      break
    }

    case 'text_command': {
      const game = findGameByPlayer(ws.data.playerId)
      if (!game) return
      console.log(`[WS] Text command from ${ws.data.playerId}: "${event.text}"`)
      game.handleTextCommand(ws.data.playerId, event.text)
      break
    }

    case 'start_voting': {
      const game = findGameByPlayer(ws.data.playerId)
      if (!game) return
      game.startVoting()
      break
    }

    case 'face_metrics': {
      const game = findGameByPlayer(ws.data.playerId)
      if (!game) return
      game.handleFaceMetrics(ws.data.playerId, event)
      break
    }

    case 'add_voice_agent': {
      console.log(`[WS] add_voice_agent received from ${ws.data.playerId}`)
      const game = findGameByPlayer(ws.data.playerId)
      if (game) {
        game.addVoiceAgent()
      }
      break
    }

    default: {
      ws.send(JSON.stringify({ type: 'error', message: `Unknown event type: ${(event as any).type}` }))
      break
    }
  }
}

const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function handleDisconnect(playerId: string) {
  const game = findGameByPlayer(playerId)
  if (game) {
    game.removePlayer(playerId)

    // If all players disconnected, schedule cleanup after delay (allows reconnects)
    if (game.allDisconnected()) {
      const existing = cleanupTimers.get(game.roomId)
      if (existing) clearTimeout(existing)

      cleanupTimers.set(
        game.roomId,
        setTimeout(() => {
          cleanupTimers.delete(game.roomId)
          // Re-check — someone may have joined during the delay
          if (game.allDisconnected()) {
            game.cleanup()
            cleanupGame(game.roomId)
          }
        }, 10_000)
      )
    }
  }
}

export function cleanupGame(roomId: string) {
  const game = games.get(roomId)
  if (game) {
    game.cleanup()
    games.delete(roomId)
    fishjamRooms.delete(roomId)
  }
}

let audioLogCounter = 0
export function handlePlayerAudio(playerId: string, audio: Buffer) {
  const game = findGameByPlayer(playerId)
  if (!game) {
    if (audioLogCounter++ % 100 === 0) console.log(`[Audio] No game found for player ${playerId}`)
    return
  }
  if (audioLogCounter++ % 50 === 0) {
    console.log(`[Audio] Forwarding ${audio.length} bytes from ${playerId} to Gemini`)
  }
  game.sendPlayerAudio(audio)
}

function findGameByPlayer(playerId: string): GameManager | undefined {
  for (const game of games.values()) {
    if (game.players.some((p) => p.id === playerId)) {
      return game
    }
  }
  return undefined
}

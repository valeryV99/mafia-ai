import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { handleClientEvent, handleDisconnect, handlePlayerAudio, setFishjamService, getOrCreateGame, getActiveRooms } from './ws/handler'
import { GeminiSession } from './gemini/GeminiSession'
import { buildGameMasterPrompt } from './gemini/prompts'
import { FishjamService } from './fishjam/FishjamService'
import type { ClientEvent } from '@mafia-ai/types'

type WsData = { playerId: string }

const app = new Hono()
app.use('*', cors())

let fishjam: FishjamService | null = null
try {
  fishjam = new FishjamService()
  setFishjamService(fishjam)
  console.log('Fishjam service initialized')
} catch (err) {
  console.warn('Fishjam not configured:', (err as Error).message)
}

app.get('/health', (c) => c.json({ status: 'ok' }))

app.get('/active-rooms', (c) => c.json(getActiveRooms()))

// Fishjam routes
app.post('/rooms', async (c) => {
  if (!fishjam) return c.json({ error: 'Fishjam not configured' }, 500)
  const roomId = await fishjam.createRoom()
  return c.json({ roomId })
})

app.post('/rooms/:roomId/peers', async (c) => {
  if (!fishjam) return c.json({ error: 'Fishjam not configured' }, 500)
  const { roomId } = c.req.param()
  const body = await c.req.json<{ playerName?: string }>()
  const { token, peerId } = await fishjam.addPeer(roomId, { name: body.playerName })
  return c.json({ token, peerId })
})

// Add a voice AI agent to a game room
app.post('/rooms/:roomId/voice-agent', async (c) => {
  const { roomId } = c.req.param()
  const game = getOrCreateGame(roomId)
  const result = await game.addVoiceAgent()
  if ('error' in result) {
    return c.json({ error: result.error }, 400)
  }
  return c.json({ added: true, name: result.player.name })
})

app.get('/test-gemini', async (c) => {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return c.json({ error: 'GEMINI_API_KEY not set' }, 500)

  let totalBytes = 0
  const session = new GeminiSession(apiKey)
  session.onAudioResponse((audio) => {
    totalBytes += audio.length
  })

  try {
    await session.connect(
      buildGameMasterPrompt({
        players: ['Alice', 'Bob', 'Charlie', 'Dave'],
        botNames: [],
        mafiaNames: ['Bob'],
        detectiveName: 'Charlie',
        doctorName: 'Dave',
      })
    )
    session.sendText('Welcome players to the game dramatically. Introduce yourself as the Game Master.')

    // Keep session alive for a few seconds to receive audio
    setTimeout(() => {
      console.log(`Gemini test complete: received ${totalBytes} bytes of audio`)
      session.disconnect()
    }, 10000)

    return c.json({ status: 'Gemini session started — check server logs for audio response' })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

process.on('uncaughtException', (err) => {
  console.error('[SERVER] Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] Unhandled rejection:', reason)
})

const server = Bun.serve<WsData>({
  port: Number(process.env.PORT) || 3001,
  fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, {
        data: { playerId: '' },
      })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws) {
      console.log('[WS] Client connected')
    },
    async message(ws, data) {
      if (typeof data !== 'string') {
        // Binary message = player audio, forward to Gemini
        handlePlayerAudio(ws.data.playerId, Buffer.from(data))
        return
      }

      // String message = JSON event
      let event: ClientEvent
      try {
        event = JSON.parse(data)
      } catch (err) {
        console.error('[WS] Invalid JSON:', err)
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }))
        return
      }

      try {
        await handleClientEvent(ws, event)
      } catch (err) {
        console.error('[WS] Handler error:', err)
        ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }))
      }
    },
    close(ws) {
      console.log('[WS] Client disconnected:', ws.data.playerId)
      if (ws.data.playerId) {
        handleDisconnect(ws.data.playerId)
      }
    },
  },
})

console.log(`Server running on port ${server.port}`)

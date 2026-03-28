import Smelter from '@swmansion/smelter-node'
import React from 'react'
import { BroadcastScene, type BroadcastPlayer } from './scene'
import { GRAYSCALE_SHADER, NIGHT_SHADER, STRESS_SHADER } from './shaders'
import type { Phase, GameState } from '@mafia-ai/types'

const GAME_WS_URL = process.env.GAME_WS_URL || 'ws://localhost:3001/ws'
const GAME_ROOM_ID = process.env.GAME_ROOM_ID || 'broadcast-room'
const OUTPUT_WIDTH = 1920
const OUTPUT_HEIGHT = 1080

let players: BroadcastPlayer[] = []
let phase: Phase = 'lobby'
let day = 1
let smelterInstance: Smelter | null = null
let outputRegistered = false

function syncFromState(state: GameState) {
  phase = state.phase
  day = state.day
  players = state.players
    .filter((p) => !p.name.startsWith('📺'))
    .map((p) => ({
      inputId: `player_${p.id}`,
      name: p.name,
      role: p.role,
      status: p.status,
      isStressed: players.find((bp) => bp.name === p.name)?.isStressed ?? false,
    }))
}

async function updateScene() {
  if (!smelterInstance) return

  if (outputRegistered) {
    try { await smelterInstance.unregisterOutput('broadcast') } catch { /* first call */ }
  }

  await smelterInstance.registerOutput(
    'broadcast',
    <BroadcastScene players={players} phase={phase} day={day} />,
    {
      type: 'whep_server',
      video: {
        encoder: { type: 'ffmpeg_h264', preset: 'fast' },
        resolution: { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT },
      },
      audio: true,
    }
  )
  outputRegistered = true
  console.log(`[Broadcast] Scene updated: phase=${phase} day=${day} players=${players.length}`)
}

function connectToGame() {
  const ws = new WebSocket(GAME_WS_URL)

  ws.onopen = () => {
    console.log('[Broadcast] Connected to game server')
    // Join as spectator — server can filter by name prefix "📺"
    ws.send(JSON.stringify({
      type: 'join_room',
      roomId: GAME_ROOM_ID,
      playerName: '📺 Spectator',
    }))
  }

  ws.onmessage = async (event) => {
    if (typeof event.data !== 'string') return

    let msg: Record<string, unknown>
    try { msg = JSON.parse(event.data as string) } catch { return }

    const state = msg.state as GameState | undefined

    switch (msg.type) {
      case 'room_joined':
      case 'game_started':
      case 'phase_changed': {
        if (state) {
          syncFromState(state)
          await updateScene()
        }
        break
      }
      case 'stress_alert': {
        const player = players.find((p) => p.name === (msg as any).playerName)
        if (player) {
          player.isStressed = ((msg as any).level as number) > 0.3
          await updateScene()
        }
        break
      }
      case 'game_over': {
        if (state) {
          syncFromState(state)
          players = players.map((p) => ({ ...p, isStressed: false }))
          await updateScene()
        }
        break
      }
    }
  }

  ws.onclose = () => {
    console.log('[Broadcast] Disconnected, reconnecting in 3s...')
    setTimeout(connectToGame, 3000)
  }

  ws.onerror = (err) => console.error('[Broadcast] WS error:', err)
}

async function main() {
  console.log('[Broadcast] Initializing Smelter...')
  smelterInstance = new Smelter()
  await smelterInstance.init()

  await smelterInstance.registerShader('grayscale', { source: GRAYSCALE_SHADER })
  await smelterInstance.registerShader('night_darken', { source: NIGHT_SHADER })
  await smelterInstance.registerShader('stress_pulse', { source: STRESS_SHADER })
  console.log('[Broadcast] Shaders registered')

  await updateScene()
  await smelterInstance.start()

  console.log('[Broadcast] Smelter started — spectator: http://localhost:9000/whep/broadcast')
  connectToGame()
}

main().catch(console.error)

import React from 'react'
import { View, Text, Tiles, InputStream, Rescaler, Shader } from '@swmansion/smelter'
import type { Phase } from '@mafia-ai/types'

export interface BroadcastPlayer {
  inputId: string
  name: string
  role: string
  status: 'alive' | 'dead'
  isStressed: boolean
}

interface PlayerTileProps {
  player: BroadcastPlayer
  phase: Phase
}

function PlayerTile({ player, phase }: PlayerTileProps) {
  const isNight = phase === 'night'
  const isRoleAssignment = phase === 'role_assignment'
  const isDead = player.status === 'dead'

  const shaderId = isDead
    ? 'grayscale'
    : player.isStressed
      ? 'stress_pulse'
      : isNight
        ? 'night_darken'
        : isRoleAssignment
          ? 'blur_only'
          : undefined

  const videoContent = (
    <Rescaler style={{ rescaleMode: 'fill' }}>
      <InputStream inputId={player.inputId} />
    </Rescaler>
  )

  const processedVideo = shaderId ? (
    <Shader shaderId={shaderId} resolution={{ width: 480, height: 360 }}>
      {videoContent}
    </Shader>
  ) : (
    videoContent
  )

  const borderColor = isDead
    ? '#444444FF'
    : player.isStressed
      ? '#EF4444FF'
      : player.role === 'mafia'
        ? '#DC2626FF'
        : '#333333FF'

  return (
    <View style={{ direction: 'column' }}>
      <View style={{ backgroundColor: borderColor, padding: 3 }}>
        {processedVideo}
      </View>
      <View style={{ height: 32, backgroundColor: '#1a1a2eFF', padding: 4 }}>
        <Text
          style={{
            fontSize: 18,
            color: isDead ? '#666666FF' : player.role === 'mafia' ? '#FF6666FF' : '#EEEEEEFF',
            fontWeight: 'bold',
          }}
        >
          {player.name}{isDead ? ' [DEAD]' : ''}{player.isStressed ? ' 😰' : ''}
        </Text>
      </View>
    </View>
  )
}

function PhaseBanner({ phase, day }: { phase: Phase; day: number }) {
  const labels: Partial<Record<Phase, string>> = {
    lobby: '🎭 LOBBY — Waiting for players',
    role_assignment: '🃏 ROLES ASSIGNED',
    night: `🌙 NIGHT ${day}`,
    day: `☀️ DAY ${day} — Discussion`,
    voting: `🗳️ VOTING — DAY ${day}`,
    game_over: '🏆 GAME OVER',
  }

  return (
    <View style={{ height: 56, backgroundColor: phase === 'night' ? '#0d0d2bFF' : '#1a1a2eFF', padding: 10 }}>
      <Text style={{ fontSize: 28, color: '#FFD700FF', fontWeight: 'bold', align: 'center' }}>
        {labels[phase] ?? phase}
      </Text>
    </View>
  )
}

export interface BroadcastSceneProps {
  players: BroadcastPlayer[]
  phase: Phase
  day: number
}

export function BroadcastScene({ players, phase, day }: BroadcastSceneProps) {
  return (
    <View style={{ direction: 'column', backgroundColor: '#0a0a1aFF' }}>
      <PhaseBanner phase={phase} day={day} />
      <Tiles
        style={{
          backgroundColor: '#0a0a1aFF',
          margin: 8,
          padding: 4,
          tileAspectRatio: '4:3',
        }}
        transition={{ durationMs: 300 }}
      >
        {players.map((player) => (
          <PlayerTile key={player.inputId} player={player} phase={phase} />
        ))}
      </Tiles>
      <View style={{ height: 36, backgroundColor: '#0a0a1aFF', padding: 6 }}>
        <Text style={{ fontSize: 14, color: '#666666FF', align: 'center' }}>
          AI Mafia — Powered by Gemini Live + Fishjam + Smelter
        </Text>
      </View>
    </View>
  )
}

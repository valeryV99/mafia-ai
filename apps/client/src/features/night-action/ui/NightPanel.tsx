import { useState } from 'react'
import type { Player, Role } from '@mafia-ai/types'
import { Button } from '@/shared/ui'
import { useGameStore } from '@/entities/game'

interface NightPanelProps {
  players: Player[]
  currentPlayerId: string
  myRole: Role
  onAction: (targetId: string) => void
}

const rolePrompts: Partial<Record<Role, string>> = {
  mafia: 'Choose who to eliminate',
  detective: 'Choose who to investigate',
  doctor: 'Choose who to save',
}

const roleConfirm: Partial<Record<Role, string>> = {
  mafia: 'Target locked',
  detective: 'Investigating',
  doctor: 'Protecting',
}

export function NightPanel({ players, currentPlayerId, myRole, onAction }: NightPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const investigationResult = useGameStore((s) => s.investigationResult)
  const prompt = rolePrompts[myRole]
  if (!prompt) return null

  const targets = players.filter((p) => p.status === 'alive' && p.id !== currentPlayerId)

  if (selectedId) {
    const target = players.find((p) => p.id === selectedId)
    return (
      <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-green-500 mb-5">
        <div className="text-center">
          <span className="text-2xl">✓</span>
          <h3 className="text-green-400 font-bold mt-1">{roleConfirm[myRole]}: {target?.name}</h3>
          {myRole === 'detective' ? (
            investigationResult ? (
              <p className={`text-sm font-bold mt-2 ${investigationResult.targetRole === 'mafia' ? 'text-red-400' : 'text-green-400'}`}>
                {investigationResult.targetName} is {investigationResult.targetRole.toUpperCase()}
              </p>
            ) : (
              <p className="text-[#666] text-xs mt-2">Waiting for result...</p>
            )
          ) : (
            <p className="text-[#666] text-xs mt-2">Waiting for other players...</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-indigo-500 mb-5">
      <h3 className="text-indigo-500 mb-3 text-center font-bold">
        {prompt}
      </h3>
      <div className="flex flex-col gap-2">
        {targets.map((player) => (
          <Button
            key={player.id}
            variant="ghost"
            onClick={() => {
              setSelectedId(player.id)
              onAction(player.id)
            }}
          >
            {player.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

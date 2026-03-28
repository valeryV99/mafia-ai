import { useState } from 'react'
import { useGameStore } from '@/entities/game'

const ROLE_LABELS: Record<string, string> = {
  mafia: 'Choose who to eliminate',
  detective: 'Choose who to investigate',
  doctor: 'Choose who to protect',
}

interface NightPanelProps {
  onAction: (targetId: string) => void
}

export function NightPanel({ onAction }: NightPanelProps) {
  const { gameState, playerId, myRole } = useGameStore()
  const [submitted, setSubmitted] = useState(false)

  if (!gameState || !playerId || !myRole) return null

  if (myRole === 'civilian') {
    return (
      <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-indigo-800 mb-5 text-center">
        <p className="text-indigo-300 text-sm">Night — wait for morning...</p>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-indigo-800 mb-5 text-center">
        <p className="text-green-400 text-sm font-bold">Action submitted — waiting for dawn...</p>
      </div>
    )
  }

  const targets = gameState.players.filter(
    (p) => p.status === 'alive' && p.id !== playerId
  )

  const handleSelect = (targetId: string) => {
    onAction(targetId)
    setSubmitted(true)
  }

  return (
    <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-indigo-800 mb-5">
      <p className="text-indigo-300 text-sm font-bold mb-3 text-center">
        {ROLE_LABELS[myRole]}
      </p>
      <div className="flex flex-col gap-2">
        {targets.map((player) => (
          <button
            key={player.id}
            onClick={() => handleSelect(player.id)}
            className="px-4 py-2 rounded-lg bg-indigo-900 hover:bg-indigo-700 text-white text-sm font-medium transition-colors text-left"
          >
            {player.name}
          </button>
        ))}
      </div>
    </div>
  )
}

import type { Player } from '@mafia-ai/types'

const ROLE_COLOR: Record<string, string> = {
  mafia: 'text-red-400',
  detective: 'text-blue-400',
  doctor: 'text-green-400',
  civilian: 'text-gray-300',
}

const ROLE_ICON: Record<string, string> = {
  mafia: '🔪',
  detective: '🔍',
  doctor: '💊',
  civilian: '👤',
}

interface GameOverProps {
  winner: 'mafia' | 'civilians'
  players: Player[]
}

export function GameOver({ winner, players }: GameOverProps) {
  const mafia = players.filter((p) => p.role === 'mafia')
  const others = players.filter((p) => p.role !== 'mafia')

  return (
    <div className="mt-8 flex flex-col items-center gap-6">
      <h2 className={`text-4xl font-bold ${winner === 'mafia' ? 'text-red-500' : 'text-green-400'}`}>
        {winner === 'mafia' ? 'Mafia Wins!' : 'Civilians Win!'}
      </h2>

      <div className="w-full max-w-sm bg-[#1a1a2e] rounded-xl border border-[#333] p-4">
        <p className="text-xs text-[#888] uppercase tracking-wider mb-3 text-center">Role Reveal</p>
        <div className="space-y-2">
          {[...mafia, ...others].map((player) => (
            <div
              key={player.id}
              className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                player.status === 'dead' ? 'bg-[#111] opacity-60' : 'bg-[#22223a]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span>{ROLE_ICON[player.role]}</span>
                <span className={`font-semibold text-sm ${player.status === 'dead' ? 'line-through text-[#666]' : 'text-white'}`}>
                  {player.name}
                </span>
              </div>
              <span className={`text-xs font-bold uppercase ${ROLE_COLOR[player.role]}`}>
                {player.role}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

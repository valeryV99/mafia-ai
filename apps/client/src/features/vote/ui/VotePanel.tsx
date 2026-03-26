import { useGameStore } from '@/entities/game'

export function VotePanel() {
  const { gameState, playerId, votes } = useGameStore()

  if (!gameState || !playerId) return null

  const myVoteTargetId = votes[playerId]
  const myVoteTarget = myVoteTargetId
    ? gameState.players.find((p) => p.id === myVoteTargetId)
    : null

  // Compute ordered list of alive humans who haven't voted yet
  const voiceAgentIds = new Set(gameState.voiceAgentIds ?? [])
  const unvotedHumans = gameState.players.filter(
    (p) => p.status === 'alive' && !voiceAgentIds.has(p.id) && !votes[p.id]
  )
  const currentVoterId = unvotedHumans[0]?.id ?? null
  const isMyTurn = currentVoterId === playerId

  if (myVoteTarget) {
    return (
      <div className="p-5 bg-[#1a1a2e] rounded-xl border-2 border-green-700 text-center">
        <p className="text-xs text-[#888] uppercase tracking-wider mb-1">Your vote</p>
        <p className="text-green-400 font-bold text-lg">{myVoteTarget.name}</p>
        <p className="text-[#666] text-xs mt-2">Waiting for other votes...</p>
      </div>
    )
  }

  if (isMyTurn) {
    return (
      <div className="p-5 bg-[#1a1a2e] rounded-xl border-2 border-rose-700">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            <p className="text-red-400 text-sm font-bold tracking-wide">YOUR TURN</p>
          </div>
          <p className="text-white text-sm text-center">
            Say the name of who you want to eliminate
          </p>
        </div>
      </div>
    )
  }

  const waitingFor = currentVoterId
    ? gameState.players.find((p) => p.id === currentVoterId)?.name
    : null

  return (
    <div className="p-5 bg-[#1a1a2e] rounded-xl border-2 border-[#333] text-center">
      {waitingFor ? (
        <>
          <p className="text-xs text-[#888] uppercase tracking-wider mb-1">Now asking</p>
          <p className="text-amber-400 font-bold text-base">{waitingFor}</p>
        </>
      ) : (
        <p className="text-[#666] text-sm italic">Waiting for votes...</p>
      )}
    </div>
  )
}

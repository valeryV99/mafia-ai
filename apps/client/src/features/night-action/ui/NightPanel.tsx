import { useGameStore } from '@/entities/game'

const ROLE_VOICE_PROMPT: Record<string, string> = {
  mafia: 'Say the name of who you want to eliminate',
  detective: 'Say the name of who you want to investigate',
  doctor: 'Say the name of who you want to protect',
}

export function NightPanel() {
  const { myRole } = useGameStore()
  const nightActionWindowOpen = useGameStore((s) => s.nightActionWindowOpen)
  const nightActionSubmitted = useGameStore((s) => s.nightActionSubmitted)

  if (!myRole) return null

  if (myRole === 'civilian') {
    return (
      <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-indigo-800 mb-5 text-center">
        <p className="text-indigo-300 text-sm">Night — wait for morning...</p>
      </div>
    )
  }

  if (nightActionSubmitted) {
    return (
      <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-green-900 mb-5 text-center">
        <p className="text-green-400 text-sm font-bold">Action confirmed — waiting for dawn...</p>
      </div>
    )
  }

  if (nightActionWindowOpen) {
    return (
      <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-red-700 mb-5">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            <p className="text-red-400 text-sm font-bold tracking-wide">MIC LIVE</p>
          </div>
          <p className="text-white text-sm text-center">{ROLE_VOICE_PROMPT[myRole]}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 bg-[#1a1a2e] rounded-xl border-2 border-indigo-800 mb-5 text-center">
      <p className="text-indigo-400 text-sm italic">Waiting for your turn to act...</p>
    </div>
  )
}

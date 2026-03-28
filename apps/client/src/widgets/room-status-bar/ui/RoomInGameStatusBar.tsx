import type { Phase, Player, Role } from '@mafia-ai/types'
import type { FaceMetrics } from '@/entities/game'
// import { AgentVoiceControls } from '@/widgets/agent-voice-controls'

function phaseHint(phase: Phase, myRole: Role | null): string {
  if (phase === 'night') {
    if (myRole === 'mafia') return 'Mafia turn — choose who to eliminate'
    if (myRole === 'detective') return 'Detective turn — choose who to investigate'
    if (myRole === 'doctor') return 'Doctor turn — choose who to save'
    if (myRole === 'civilian') return 'Night — wait for dawn...'
    return ''
  }
  if (phase === 'day') return 'Day — discuss and find the mafia!'
  if (phase === 'voting') return 'Voting — choose who to eliminate!'
  return ''
}

function FaceMetricsStrip({ faceMetrics }: { faceMetrics: FaceMetrics }) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
      <span className={faceMetrics.stress > 0.3 ? 'text-red-400' : 'text-[#666]'}>
        Stress {(faceMetrics.stress * 100).toFixed(0)}%
      </span>
      <span className={faceMetrics.surprise > 0.3 ? 'text-yellow-400' : 'text-[#666]'}>
        Surprise {(faceMetrics.surprise * 100).toFixed(0)}%
      </span>
      {faceMetrics.lookingAway && <span className="text-orange-400">Looking away</span>}
    </div>
  )
}

interface RoomInGameStatusBarProps {
  phase: Phase
  myRole: Role | null
  lastTranscript: { speaker: 'gemini' | 'player'; text: string } | null
  isNarratorSpeaking: boolean
  faceMetrics: FaceMetrics | null
  voiceAgentIds: string[]
  players: Player[]
  agentsMuted: boolean
  selectedAgentIds: string[]
  phaseLocked: boolean
  isMicrophoneMuted: boolean
  onToggleAgentsMuted: () => void
  onToggleAgentSelected: (agentId: string, selected: boolean) => void
  onToggleMicrophoneMute: () => void
}

export function RoomInGameStatusBar({
  phase,
  myRole,
  lastTranscript,
  isNarratorSpeaking,
  faceMetrics,
  // voiceAgentIds,
  // players,
  // agentsMuted,
  // selectedAgentIds,
  // phaseLocked,
  isMicrophoneMuted,
  // onToggleAgentsMuted,
  // onToggleAgentSelected,
  onToggleMicrophoneMute,
}: RoomInGameStatusBarProps) {
  const hint = phaseHint(phase, myRole)

  return (
    <div className="mb-4 space-y-3">
      <div className="bg-black/60 rounded-lg px-4 py-3 min-h-[48px] flex items-center">
        {lastTranscript?.speaker === 'gemini' ? (
          <p className="text-sm text-amber-400 flex items-center gap-2">
            {isNarratorSpeaking && (
              <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse shrink-0" />
            )}
            <span>
              <span className="font-bold">Game Master:</span> {lastTranscript.text}
            </span>
          </p>
        ) : (
          <p className="text-sm text-[#555] italic">Listening...</p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-[#888] flex items-center gap-3">
          {hint && <span>{hint}</span>}
          {faceMetrics && <FaceMetricsStrip faceMetrics={faceMetrics} />}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* AgentVoiceControls hidden for hackathon demo — humans-only mode */}
          <button
            type="button"
            onClick={() => !isNarratorSpeaking && onToggleMicrophoneMute()}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-xs transition-all duration-200 ${
              isNarratorSpeaking
                ? 'bg-indigo-600/80 text-white cursor-not-allowed'
                : isMicrophoneMuted
                  ? 'bg-red-600/80 hover:bg-red-600 text-white'
                  : 'bg-green-600/80 hover:bg-green-600 text-white animate-pulse'
            }`}
          >
            {isNarratorSpeaking ? 'NARRATOR' : isMicrophoneMuted ? 'MIC OFF' : 'LIVE'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef } from 'react'

interface VideoTileProps {
  stream: MediaStream | null | undefined
  name: string
  isDead?: boolean
  isYou?: boolean
  isMuted?: boolean
  suspicion?: { score: number; reason: string }
  isSpeaking?: boolean
  transcript?: string
  stressLevel?: number
  phase?: string
  votesReceived?: number
}

export function VideoTile({ stream, name, isDead, isYou, isMuted, suspicion, isSpeaking, transcript, stressLevel = 0, phase, votesReceived = 0 }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    video.srcObject = stream
    video.play().catch(() => {})
    return () => { video.srcObject = null }
  }, [stream])

  const isNight = phase === 'night'
  const isBlurred = phase === 'night' || phase === 'role_assignment'
  const isStressed = stressLevel > 0.3 && !isDead
  const isHighStress = stressLevel > 0.6 && !isDead

  function getBorderStyle() {
    if (isDead) return 'border-[#444]'
    if (votesReceived > 0 && phase === 'voting') return 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.5)]'
    if (isSpeaking) return 'border-green-400 shadow-[0_0_15px_rgba(74,222,128,0.4)]'
    if (isHighStress) return 'border-red-500/70 shadow-[0_0_12px_rgba(239,68,68,0.4)]'
    if (isStressed) return 'border-orange-400/50 shadow-[0_0_8px_rgba(251,146,60,0.3)]'
    if (isYou) return 'border-[#6366f1]'
    return 'border-[#333]'
  }

  return (
    <div className={`relative rounded-xl overflow-hidden bg-[#1a1a2e] aspect-[4/3] border-2 transition-all duration-700 ${getBorderStyle()} ${isDead ? 'opacity-50' : ''} ${isHighStress ? 'scale-110 z-10' : isStressed ? 'scale-105 z-10' : 'scale-100'}`}>
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isYou || isMuted}
          className={`w-full h-full object-cover transition-all duration-700 ${isDead ? 'grayscale brightness-50' : ''} ${isBlurred && !isDead ? 'blur-sm' : ''} ${isNight && !isDead ? 'brightness-[0.4] saturate-50' : ''}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[2.5rem]">
          {isDead ? '💀' : '🎭'}
        </div>
      )}

      {/* Night overlay tint — only on actual night, not role_assignment */}
      {isNight && !isDead && (
        <div className="absolute inset-0 bg-blue-950/40 pointer-events-none transition-opacity duration-700" />
      )}

      {/* Death overlay */}
      {isDead && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-4xl drop-shadow-lg">💀</span>
        </div>
      )}

      {/* Stress red vignette */}
      {isStressed && (
        <div
          className="absolute inset-0 pointer-events-none animate-pulse"
          style={{
            background: `radial-gradient(ellipse at center, transparent 40%, rgba(220,38,38,${isHighStress ? 0.35 : 0.2}) 100%)`,
          }}
        />
      )}

      {/* Stress emoji */}
      {isStressed && (
        <div className="absolute top-1.5 right-1.5 text-xl animate-bounce drop-shadow-[0_0_8px_rgba(239,68,68,0.9)]">
          {isHighStress ? '😱' : '😰'}
        </div>
      )}

      {/* Speaking indicator */}
      {isSpeaking && !isDead && (
        <div className="absolute top-1.5 left-1.5 bg-green-500/90 text-white text-[9px] px-1.5 py-0.5 rounded font-bold flex items-center gap-1">
          <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
          SPEAKING
        </div>
      )}

      {/* SUS badge */}
      {suspicion && suspicion.score >= 7 && !isDead && (
        <div className="absolute top-1.5 left-1.5 bg-red-600/90 text-white text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ left: isSpeaking ? '5rem' : '0.375rem' }}>
          SUS
        </div>
      )}

      {/* Vote count badge during voting */}
      {votesReceived > 0 && phase === 'voting' && !isDead && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <div className="bg-red-600/90 text-white text-lg font-black w-10 h-10 rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(220,38,38,0.6)] animate-bounce">
            {votesReceived}
          </div>
        </div>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-col">
        {transcript && !isDead && (
          <div className="px-2 pb-1">
            <p className="text-[11px] text-white/90 bg-black/70 rounded px-2 py-1 leading-snug line-clamp-2">
              {transcript}
            </p>
          </div>
        )}

        {suspicion && suspicion.score > 0 && !isDead && (phase === 'day' || phase === 'voting') && (
          <div className="px-2 pb-1">
            <div className="flex items-center gap-1.5">
              <div className="flex-1 h-1 bg-black/40 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    suspicion.score >= 7 ? 'bg-red-500' :
                    suspicion.score >= 4 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${suspicion.score * 10}%` }}
                />
              </div>
              <span className={`text-[10px] font-bold ${
                suspicion.score >= 7 ? 'text-red-400' :
                suspicion.score >= 4 ? 'text-yellow-400' : 'text-green-400'
              }`}>
                {suspicion.score}/10
              </span>
            </div>
          </div>
        )}

        <div className="px-[10px] py-[6px] bg-gradient-to-t from-black/80 to-transparent">
          <div className="text-white text-[0.85rem] font-bold">
            {name} {isYou && '(You)'}
          </div>
          {stressLevel > 0.1 && !isDead && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[9px] text-[#888]">Stress</span>
              <div className="flex-1 h-[3px] bg-black/40 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    stressLevel > 0.6 ? 'bg-red-500' : stressLevel > 0.3 ? 'bg-orange-400' : 'bg-yellow-500/60'
                  }`}
                  style={{ width: `${Math.min(100, stressLevel * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

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
}

export function VideoTile({ stream, name, isDead, isYou, isMuted, suspicion, isSpeaking, transcript, stressLevel = 0 }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [stream])

  function getBorderStyle() {
    if (isDead) return 'border-[#444]'
    if (isSpeaking) return 'border-green-400 shadow-[0_0_15px_rgba(74,222,128,0.4)]'
    if (stressLevel > 0.6) return 'border-red-500/70 shadow-[0_0_12px_rgba(239,68,68,0.4)]'
    if (stressLevel > 0.3) return 'border-orange-400/50 shadow-[0_0_8px_rgba(251,146,60,0.3)]'
    if (isYou) return 'border-[#6366f1]'
    return 'border-[#333]'
  }

  const borderColor = getBorderStyle()

  return (
    <div className={`relative rounded-xl overflow-hidden bg-[#1a1a2e] aspect-[4/3] border-2 transition-all duration-300 ${borderColor} ${isDead ? 'opacity-50' : ''}`}>
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isYou || isMuted}
          className={`w-full h-full object-cover ${isDead ? 'grayscale' : ''}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[2.5rem]">
          {isDead ? '💀' : '🎭'}
        </div>
      )}

      {/* Speaking indicator */}
      {isSpeaking && !isDead && (
        <div className="absolute top-1 left-1 bg-green-500/90 text-white text-[9px] px-1.5 py-0.5 rounded font-bold flex items-center gap-1">
          <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
          SPEAKING
        </div>
      )}

      {/* SUS badge for high suspicion */}
      {suspicion && suspicion.score >= 7 && !isDead && (
        <div className="absolute top-1 right-1 bg-red-600/90 text-white text-[9px] px-1.5 py-0.5 rounded font-bold">
          SUS
        </div>
      )}

      {/* Stress panic indicator */}
      {stressLevel > 0.3 && !isDead && (
        <div className={`absolute top-1 ${suspicion && suspicion.score >= 7 ? 'right-10' : 'right-1'} text-lg animate-bounce drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]`}>
          {stressLevel > 0.6 ? '😱' : '😰'}
        </div>
      )}

      {/* Bottom overlay: transcript → suspicion bar → name */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-col">
        {transcript && !isDead && (
          <div className="px-2 pb-1">
            <p className="text-[11px] text-white/90 bg-black/70 rounded px-2 py-1 leading-snug line-clamp-2">
              {transcript}
            </p>
          </div>
        )}

        {suspicion && !isDead && (
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
                {suspicion.score}
              </span>
            </div>
          </div>
        )}

        <div className="px-[10px] py-[6px] bg-gradient-to-t from-black/80 to-transparent text-white text-[0.85rem] font-bold">
          {name} {isYou && '(You)'}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useCallback, useState } from 'react'

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
}

export function VideoTile({ stream, name, isDead, isYou, isMuted, suspicion, isSpeaking, transcript, stressLevel = 0, phase }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const [canvasWorking, setCanvasWorking] = useState(false)
  const hasEffects = (stressLevel > 0.3 && !isDead) || (phase === 'night' && !isDead) || isDead

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return
    video.srcObject = stream
    // Ensure playback starts — required for canvas.drawImage to work
    video.play().catch(() => {})
    return () => {
      video.srcObject = null
    }
  }, [stream])

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || video.readyState < 2) {
      animRef.current = requestAnimationFrame(renderFrame)
      return
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth || 320
      canvas.height = video.videoHeight || 240
    }

    const w = canvas.width
    const h = canvas.height

    ctx.drawImage(video, 0, 0, w, h)
    if (!canvasWorking) setCanvasWorking(true)

    if (isDead) {
      const imageData = ctx.getImageData(0, 0, w, h)
      const d = imageData.data
      for (let i = 0; i < d.length; i += 4) {
        const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        d[i] = gray; d[i + 1] = gray; d[i + 2] = gray
      }
      ctx.putImageData(imageData, 0, 0)
      ctx.globalAlpha = 0.4
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
      ctx.font = `${Math.min(w, h) * 0.3}px serif`
      ctx.textAlign = 'center'
      ctx.fillText('💀', w / 2, h / 2 + 10)
    }

    if (phase === 'night' && !isDead) {
      ctx.globalAlpha = 0.3
      ctx.fillStyle = '#050520'
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
    }

    if (stressLevel > 0.3 && !isDead) {
      const intensity = Math.min(1, (stressLevel - 0.3) / 0.7)
      const pulse = Math.sin(Date.now() / 300) * 0.3 + 0.7
      const gradient = ctx.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.55)
      gradient.addColorStop(0, 'transparent')
      gradient.addColorStop(1, `rgba(220, 38, 38, ${intensity * 0.35 * pulse})`)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)

      const emoji = stressLevel > 0.6 ? '😱' : '😰'
      const size = 20 + intensity * 14
      const bounce = Math.sin(Date.now() / 200) * 3
      ctx.font = `${size}px serif`
      ctx.textAlign = 'right'
      ctx.shadowColor = 'rgba(239, 68, 68, 0.9)'
      ctx.shadowBlur = 8
      ctx.fillText(emoji, w - 6, 28 + bounce)
      ctx.shadowBlur = 0
    }

    if (isSpeaking && !isDead) {
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.8)'
      ctx.lineWidth = 4
      ctx.strokeRect(2, 2, w - 4, h - 4)
    }

    animRef.current = requestAnimationFrame(renderFrame)
  }, [isDead, stressLevel, phase, isSpeaking, canvasWorking])

  useEffect(() => {
    if (stream && hasEffects) {
      animRef.current = requestAnimationFrame(renderFrame)
    }
    return () => cancelAnimationFrame(animRef.current)
  }, [stream, hasEffects, renderFrame])

  function getBorderStyle() {
    if (isDead) return 'border-[#444]'
    if (isSpeaking) return 'border-green-400 shadow-[0_0_15px_rgba(74,222,128,0.4)]'
    if (stressLevel > 0.6) return 'border-red-500/70 shadow-[0_0_12px_rgba(239,68,68,0.4)]'
    if (stressLevel > 0.3) return 'border-orange-400/50 shadow-[0_0_8px_rgba(251,146,60,0.3)]'
    if (isYou) return 'border-[#6366f1]'
    return 'border-[#333]'
  }

  // Show canvas only when effects are active AND canvas is actually rendering
  const useCanvas = hasEffects && canvasWorking

  return (
    <div className={`relative rounded-xl overflow-hidden bg-[#1a1a2e] aspect-[4/3] border-2 transition-all duration-300 ${getBorderStyle()} ${isDead ? 'opacity-60' : ''}`}>
      {stream ? (
        <>
          {/* Video element — always visible as fallback, hidden only when canvas takes over */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isYou || isMuted}
            className={`w-full h-full object-cover ${useCanvas ? 'absolute opacity-0 pointer-events-none' : ''} ${isDead && !useCanvas ? 'grayscale' : ''}`}
          />
          {/* Canvas with effects — only shown when effects are needed and working */}
          {hasEffects && (
            <canvas
              ref={canvasRef}
              className={`w-full h-full object-cover ${useCanvas ? '' : 'absolute opacity-0 pointer-events-none'}`}
            />
          )}
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[2.5rem]">
          {isDead ? '💀' : '🎭'}
        </div>
      )}

      {/* Stress emoji HTML fallback — shown when canvas is not active */}
      {stressLevel > 0.3 && !isDead && !useCanvas && (
        <div className="absolute top-1 right-1 text-lg animate-bounce drop-shadow-[0_0_6px_rgba(239,68,68,0.8)]">
          {stressLevel > 0.6 ? '😱' : '😰'}
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

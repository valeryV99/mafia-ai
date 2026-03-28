import { useCallback, useEffect, useRef, useState } from 'react'

interface OverlayState {
  stress: number
  phase: 'lobby' | 'night' | 'day' | 'voting' | 'role_assignment' | 'game_over'
  isDead: boolean
}

/**
 * Draws real-time overlays (stress emoji, night tint, death grayscale)
 * on top of the local camera feed using a canvas.
 * Returns a processed MediaStream that can replace the raw camera in VideoTile.
 */
export function useVideoOverlay(rawStream: MediaStream | null | undefined) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const animFrameRef = useRef<number>(0)
  const stateRef = useRef<OverlayState>({ stress: 0, phase: 'lobby', isDead: false })
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null)

  // Initialize canvas + hidden video element
  useEffect(() => {
    if (!rawStream) {
      setProcessedStream(null)
      return
    }

    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    canvasRef.current = canvas
    ctxRef.current = canvas.getContext('2d')

    const video = document.createElement('video')
    video.srcObject = rawStream
    video.autoplay = true
    video.playsInline = true
    video.muted = true
    video.play()
    videoRef.current = video

    // Wait for video to be ready before capturing canvas stream
    video.onloadeddata = () => {
      canvas.width = video.videoWidth || 640
      canvas.height = video.videoHeight || 480

      const canvasStream = canvas.captureStream(30)
      // Copy audio tracks from original stream
      for (const track of rawStream.getAudioTracks()) {
        canvasStream.addTrack(track)
      }
      setProcessedStream(canvasStream)
      renderLoop()
    }

    function renderLoop() {
      const ctx = ctxRef.current
      const vid = videoRef.current
      const cvs = canvasRef.current
      if (!ctx || !vid || !cvs) return

      const { stress, phase, isDead } = stateRef.current
      const w = cvs.width
      const h = cvs.height

      // Draw base video frame
      ctx.drawImage(vid, 0, 0, w, h)

      // Death effect: grayscale overlay
      if (isDead) {
        const imageData = ctx.getImageData(0, 0, w, h)
        const data = imageData.data
        for (let i = 0; i < data.length; i += 4) {
          const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
          data[i] = gray
          data[i + 1] = gray
          data[i + 2] = gray
        }
        ctx.putImageData(imageData, 0, 0)
        ctx.globalAlpha = 0.5
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, h)
        ctx.globalAlpha = 1
      }

      // Night tint: dark blue overlay
      if (phase === 'night' && !isDead) {
        ctx.globalAlpha = 0.35
        ctx.fillStyle = '#050520'
        ctx.fillRect(0, 0, w, h)
        ctx.globalAlpha = 1
      }

      // Stress effects
      if (stress > 0.3 && !isDead) {
        // Red vignette glow at edges
        const intensity = Math.min(1, (stress - 0.3) / 0.7)
        const pulse = Math.sin(Date.now() / 300) * 0.3 + 0.7
        const gradient = ctx.createRadialGradient(w / 2, h / 2, w * 0.25, w / 2, h / 2, w * 0.6)
        gradient.addColorStop(0, 'transparent')
        gradient.addColorStop(1, `rgba(220, 38, 38, ${intensity * 0.3 * pulse})`)
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, w, h)

        // Stress emoji
        const emoji = stress > 0.6 ? '😱' : '😰'
        const size = 28 + intensity * 12
        const bounce = Math.sin(Date.now() / 200) * 4
        ctx.font = `${size}px serif`
        ctx.textAlign = 'right'
        ctx.shadowColor = 'rgba(239, 68, 68, 0.8)'
        ctx.shadowBlur = 10
        ctx.fillText(emoji, w - 8, 32 + bounce)
        ctx.shadowBlur = 0
      }

      animFrameRef.current = requestAnimationFrame(renderLoop)
    }

    return () => {
      cancelAnimationFrame(animFrameRef.current)
      video.srcObject = null
      videoRef.current = null
      canvasRef.current = null
      ctxRef.current = null
      setProcessedStream(null)
    }
  }, [rawStream])

  const updateOverlay = useCallback((state: Partial<OverlayState>) => {
    Object.assign(stateRef.current, state)
  }, [])

  return { processedStream, updateOverlay }
}

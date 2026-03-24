import { useEffect, useRef, useCallback, useState } from 'react'

const GEMINI_SAMPLE_RATE = 24000
const MIC_SAMPLE_RATE = 16000

export function useAudioPipeline(wsRef: React.RefObject<WebSocket | null>) {
  // --- Playback (Gemini → speakers) ---
  const playbackCtxRef = useRef<AudioContext | null>(null)
  const playbackBufferRef = useRef<Float32Array[]>([])
  const playbackNodeRef = useRef<ScriptProcessorNode | null>(null)
  const isPlaybackStarted = useRef(false)
  const geminiSpeaking = useRef(false)
  const geminiSilenceTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ensurePlayback = useCallback(() => {
    if (isPlaybackStarted.current) return
    isPlaybackStarted.current = true

    const ctx = new AudioContext({ sampleRate: GEMINI_SAMPLE_RATE })
    playbackCtxRef.current = ctx
    ctx.resume().catch(() => {})

    // Use ScriptProcessorNode to drain the buffer continuously
    const node = ctx.createScriptProcessor(4096, 1, 1)
    playbackNodeRef.current = node

    node.onaudioprocess = (e) => {
      const output = e.outputBuffer.getChannelData(0)
      let offset = 0

      while (offset < output.length && playbackBufferRef.current.length > 0) {
        const chunk = playbackBufferRef.current[0]
        const remaining = chunk.length
        const needed = output.length - offset

        if (remaining <= needed) {
          output.set(chunk, offset)
          offset += remaining
          playbackBufferRef.current.shift()
        } else {
          output.set(chunk.subarray(0, needed), offset)
          playbackBufferRef.current[0] = chunk.subarray(needed)
          offset = output.length
        }
      }

      // Fill rest with silence
      if (offset < output.length) {
        output.fill(0, offset)
      }
    }

    node.connect(ctx.destination)
    console.log('Audio playback started')
  }, [])

  const playAudio = useCallback((pcmData: ArrayBuffer) => {
    ensurePlayback()

    // Suppress mic while Gemini is speaking to prevent echo feedback
    geminiSpeaking.current = true
    if (geminiSilenceTimeout.current) clearTimeout(geminiSilenceTimeout.current)
    geminiSilenceTimeout.current = setTimeout(() => {
      geminiSpeaking.current = false
    }, 500)

    // Convert PCM16 to Float32 and queue
    const int16 = new Int16Array(pcmData)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768
    }
    playbackBufferRef.current.push(float32)
  }, [ensurePlayback])

  // --- Mic capture (mic → Gemini) ---
  const micStreamRef = useRef<MediaStream | null>(null)
  const micCtxRef = useRef<AudioContext | null>(null)
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const isCapturing = useRef(false)
  const [isMuted, setIsMuted] = useState(true)
  const isMutedRef = useRef(true)

  useEffect(() => {
    isMutedRef.current = isMuted
  }, [isMuted])

  const startMicCapture = useCallback(async () => {
    if (isCapturing.current) return
    isCapturing.current = true

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: MIC_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      micStreamRef.current = stream

      const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
      micCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      micProcessorRef.current = processor

      let micSendCount = 0
      processor.onaudioprocess = (e) => {
        if (isMutedRef.current) return
        if (wsRef.current?.readyState !== WebSocket.OPEN) return

        const inputData = e.inputBuffer.getChannelData(0)
        const pcm16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]))
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        wsRef.current.send(pcm16.buffer)
        if (micSendCount++ % 50 === 0) {
          console.log(`[Mic] Sent chunk #${micSendCount} (${pcm16.buffer.byteLength} bytes)`)
        }
      }

      source.connect(processor)
      processor.connect(ctx.destination)
      console.log('Mic capture started (muted by default)')
    } catch (err) {
      console.error('Failed to start mic capture:', err)
      isCapturing.current = false
    }
  }, [wsRef])

  const stopMicCapture = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    micProcessorRef.current?.disconnect()
    micProcessorRef.current = null
    micCtxRef.current?.close()
    micCtxRef.current = null
    isCapturing.current = false
  }, [])

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      console.log(prev ? 'Mic UNMUTED' : 'Mic MUTED')
      return !prev
    })
  }, [])

  // Cleanup
  useEffect(() => {
    return () => {
      stopMicCapture()
      playbackNodeRef.current?.disconnect()
      playbackCtxRef.current?.close()
      isPlaybackStarted.current = false
    }
  }, [stopMicCapture])

  return { playAudio, startMicCapture, stopMicCapture, isMuted, toggleMute }
}

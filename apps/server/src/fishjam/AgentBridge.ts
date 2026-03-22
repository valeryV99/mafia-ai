import { FishjamClient, FishjamAgent } from '@fishjam-cloud/js-server-sdk'
import * as GeminiIntegration from '@fishjam-cloud/js-server-sdk/gemini'
import type { GoogleGenAI, Session } from '@google/genai'
import { Modality } from '@google/genai'

const makeLog = (label: string) => (tag: string, ...args: unknown[]) => console.log(`[AgentBridge:${label}:${tag}]`, ...args)

export interface AgentBridgeCallbacks {
  onGeminiAudio?: (audio: Buffer) => void
  onTranscript?: (speaker: 'gemini' | 'player', text: string, speakerId?: string) => void
  onTurnComplete?: () => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
}

export class AgentBridge {
  private fishjamClient: FishjamClient
  private genAi: GoogleGenAI
  private agent: FishjamAgent | null = null
  private agentTrackId: string | null = null
  private geminiSession: Session | null = null
  private callbacks: AgentBridgeCallbacks = {}
  private muteOutput = false
  private muteInput = false

  // VAD floor control
  private activeSpeakerId: string | null = null
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly SILENCE_THRESHOLD = 300 // ms

  private narratorSpeaking = false
  private narratorStartedAt = 0
  private pendingPhaseTransition: (() => void) | null = null
  private pendingPhaseTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly PENDING_PHASE_TIMEOUT_MS = 15_000

  private log: ReturnType<typeof makeLog>

  constructor(fishjamId: string, managementToken: string, geminiApiKey: string, label: string = 'GM') {
    this.fishjamClient = new FishjamClient({ fishjamId, managementToken })
    this.genAi = GeminiIntegration.createClient({ apiKey: geminiApiKey })
    this.log = makeLog(label)
    this.log('init', 'AgentBridge created')
  }

  async start(roomId: string, systemPrompt: string, tools?: object[], voiceName: string = 'Orus', muteOutput: boolean = false, skipVAD: boolean = false, disableAudioInput: boolean = false): Promise<void> {
    this.log('start', `Joining room ${roomId.slice(0, 20)}...`)

    this.muteOutput = muteOutput

    // 1. Create Fishjam Agent (ghost peer)
    const { agent } = await this.fishjamClient.createAgent(roomId as any, {
      subscribeMode: 'auto',
      output: GeminiIntegration.geminiInputAudioSettings,
    })
    this.agent = agent
    await agent.awaitConnected()
    this.log('start', 'Agent connected to Fishjam')

    // 2. Create outgoing audio track for Gemini responses
    const agentTrack = agent.createTrack(GeminiIntegration.geminiOutputAudioSettings)
    this.agentTrackId = agentTrack.id
    this.log('start', `Agent track created: ${agentTrack.id}`)

    // 3. Connect to Gemini Live
    // UPDATE the sessionConfig to use the passed voiceName
    const sessionConfig: any = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName }, // <-- Changed here
        },
      },
    }

    if (tools && tools.length > 0) {
      sessionConfig.tools = [{ functionDeclarations: tools }]
    }

    this.geminiSession = await this.genAi.live.connect({
      model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        ...sessionConfig,
        systemInstruction: systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => this.log('gemini', 'Session opened'),
        onclose: (e: any) => this.log('gemini', `Session closed: ${e?.code || 'unknown'}`),
        onerror: (e: any) => this.log('gemini', 'Error:', e),
        onmessage: (msg: any) => this.handleGeminiMessage(msg),
      },
    })

    this.log('start', 'Gemini session connected')

    // 4. Bridge: Player audio → Gemini (skipped in text-only mode)
    if (disableAudioInput) return

    let trackDataCount = 0
    let lastTrackLogAt = 0
    agent.on('trackData', (event: any) => {
      if (this.muteInput) return

      const { peerId, data } = event
      trackDataCount++

      // Log first trackData and then every 5 seconds to confirm audio is flowing
      const now = Date.now()
      if (trackDataCount === 1 || now - lastTrackLogAt > 5000) {
        this.log('trackData', `[${skipVAD ? 'native-vad' : 'floor-vad'}] receiving audio from peer ${peerId} (chunk #${trackDataCount}, ${data.length}b)`)
        lastTrackLogAt = now
      }

      if (skipVAD) {
        // Native VAD mode: forward all audio directly to Gemini, let it decide when to respond
        this.geminiSession?.sendRealtimeInput({
          audio: {
            mimeType: GeminiIntegration.inputMimeType,
            data: Buffer.from(data).toString('base64'),
          },
        })
        return
      }

      // Floor-control VAD (used by GameMaster)
      if (this.activeSpeakerId === null) {
        if (this.hasVoice(data)) {
          this.activeSpeakerId = peerId
          this.log('vad', `Floor taken by peer ${peerId}`)
        }
      }

      if (this.activeSpeakerId === peerId) {
        if (this.narratorSpeaking) return

        this.geminiSession?.sendRealtimeInput({
          audio: {
            mimeType: GeminiIntegration.inputMimeType,
            data: Buffer.from(data).toString('base64'),
          },
        })

        if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
        if (!this.hasVoice(data)) {
          this.silenceTimeout = setTimeout(() => {
            this.log('vad', `Floor released by peer ${peerId}`)
            this.activeSpeakerId = null
          }, this.SILENCE_THRESHOLD)
        }
      }
    })

    if (!disableAudioInput) {
      this.log('start', 'Audio bridge active')
    } else {
      this.log('start', 'Audio input disabled — text-only input mode')
    }
  }

  private handleGeminiMessage(msg: any) {
    const parts = msg.serverContent?.modelTurn?.parts

    // CRITICAL: Only send audio to Fishjam if muteOutput is FALSE
    if (!this.muteOutput && parts && this.agent && this.agentTrackId) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const pcmData = Buffer.from(part.inlineData.data, 'base64')
          this.agent.sendData(this.agentTrackId as any, pcmData)
        }
      }
    }

    // Tool calls
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || []
      for (const fc of functionCalls) {
        this.log('toolCall', `${fc.name}(${JSON.stringify(fc.args)})`)
        this.callbacks.onToolCall?.(fc.name, fc.args || {})

        // Send tool response
        this.geminiSession?.sendToolResponse({
          functionResponses: [{
            id: fc.id,
            name: fc.name,
            response: { success: true },
          }],
        })
      }
    }

    // Interruption handling
    if (msg.serverContent?.interrupted) {
      this.log('interrupt', 'Player interrupted Gemini — clearing buffer')
      if (this.agent && this.agentTrackId) {
        this.agent.interruptTrack(this.agentTrackId as any)
      }
    }

    // Input transcription (what player said)
    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text
      this.log('heard', `peerId="${this.activeSpeakerId ?? 'unknown'}" text="${text}"`)
      this.callbacks.onTranscript?.('player', text, this.activeSpeakerId ?? undefined)
    }

    // Output transcription (what Gemini said)
    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text
      if (!this.narratorSpeaking) {
        this.narratorStartedAt = Date.now()
        this.log('narrator', 'SPEAKING start')
      }
      this.narratorSpeaking = true
      this.log('said', `"${text}"`)
      this.callbacks.onTranscript?.('gemini', text)
    }

    // Turn complete
    if (msg.serverContent?.turnComplete) {
      const duration = Date.now() - this.narratorStartedAt
      this.log('narrator', `DONE after ${(duration / 1000).toFixed(1)}s`)
      this.narratorSpeaking = false
      this.callbacks.onTurnComplete?.()
      if (this.pendingPhaseTransition) {
        if (this.pendingPhaseTimeout) clearTimeout(this.pendingPhaseTimeout)
        const fn = this.pendingPhaseTransition
        this.pendingPhaseTransition = null
        this.log('narrator', 'Firing pending phase transition')
        fn()
      }
    }
  }

  // Simple voice activity detection based on audio energy
  private hasVoice(data: Uint8Array): boolean {
    const aligned = new Uint8Array(data.length)
    aligned.set(data)
    if (aligned.length < 2) return false
    const int16 = new Int16Array(aligned.buffer, 0, Math.floor(aligned.length / 2))
    let energy = 0
    for (let i = 0; i < int16.length; i++) {
      energy += Math.abs(int16[i])
    }
    const avgEnergy = energy / int16.length

    // DEBUG: Uncomment this to see the numbers in your console
    // if (avgEnergy > 50) console.log(`[VAD] Energy: ${avgEnergy.toFixed(0)}`)

    return avgEnergy > 50 // <-- Lowered from 500 to 150
  }

  afterNarratorFinishes(fn: () => void) {
    this.pendingPhaseTransition = fn
    this.pendingPhaseTimeout = setTimeout(() => {
      if (this.pendingPhaseTransition === fn) {
        this.log('narrator', `Pending transition timed out after ${this.PENDING_PHASE_TIMEOUT_MS}ms — forcing`)
        this.pendingPhaseTransition = null
        fn()
      }
    }, this.PENDING_PHASE_TIMEOUT_MS)
  }

  sendText(message: string) {
    this.log('sendText', message.slice(0, 100))
    try {
      this.geminiSession?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: message }] }],
        turnComplete: true,
      })
    } catch (err) {
      this.log('sendText', 'ERROR:', err)
    }
  }

  setMuteInput(muted: boolean) {
    this.muteInput = muted
    this.log('mute', `Input ${muted ? 'MUTED' : 'UNMUTED'}`)
  }

  isAlive(): boolean {
    return this.agent !== null && this.geminiSession !== null
  }

  on(callbacks: AgentBridgeCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  disconnect() {
    this.log('disconnect', 'Shutting down')
    this.geminiSession?.close()
    this.geminiSession = null
    this.agent?.disconnect()
    this.agent = null
    this.agentTrackId = null
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
    if (this.pendingPhaseTimeout) clearTimeout(this.pendingPhaseTimeout)
    this.pendingPhaseTransition = null
  }
}

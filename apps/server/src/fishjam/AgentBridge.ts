import { FishjamClient, FishjamAgent } from '@fishjam-cloud/js-server-sdk'
import * as GeminiIntegration from '@fishjam-cloud/js-server-sdk/gemini'
import type { GoogleGenAI, Session } from '@google/genai'
import { Modality } from '@google/genai'

const makeLog = (label: string) => (tag: string, ...args: unknown[]) => console.log(`[AgentBridge:${label}:${tag}]`, ...args)

export interface AgentBridgeCallbacks {
  onGeminiAudio?: (audio: Buffer) => void
  onTranscript?: (speaker: 'gemini' | 'player', text: string, speakerId?: string) => void
  onTurnComplete?: () => void
  onSessionClose?: () => void
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
  private name: string
  private muteInput = false

  // VAD floor control
  private activeSpeakerId: string | null = null
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly SILENCE_THRESHOLD = 300

  // Audio filter — only forward audio from known human peers
  private allowedPeerIds: Set<string> | null = null
  private narratorSpeaking = false
  private seenPeerIds: Set<string> = new Set()

  // Gemini session config — stored for reconnection
  private sessionConfig: any = null
  private sessionSystemPrompt: string = ''
  private intentionalDisconnect = false
  private reconnectAttempts = 0
  private readonly MAX_RECONNECT_ATTEMPTS = 3
  private readonly RECONNECT_DELAY_MS = 2000

  // Narrator timing & phase transition (from main)
  private narratorStartedAt: number = 0
  private pendingPhaseTransition: (() => void) | null = null
  private pendingPhaseTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly PENDING_PHASE_TIMEOUT_MS = 30000
  // Synthetic turnComplete: if no audio arrives for this many ms, assume the turn is done
  private audioSilenceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly AUDIO_SILENCE_TURN_COMPLETE_MS = 3000
  // Queue for sendText() calls that arrive while narrator is mid-speech
  private pendingTextQueue: string[] = []

  // Fix: log is stored as an instance method via makeLog
  private log: (tag: string, ...args: unknown[]) => void

  constructor(fishjamId: string, managementToken: string, geminiApiKey: string, label: string = 'GM') {
    this.fishjamClient = new FishjamClient({ fishjamId, managementToken })
    this.genAi = GeminiIntegration.createClient({ apiKey: geminiApiKey })
    this.log = makeLog(label)
    // Fix: assign this.name so log statements referencing it work correctly
    this.name = label
  }

  async start(
    roomId: string,
    systemPrompt: string,
    tools?: object[],
    voiceName: string = 'Orus',
    muteOutput: boolean = false,
    skipVAD: boolean = false,
    disableAudioInput: boolean = false,
  ): Promise<void> {
    this.log('start', `Joining room ${roomId.slice(0, 20)}...`)

    this.muteOutput = muteOutput

    const { agent } = await this.fishjamClient.createAgent(roomId as any, {
      subscribeMode: 'auto',
      output: GeminiIntegration.geminiInputAudioSettings,
    })
    this.agent = agent
    await agent.awaitConnected()
    this.log('start', 'Agent connected to Fishjam')

    const agentTrack = agent.createTrack(GeminiIntegration.geminiOutputAudioSettings)
    this.agentTrackId = agentTrack.id

    const sessionConfig: any = {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    }
    if (tools && tools.length > 0) {
      sessionConfig.tools = [{ functionDeclarations: tools }]
    }

    // Store for reconnection
    this.sessionConfig = sessionConfig
    this.sessionSystemPrompt = systemPrompt
    this.intentionalDisconnect = false

    this.geminiSession = await this.genAi.live.connect({
      model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        ...sessionConfig,
        systemInstruction: systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          this.log('gemini', `Session OPENED for ${this.name}`)
          this.reconnectAttempts = 0
        },
        onclose: (e: any) => {
          const code = e?.code || 'unknown'
          const reason = e?.reason || 'none'
          this.log('gemini', `Session CLOSED for ${this.name}: code=${code} reason=${reason}`)
          this.geminiSession = null
          // Cancel timers that would fire stale callbacks after session death
          if (this.audioSilenceTimer) { clearTimeout(this.audioSilenceTimer); this.audioSilenceTimer = null }
          this.narratorSpeaking = false
          if (!this.intentionalDisconnect && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++
            this.log('gemini', `Reconnecting Gemini session (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}) in ${this.RECONNECT_DELAY_MS}ms...`)
            setTimeout(() => this.reconnectGeminiSession(), this.RECONNECT_DELAY_MS)
          } else {
            this.callbacks.onSessionClose?.()
          }
        },
        onerror: (e: any) => this.log('gemini', `Session ERROR for ${this.name}:`, e?.message || e),
        onmessage: (msg: any) => this.handleGeminiMessage(msg),
      },
    })

    this.log('start', 'Gemini session connected')

    // Fix: log before early return so the correct message is always emitted
    if (disableAudioInput) {
      this.log('start', 'Audio input disabled — text-only input mode')
      return
    }

    agent.on('trackData', (event: any) => {
      if (this.muteInput) return

      const { peerId, data } = event

      if (skipVAD) {
        // Native VAD mode: only forward audio from allowed peers, let Gemini decide when to respond
        if (this.allowedPeerIds !== null && !this.allowedPeerIds.has(peerId)) return
        this.geminiSession?.sendRealtimeInput({
          audio: {
            mimeType: GeminiIntegration.inputMimeType,
            data: Buffer.from(data).toString('base64'),
          },
        })
        return
      }

      // Only forward audio from allowed (human) peers
      if (this.allowedPeerIds !== null && !this.allowedPeerIds.has(peerId)) return

      if (this.activeSpeakerId === null) {
        if (this.hasVoice(data)) {
          this.activeSpeakerId = peerId
        }
      }

      if (this.activeSpeakerId === peerId) {
        if (this.narratorSpeaking) return

        this.geminiSession?.sendRealtimeInput({
          audio: { mimeType: GeminiIntegration.inputMimeType, data: Buffer.from(data).toString('base64') },
        })

        if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
        if (!this.hasVoice(data)) {
          this.silenceTimeout = setTimeout(() => {
            this.activeSpeakerId = null
          }, this.SILENCE_THRESHOLD)
        }
      }
    })

    this.log('start', 'Audio bridge active')
  }

  private handleGeminiMessage(msg: any) {
    const parts = msg.serverContent?.modelTurn?.parts

    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const pcmData = Buffer.from(part.inlineData.data, 'base64')
          if (!this.muteOutput && this.agent && this.agentTrackId) {
            this.agent.sendData(this.agentTrackId as any, pcmData)
          }
          this.callbacks.onGeminiAudio?.(pcmData)
          // Reset synthetic turnComplete timer — audio is still flowing
          if (this.audioSilenceTimer) clearTimeout(this.audioSilenceTimer)
          this.audioSilenceTimer = setTimeout(() => {
            this.audioSilenceTimer = null
            if (this.narratorSpeaking) {
              const duration = Date.now() - this.narratorStartedAt
              this.log('turnComplete', `[${this.name}] SYNTHETIC turnComplete (audio silence ${this.AUDIO_SILENCE_TURN_COMPLETE_MS}ms after last chunk, spoke ${(duration / 1000).toFixed(1)}s)`)
              this.onTurnDone()
            }
          }, this.AUDIO_SILENCE_TURN_COMPLETE_MS)
        } else if (part.text !== undefined) {
          // text part — expected for native audio transcript fallback, skip silently
        } else {
          this.log('audio', `unexpected part keys: ${Object.keys(part).join(', ')}`)
        }
      }
    }

    // Tool calls — batch all responses in one sendToolResponse
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || []
      for (const fc of functionCalls) {
        this.log('toolCall', `[${this.name}] → ${fc.name}(${JSON.stringify(fc.args)})`)
        this.callbacks.onToolCall?.(fc.name, fc.args || {})
      }
      if (functionCalls.length > 0) {
        this.geminiSession?.sendToolResponse({
          functionResponses: functionCalls.map((fc: any) => ({
            id: fc.id, name: fc.name, response: { success: true },
          })),
        })
      }
    }

    if (msg.serverContent?.interrupted) {
      this.log('gemini', `[${this.name}] INTERRUPTED`)
      if (this.agent && this.agentTrackId) {
        this.agent.interruptTrack(this.agentTrackId as any)
      }
    }

    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text
      this.log('heard', `peerId="${this.activeSpeakerId ?? 'unknown'}" text="${text}"`)
      this.callbacks.onTranscript?.('player', text, this.activeSpeakerId ?? undefined)
    }

    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text
      if (!this.narratorSpeaking) {
        this.narratorStartedAt = Date.now()
        this.log('narrator', `[${this.name}] SPEAKING — first chunk: "${text.slice(0, 60)}"`)
      }
      this.narratorSpeaking = true
      // Only fire transcript callback when output is not muted
      if (!this.muteOutput) {
        this.callbacks.onTranscript?.('gemini', text)
      }
    }

    // Fix: retain the (msg as any).turnComplete fallback from flow-fixing in case
    // the Gemini SDK emits a top-level turnComplete (older SDK behaviour)
    const isTurnComplete = msg.serverContent?.turnComplete || (msg as any).turnComplete
    if (isTurnComplete) {
      // Cancel synthetic timer — real turnComplete arrived
      if (this.audioSilenceTimer) { clearTimeout(this.audioSilenceTimer); this.audioSilenceTimer = null }
      if (!this.narratorSpeaking) {
        // Synthetic already fired — skip to avoid double-firing
        return
      }
      const duration = Date.now() - this.narratorStartedAt
      this.log('turnComplete', `[${this.name}] turnComplete received after ${(duration / 1000).toFixed(1)}s, hasPendingTransition=${!!this.pendingPhaseTransition}`)
      this.onTurnDone()
    }
  }

  private onTurnDone() {
    this.narratorSpeaking = false
    this.callbacks.onTurnComplete?.()
    if (this.pendingPhaseTransition) {
      if (this.pendingPhaseTimeout) clearTimeout(this.pendingPhaseTimeout)
      const fn = this.pendingPhaseTransition
      this.pendingPhaseTransition = null
      this.log('turnComplete', `[${this.name}] Firing pending phase transition`)
      fn()
    }
    // Flush any sendText() calls that were queued while narrator was speaking
    if (this.pendingTextQueue.length > 0) {
      const next = this.pendingTextQueue.shift()!
      this._sendTextNow(next)
    }
  }

  private hasVoice(data: Uint8Array): boolean {
    const aligned = new Uint8Array(data.length)
    aligned.set(data)
    if (aligned.length < 2) return false
    const int16 = new Int16Array(aligned.buffer, 0, Math.floor(aligned.length / 2))
    let energy = 0
    for (let i = 0; i < int16.length; i++) energy += Math.abs(int16[i])
    return (energy / int16.length) > 50
  }

  allowPeer(peerId: string) {
    if (!this.allowedPeerIds) this.allowedPeerIds = new Set()
    this.allowedPeerIds.add(peerId)
  }

  afterNarratorFinishes(fn: () => void) {
    this.log('narrator', `[${this.name}] afterNarratorFinishes called — narratorSpeaking=${this.narratorSpeaking}, sessionAlive=${!!this.geminiSession}`)
    if (!this.narratorSpeaking) {
      this.log('narrator', `[${this.name}] Already idle — firing transition in 100ms`)
      setTimeout(fn, 100)
      return
    }
    this.pendingPhaseTransition = fn
    this.log('narrator', `[${this.name}] Waiting for turnComplete (timeout: ${this.PENDING_PHASE_TIMEOUT_MS / 1000}s)`)
    this.pendingPhaseTimeout = setTimeout(() => {
      if (this.pendingPhaseTransition === fn) {
        this.log('narrator', `[${this.name}] Pending transition TIMED OUT after ${this.PENDING_PHASE_TIMEOUT_MS / 1000}s — forcing transition`)
        this.pendingPhaseTransition = null
        fn()
      }
    }, this.PENDING_PHASE_TIMEOUT_MS)
  }

  sendText(message: string) {
    const sessionAlive = !!this.geminiSession
    this.log('sendText', `[${this.name}] sessionAlive=${sessionAlive} narratorSpeaking=${this.narratorSpeaking} msg="${message.slice(0, 120)}"`)
    if (!sessionAlive) {
      this.log('sendText', `[${this.name}] WARNING: No Gemini session — message lost!`)
      return
    }
    if (this.narratorSpeaking) {
      this.log('sendText', `[${this.name}] Narrator mid-speech — queuing message (queue size: ${this.pendingTextQueue.length + 1})`)
      this.pendingTextQueue.push(message)
      return
    }
    this._sendTextNow(message)
  }

  private _sendTextNow(message: string) {
    try {
      this.geminiSession?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: message }] }],
        turnComplete: true,
      })
    } catch (err) {
      this.log('sendText', `[${this.name}] ERROR:`, err)
    }
  }

  // Inject context — routes through sendText queue (turnComplete:false caused 1008 disconnects)
  sendSilentContext(message: string) {
    this.sendText(message)
  }

  setMuteInput(muted: boolean) {
    this.muteInput = muted
    if (muted) {
      // Reset VAD state so reactivation always starts clean
      this.activeSpeakerId = null
      this.narratorSpeaking = false
      if (this.silenceTimeout) {
        clearTimeout(this.silenceTimeout)
        this.silenceTimeout = null
      }
      // Cancel the synthetic turnComplete timer — prevents a spurious onTurnDone (and
      // therefore a spurious advanceAgentChain) if Gemini generated audio while the agent
      // was output-muted (narratorSpeaking got set but no audible speech occurred).
      if (this.audioSilenceTimer) {
        clearTimeout(this.audioSilenceTimer)
        this.audioSilenceTimer = null
      }
    }
  }

  setMuteOutput(muted: boolean) {
    this.muteOutput = muted
    // Interrupt any buffered audio already queued in Fishjam when muting mid-speech
    if (muted && this.agent && this.agentTrackId) {
      this.agent.interruptTrack(this.agentTrackId as any)
    }
  }

  isAlive(): boolean {
    return this.agent !== null && this.geminiSession !== null
  }

  on(callbacks: AgentBridgeCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  private async reconnectGeminiSession() {
    if (this.intentionalDisconnect || !this.sessionConfig) return
    this.log('gemini', `Attempting Gemini session reconnect...`)
    try {
      this.geminiSession = await this.genAi.live.connect({
        model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          ...this.sessionConfig,
          systemInstruction: this.sessionSystemPrompt,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            this.log('gemini', `Session RECONNECTED for ${this.name} (attempt ${this.reconnectAttempts})`)
            this.reconnectAttempts = 0
            // Reset narrator state so the game can continue
            this.narratorSpeaking = false
            this.pendingTextQueue = []
            this.pendingPhaseTransition = null
            if (this.pendingPhaseTimeout) { clearTimeout(this.pendingPhaseTimeout); this.pendingPhaseTimeout = null }
          },
          onclose: (e: any) => {
            const code = e?.code || 'unknown'
            this.log('gemini', `Reconnected session CLOSED: code=${code}`)
            this.geminiSession = null
            if (!this.intentionalDisconnect && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
              this.reconnectAttempts++
              setTimeout(() => this.reconnectGeminiSession(), this.RECONNECT_DELAY_MS)
            } else {
              this.callbacks.onSessionClose?.()
            }
          },
          onerror: (e: any) => this.log('gemini', `Reconnected session ERROR:`, e?.message || e),
          onmessage: (msg: any) => this.handleGeminiMessage(msg),
        },
      })
    } catch (err) {
      this.log('gemini', `Reconnect failed:`, err)
      if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++
        setTimeout(() => this.reconnectGeminiSession(), this.RECONNECT_DELAY_MS)
      } else {
        this.callbacks.onSessionClose?.()
      }
    }
  }

  disconnect() {
    this.log('disconnect', 'Shutting down')
    this.intentionalDisconnect = true
    this.geminiSession?.close()
    this.geminiSession = null
    this.agent?.disconnect()
    this.agent = null
    this.agentTrackId = null
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
    if (this.audioSilenceTimer) { clearTimeout(this.audioSilenceTimer); this.audioSilenceTimer = null }
    if (this.pendingPhaseTimeout) clearTimeout(this.pendingPhaseTimeout)
    this.pendingTextQueue = []
  }
}
import { FishjamClient, FishjamAgent } from '@fishjam-cloud/js-server-sdk'
import * as GeminiIntegration from '@fishjam-cloud/js-server-sdk/gemini'
import type { GoogleGenAI, Session } from '@google/genai'
import { Modality } from '@google/genai'

const log = (tag: string, ...args: unknown[]) => console.log(`[AgentBridge:${tag}]`, ...args)

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
  private name: string

  // VAD floor control
  private activeSpeakerId: string | null = null
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly SILENCE_THRESHOLD = 300

  // Audio filter — only forward audio from known human peers
  private allowedPeerIds: Set<string> | null = null
  private narratorSpeaking = false
  private seenPeerIds: Set<string> = new Set()

  constructor(fishjamId: string, managementToken: string, geminiApiKey: string, name: string = 'Bridge') {
    this.name = name
    this.fishjamClient = new FishjamClient({ fishjamId, managementToken })
    this.genAi = GeminiIntegration.createClient({ apiKey: geminiApiKey })
    log('init', `[${this.name}] AgentBridge created`)
  }

  async start(roomId: string, systemPrompt: string, tools?: object[], voiceName: string = 'Orus', muteOutput: boolean = false): Promise<void> {
    log('start', `Joining room ${roomId.slice(0, 20)}...`)
    this.muteOutput = muteOutput

    const { agent } = await this.fishjamClient.createAgent(roomId as any, {
      subscribeMode: 'auto',
      output: GeminiIntegration.geminiInputAudioSettings,
    })
    this.agent = agent
    await agent.awaitConnected()
    log('start', 'Agent connected to Fishjam')

    const agentTrack = agent.createTrack(GeminiIntegration.geminiOutputAudioSettings)
    this.agentTrackId = agentTrack.id

    const sessionConfig: any = {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
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
        onopen: () => log('gemini', `[${this.name}] Session opened`),
        onclose: (e: any) => log('gemini', `[${this.name}] Session closed: ${e?.code || 'unknown'}`),
        onerror: (e: any) => log('gemini', `[${this.name}] Error:`, e),
        onmessage: (msg: any) => this.handleGeminiMessage(msg),
      },
    })

    log('start', 'Gemini session connected')

    agent.on('trackData', (event: any) => {
      const { peerId, data } = event

      // Log each new peerId seen (once per peer)
      if (!this.seenPeerIds.has(peerId)) {
        this.seenPeerIds.add(peerId)
        const allowed = this.allowedPeerIds === null ? 'YES(no filter)' : this.allowedPeerIds.has(peerId) ? 'YES' : 'NO'
        log('audio', `[${this.name}] New peer ${peerId.slice(0, 8)} → allowed: ${allowed}`)
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

    log('start', 'Audio bridge active')
  }

  private handleGeminiMessage(msg: any) {
    const parts = msg.serverContent?.modelTurn?.parts

    if (!this.muteOutput && parts && this.agent && this.agentTrackId) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const pcmData = Buffer.from(part.inlineData.data, 'base64')
          this.agent.sendData(this.agentTrackId as any, pcmData)
        }
      }
    }

    // Tool calls — batch all responses in one sendToolResponse
    if (msg.toolCall) {
      const functionCalls = msg.toolCall.functionCalls || []
      for (const fc of functionCalls) {
        log('tool', `${fc.name}(${JSON.stringify(fc.args)})`)
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
      log('gemini', `[${this.name}] INTERRUPTED`)
      if (this.agent && this.agentTrackId) {
        this.agent.interruptTrack(this.agentTrackId as any)
      }
    }

    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text
      this.callbacks.onTranscript?.('player', text, this.activeSpeakerId ?? undefined)
    }

    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text
      this.narratorSpeaking = true
      this.callbacks.onTranscript?.('gemini', text)
    }

    const isTurnComplete = msg.serverContent?.turnComplete || (msg as any).turnComplete
    if (isTurnComplete) {
      this.narratorSpeaking = false
      this.callbacks.onTurnComplete?.()
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
    log('audio', `Allowed peer ${peerId.slice(0, 8)} (total: ${this.allowedPeerIds.size})`)
  }

  sendText(message: string) {
    try {
      this.geminiSession?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: message }] }],
        turnComplete: true,
      })
    } catch (err) {
      log('sendText', 'ERROR:', err)
    }
  }

  isAlive(): boolean {
    return this.agent !== null && this.geminiSession !== null
  }

  on(callbacks: AgentBridgeCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  disconnect() {
    log('disconnect', 'Shutting down')
    this.geminiSession?.close()
    this.geminiSession = null
    this.agent?.disconnect()
    this.agent = null
    this.agentTrackId = null
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
  }
}

import { FishjamClient, FishjamAgent } from '@fishjam-cloud/js-server-sdk'
import * as GeminiIntegration from '@fishjam-cloud/js-server-sdk/gemini'
import type { GoogleGenAI, Session } from '@google/genai'
import { Modality } from '@google/genai'

const log = (tag: string, ...args: unknown[]) => console.log(`[AgentBridge:${tag}]`, ...args)

export interface AgentBridgeCallbacks {
  onGeminiAudio?: (audio: Buffer) => void
  onTranscript?: (speaker: 'gemini' | 'player', text: string) => void
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

  // VAD floor control
  private activeSpeakerId: string | null = null
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly SILENCE_THRESHOLD = 300 // ms

  constructor(fishjamId: string, managementToken: string, geminiApiKey: string) {
    this.fishjamClient = new FishjamClient({ fishjamId, managementToken })
    this.genAi = GeminiIntegration.createClient({ apiKey: geminiApiKey })
    log('init', 'AgentBridge created')
  }

  async start(roomId: string, systemPrompt: string, tools?: object[], voiceName: string = 'Orus', muteOutput: boolean = false): Promise<void> {
    log('start', `Joining room ${roomId.slice(0, 20)}...`)

    this.muteOutput = muteOutput

    // 1. Create Fishjam Agent (ghost peer)
    const { agent } = await this.fishjamClient.createAgent(roomId as any, {
      subscribeMode: 'auto',
      output: GeminiIntegration.geminiInputAudioSettings,
    })
    this.agent = agent
    await agent.awaitConnected()
    log('start', 'Agent connected to Fishjam')

    // 2. Create outgoing audio track for Gemini responses
    const agentTrack = agent.createTrack(GeminiIntegration.geminiOutputAudioSettings)
    this.agentTrackId = agentTrack.id
    log('start', `Agent track created: ${agentTrack.id}`)

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
        onopen: () => log('gemini', 'Session opened'),
        onclose: (e: any) => log('gemini', `Session closed: ${e?.code || 'unknown'}`),
        onerror: (e: any) => log('gemini', 'Error:', e),
        onmessage: (msg: any) => this.handleGeminiMessage(msg),
      },
    })

    log('start', 'Gemini session connected')

    // 4. Bridge: Player audio → Gemini
    let audioChunkCount = 0
    agent.on('trackData', (event: any) => {
      const { peerId, data } = event

      if (this.activeSpeakerId === null) {
        // Check if audio has voice (simple energy check)
        if (this.hasVoice(data)) {
          this.activeSpeakerId = peerId
          log('vad', `Floor taken by peer ${peerId}`)
        }
      }

      if (this.activeSpeakerId === peerId) {
        // Forward to Gemini
        this.geminiSession?.sendRealtimeInput({
          audio: {
            mimeType: GeminiIntegration.inputMimeType,
            data: Buffer.from(data).toString('base64'),
          },
        })

        // Reset silence timer
        if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
        if (!this.hasVoice(data)) {
          this.silenceTimeout = setTimeout(() => {
            log('vad', `Floor released by peer ${peerId}`)
            this.activeSpeakerId = null
          }, this.SILENCE_THRESHOLD)
        }
      }
      // Other speakers' audio is dropped
    })

    log('start', 'Audio bridge active')
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
        log('toolCall', `${fc.name}(${JSON.stringify(fc.args)})`)
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
      log('interrupt', 'Player interrupted Gemini — clearing buffer')
      if (this.agent && this.agentTrackId) {
        this.agent.interruptTrack(this.agentTrackId as any)
      }
    }

    // Input transcription (what player said)
    if (msg.serverContent?.inputTranscription?.text) {
      const text = msg.serverContent.inputTranscription.text
      log('heard', `"${text}"`)
      this.callbacks.onTranscript?.('player', text)
    }

    // Output transcription (what Gemini said)
    if (msg.serverContent?.outputTranscription?.text) {
      const text = msg.serverContent.outputTranscription.text
      log('said', `"${text}"`)
      this.callbacks.onTranscript?.('gemini', text)
    }

    // Turn complete
    if (msg.serverContent?.turnComplete) {
      log('turn', 'Complete')
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

  sendText(message: string) {
    log('sendText', message.slice(0, 100))
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

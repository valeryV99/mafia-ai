const log = (tag: string, ...args: unknown[]) => console.log(`[Gemini:${tag}]`, ...args)

// Gemini 2.5 Flash with native audio I/O — optimized for real-time voice conversations
const GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025'

/**
 * Build tool declarations for the Game Master.
 * Player names are listed in the prompt (not as enums) to avoid compatibility issues
 * with Gemini Live API streaming mode.
 */
export function buildGameTools() {
  return [
    {
      name: 'night_kill',
      description: 'Mafia eliminates a player during night. Call immediately when you hear the mafia player say a target name.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target: { type: 'STRING', description: 'Name of the player to eliminate' },
        },
        required: ['target'],
      },
    },
    {
      name: 'investigate',
      description: 'Detective checks if a player is mafia. Call immediately when the detective says a target name.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target: { type: 'STRING', description: 'Name of the player to investigate' },
        },
        required: ['target'],
      },
    },
    {
      name: 'doctor_save',
      description: 'Doctor protects a player from elimination. Call immediately when the doctor says a target name.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target: { type: 'STRING', description: 'Name of the player to protect' },
        },
        required: ['target'],
      },
    },
    {
      name: 'resolve_night',
      description: 'End the night phase and resolve all actions. Call only after ALL night actions are collected.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'start_voting',
      description: 'Transition from day discussion to voting. Call after sufficient discussion.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'cast_vote',
      description: 'Record a player vote to eliminate someone. Call the moment you hear the voter say a valid target name.',
      parameters: {
        type: 'OBJECT',
        properties: {
          voter: { type: 'STRING', description: 'Name of the player casting the vote' },
          target: { type: 'STRING', description: 'Name of the player being voted against' },
        },
        required: ['voter', 'target'],
      },
    },
    {
      name: 'update_suspicion',
      description: 'Update suspicion level for a player based on speech, behavior, and face analysis data.',
      parameters: {
        type: 'OBJECT',
        properties: {
          player: { type: 'STRING', description: 'Name of the player' },
          score: { type: 'NUMBER', description: 'Suspicion 1 (innocent) to 10 (highly suspicious)' },
          reason: { type: 'STRING', description: 'Brief reason for the score' },
        },
        required: ['player', 'score', 'reason'],
      },
    },
    {
      name: 'behavioral_note',
      description: 'Record a behavioral observation about a player — contradictions, emotional signals, voice patterns.',
      parameters: {
        type: 'OBJECT',
        properties: {
          player: { type: 'STRING', description: 'Name of the player' },
          note: { type: 'STRING', description: 'Observation' },
        },
        required: ['player', 'note'],
      },
    },
  ]
}

export class GeminiSession {
  private ws: WebSocket | null = null
  private apiKey: string
  private onAudioCallback: ((audio: Buffer) => void) | null = null
  private onCommandCallback: ((cmd: Record<string, string>) => void) | null = null
  private onTranscriptCallback: ((speaker: 'gemini' | 'player', text: string) => void) | null = null
  private onTurnCompleteCallback: (() => void) | null = null
  private onCloseCallback: (() => void) | null = null
  private audioChunkCount = 0
  private totalAudioBytes = 0
  private systemPrompt = ''

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async connect(systemPrompt: string): Promise<void> {
    this.systemPrompt = systemPrompt
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`

    log('connect', `Connecting to ${GEMINI_MODEL}...`)

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        log('connect', 'WebSocket opened, sending setup...')
        this.ws!.send(
          JSON.stringify({
            setup: {
              model: GEMINI_MODEL,
              systemInstruction: {
                parts: [{ text: systemPrompt }],
              },
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: 'Orus',
                    },
                  },
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              tools: [{ functionDeclarations: buildGameTools() }],
            },
          })
        )
      }

      this.ws.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)

        let msg: any
        try {
          msg = JSON.parse(raw)
        } catch (err) {
          log('error', 'Failed to parse message:', err)
          return
        }

        if (msg.setupComplete) {
          log('connect', 'Session ready')
          resolve()
          return
        }

        const toolCall = msg.toolCall
        if (toolCall) {
          const functionCalls = toolCall.functionCalls || []
          for (const fc of functionCalls) {
            log('toolCall', `${fc.name}(${JSON.stringify(fc.args)})`)
            this.onCommandCallback?.({ action: fc.name, ...fc.args })
            this.sendToolResponse(fc.id, fc.name, { success: true })
          }
        }

        const parts = msg.serverContent?.modelTurn?.parts
        if (parts) {
          for (const part of parts) {
            if (part.inlineData?.data) {
              let audio: Buffer
              try {
                audio = Buffer.from(part.inlineData.data, 'base64')
              } catch (err) {
                log('error', 'Failed to decode audio:', err)
                continue
              }
              this.audioChunkCount++
              this.totalAudioBytes += audio.length
              this.onAudioCallback?.(audio)
            }
          }
        }

        if (msg.serverContent?.inputTranscription?.text) {
          const text = msg.serverContent.inputTranscription.text
          log('heard', `"${text}"`)
          this.onTranscriptCallback?.('player', text)
        }

        if (msg.serverContent?.outputTranscription?.text) {
          const text = msg.serverContent.outputTranscription.text
          log('said', `"${text}"`)
          this.onTranscriptCallback?.('gemini', text)
        }

        if (msg.serverContent?.turnComplete) {
          log('turn', `Complete (${this.audioChunkCount} chunks, ${(this.totalAudioBytes / 1024).toFixed(1)}KB audio)`)
          this.audioChunkCount = 0
          this.totalAudioBytes = 0
          this.onTurnCompleteCallback?.()
        }
      }

      this.ws.onerror = (err) => {
        log('error', 'WebSocket error:', err)
        reject(err)
      }

      this.ws.onclose = (event) => {
        log('close', `Code: ${event.code}, reason: ${event.reason || 'none'}`)
        this.ws = null
        this.onCloseCallback?.()
      }
    })
  }

  sendToolResponse(functionCallId: string, functionName: string, result: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{
          id: functionCallId,
          name: functionName,
          response: result,
        }],
      },
    }))
  }

  private audioSendLog = 0
  sendAudio(chunk: Buffer) {
    if (!this.ws) {
      if (this.audioSendLog++ % 100 === 0) log('sendAudio', 'No WebSocket — dropped')
      return
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      if (this.audioSendLog++ % 100 === 0) log('sendAudio', `Not open (state: ${this.ws.readyState}) — dropped`)
      return
    }
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: chunk.toString('base64'),
        },
      },
    }))
  }

  isAlive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  sendText(message: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('sendText', `FAILED (ws ${this.ws ? 'state:' + this.ws.readyState : 'null'}): ${message.slice(0, 100)}`)
      return
    }
    log('sendText', message)
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: message }] }],
        turnComplete: true,
      },
    }))
  }

  onAudioResponse(cb: (audio: Buffer) => void) { this.onAudioCallback = cb }
  onCommand(cb: (cmd: Record<string, string>) => void) { this.onCommandCallback = cb }
  onTranscript(cb: (speaker: 'gemini' | 'player', text: string) => void) { this.onTranscriptCallback = cb }
  onTurnComplete(cb: () => void) { this.onTurnCompleteCallback = cb }
  onClose(cb: () => void) { this.onCloseCallback = cb }

  async reconnect(): Promise<void> {
    log('reconnect', 'Attempting reconnect...')
    this.ws?.close()
    this.ws = null
    await this.connect(this.systemPrompt)
  }

  disconnect() {
    this.onCloseCallback = null
    log('disconnect', 'Closing session')
    this.ws?.close()
    this.ws = null
  }
}

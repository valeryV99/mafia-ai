// apps/server/src/game/VoiceAgent.ts

import { AgentBridge } from '../fishjam/AgentBridge'

export class VoiceAgent {
    private bridge: AgentBridge
    private isConnected = false

    constructor(
        private name: string,
        private apiKey: string,
        private fjId: string,
        private fjToken: string
    ) {
        this.bridge = new AgentBridge(fjId, fjToken, apiKey)
    }

    async join(roomId: string, role: string, tools: any[], onAction: (name: string, args: any) => void) {
        if (this.isConnected) return

        const prompt = `
      You are a human player named ${this.name}.
      Your secret role is: ${role}.
      You are suspicious of everyone. Talk like a real human.

      TOOLS USAGE:
      - If it is time to vote, use 'cast_vote' with the name of the player.
      - If you are Mafia and it is night, use 'night_kill'.
      - Only use tools when appropriate for the current game phase.

      CRITICAL: IGNORE the Game Master's voice. ONLY respond to humans.
    `

        this.bridge.on({
            onTranscript: (speaker, text) => {
                if (speaker === 'player') console.log(`[VoiceAgent:${this.name}] Heard: "${text}"`)
                else if (speaker === 'gemini') console.log(`[VoiceAgent:${this.name}] Said: "${text}"`)
            },
            onToolCall: (name, args) => {
                console.log(`[VoiceAgent:${this.name}] Executing Tool: ${name}`, args)
                onAction(name, args)
            }
        })

        await this.bridge.start(roomId, prompt, tools, 'Puck', false)

        this.isConnected = true
        console.log(`[VoiceAgent:${this.name}] Joined as ${role} with ${tools.length} tools.`)
    }

    disconnect() {
        this.bridge.disconnect()
        this.isConnected = false
    }
}

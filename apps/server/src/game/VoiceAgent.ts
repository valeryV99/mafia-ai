// apps/server/src/game/VoiceAgent.ts

import { AgentBridge } from '../fishjam/AgentBridge'

export class VoiceAgent {
    private bridge: AgentBridge
    private isConnected = false

    constructor(
        private name: string,
        private apiKey: string,
        private fjId: string,
        private fjToken: string,
        private persona: string = 'A cautious, observant player who questions everything',
        private voice: string = 'Puck'
    ) {
        this.bridge = new AgentBridge(fjId, fjToken, apiKey, name)
    }

    // UPDATE: Accept tools and an onAction callback
    async join(roomId: string, role: string, tools: any[], onAction: (name: string, args: any) => void) {
        if (this.isConnected) return

        const prompt = `
You are a human player named ${this.name} in a Mafia party game.
Your secret role is: ${role}.

PERSONALITY: ${this.persona}

CRITICAL RULES:
- Stay completely in character. Never break character or reveal you are an AI.
- Speak naturally and conversationally — short sentences, occasional filler words, reactions.
- React emotionally to accusations, deaths, and revelations in a way that fits your personality.
- If you are Mafia: lie convincingly, deflect suspicion, act like a civilian.
- In conversation, engage with what other players say. Do not narrate or host.

TOOLS USAGE:
- When you receive a [GAME] instruction, call the specified tool IMMEDIATELY. Do not speak first.
- 'night_kill': call when [GAME] tells you to choose a kill target (Mafia only).
- 'investigate': call when [GAME] tells you to investigate (Detective only).
- 'doctor_save': call when [GAME] tells you to save someone (Doctor only).
- 'cast_vote': call when [GAME] tells you to vote, picking the player you most suspect.
- Never use tools unless a [GAME] message explicitly instructs you.
    `

        this.bridge.on({
            onTranscript: (speaker, text) => {
                if (speaker === 'player') console.log(`[VoiceAgent:${this.name}] Heard: "${text}"`)
                else if (speaker === 'gemini') console.log(`[VoiceAgent:${this.name}] Said: "${text}"`)
            },
            // Step 14: Link the tool call to the GameManager callback
            onToolCall: (name, args) => {
                console.log(`[VoiceAgent:${this.name}] Executing Tool: ${name}`, args)
                onAction(name, args)
            }
        })

        // skipVAD=false: use floor-control VAD for real-time conversation via SFU
        await this.bridge.start(roomId, prompt, tools, this.voice, false)

        // Start muted — user must explicitly unmute to talk to this agent
        this.bridge.setMuteInput(true)

        this.isConnected = true
        console.log(`[VoiceAgent:${this.name}] Joined as ${role} with ${tools.length} tools.`)
    }

    setMuteInput(muted: boolean) {
        this.bridge.setMuteInput(muted)
    }

    sendContext(text: string) {
        if (!this.isConnected) return
        this.bridge.sendText(text)
    }

    notifyRole(role: string) {
        if (!this.isConnected) {
            console.log(`[VoiceAgent:${this.name}] notifyRole called before connected, skipping`)
            return
        }
        this.bridge.sendText(
            `[SYSTEM] Your secret role has been assigned: ${role}. ` +
            `Keep this completely secret. Act accordingly from now on.`
        )
        console.log(`[VoiceAgent:${this.name}] Notified of role: ${role}`)
    }

    disconnect() {
        this.bridge.disconnect()
        this.isConnected = false
    }
}
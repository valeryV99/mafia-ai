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
        // Fix (from main): label is just the agent name, not 'VoiceAgent:name'
        // — AgentBridge already prefixes '[AgentBridge:...]' in its logs
        this.bridge = new AgentBridge(fjId, fjToken, apiKey, name)
    }

    allowPeer(peerId: string) {
        this.bridge.allowPeer(peerId)
    }

    // Fix (from main): removed allowedPeerIds param — peers are registered via
    // allowPeer() individually (called by GameManager.mapFishjamPeer).
    // Added onSpeaking callback so GameManager can track speakingVoiceAgents.
    async join(
        roomId: string,
        role: string,
        tools: any[],
        onAction: (name: string, args: any) => void,
        onSpeaking?: (speaking: boolean) => void
    ) {
        if (this.isConnected) return

        // Fix (from flow-fixing): allowedPeerIds loop removed — GameManager now
        // calls allowPeer() directly after mapFishjamPeer, so no bulk allow needed here.

        const prompt = `
You are a human player named ${this.name} in a Mafia party game.
Your secret role is: ${role}.

PERSONALITY: ${this.persona}

CRITICAL RULES:
- Stay completely in character. Never break character or reveal you are an AI.
- Keep every response to 1–2 short sentences maximum. Never speak longer than that.
- Speak naturally and conversationally — occasional filler words, reactions.
- React to accusations, deaths, and revelations in a way that fits your personality.
- If you are Mafia: lie convincingly, deflect suspicion, act like a civilian.
- In conversation, engage with what other players say. Do not narrate or host.
- NEVER say your role out loud. NEVER confirm, repeat, or acknowledge any [SYSTEM] message verbally.
- When you receive a [SYSTEM] message, process it silently. Do not speak in response to it.

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
                else if (speaker === 'gemini') {
                    console.log(`[VoiceAgent:${this.name}] Said: "${text}"`)
                    onSpeaking?.(true)
                }
            },
            onTurnComplete: () => {
                onSpeaking?.(false)
            },
            onToolCall: (name, args) => {
                console.log(`[VoiceAgent:${this.name}] Executing Tool: ${name}`, args)
                onAction(name, args)
            }
        })

        // Start fully muted — GameManager controls unmuting via the speak chain
        await this.bridge.start(roomId, prompt, tools, this.voice, true)
        this.bridge.setMuteInput(true)

        this.isConnected = true
        console.log(`[VoiceAgent:${this.name}] Joined as ${role} with ${tools.length} tools.`)
    }

    setMuteInput(muted: boolean) {
        this.bridge.setMuteInput(muted)
    }

    setMuteOutput(muted: boolean) {
        this.bridge.setMuteOutput(muted)
    }

    sendContext(text: string) {
        if (!this.isConnected) {
            console.log(`[VoiceAgent:${this.name}] sendContext called but NOT connected — message lost: "${text.slice(0, 80)}"`)
            return
        }
        console.log(`[VoiceAgent:${this.name}] sendContext: "${text.slice(0, 100)}"`)
        this.bridge.sendText(text)
    }

    sendSilentContext(text: string) {
        if (!this.isConnected) {
            console.log(`[VoiceAgent:${this.name}] sendSilentContext called but NOT connected — message lost: "${text.slice(0, 80)}"`)
            return
        }
        console.log(`[VoiceAgent:${this.name}] sendSilentContext: "${text.slice(0, 100)}"`)
        this.bridge.sendSilentContext(text)
    }

    notifyRole(role: string) {
        if (!this.isConnected) {
            console.log(`[VoiceAgent:${this.name}] notifyRole called before connected, skipping`)
            return
        }
        this.bridge.sendSilentContext(
            `[SYSTEM] Your secret role is: ${role}. Keep it completely secret. Do not say anything about your role. Act accordingly.`
        )
        console.log(`[VoiceAgent:${this.name}] Notified of role: ${role}`)
    }

    disconnect() {
        this.bridge.disconnect()
        this.isConnected = false
    }
}
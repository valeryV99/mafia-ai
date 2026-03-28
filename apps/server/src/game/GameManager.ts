import type { GameState, Player, Phase, Role, ServerEvent } from '@mafia-ai/types'
import type { ServerWebSocket } from 'bun'
import { AgentBridge } from '../fishjam/AgentBridge'
import { buildGameMasterPrompt } from '../gemini/prompts'
import { GAME_CONSTANTS } from './constants'
import { VoiceAgent } from './VoiceAgent'

const log = (roomId: string, tag: string, ...args: unknown[]) =>
  console.log(`[Game:${roomId}][${tag}]`, ...args)

export class GameManager {
  private state: GameState
  private clients: Map<string, ServerWebSocket<{ playerId: string }>>
  private votes: Map<string, string> = new Map()
  private bridge: AgentBridge | null = null
  private fishjamRoomId: string | null = null
  private nightTimeout: ReturnType<typeof setTimeout> | null = null
  private mafiaGraceTimer: ReturnType<typeof setTimeout> | null = null
  private dayTimeout: ReturnType<typeof setTimeout> | null = null
  private votingTimeout: ReturnType<typeof setTimeout> | null = null
  private resolving = false
  // Fix: removed duplicate pendingPhaseTransition — main branch delegates this to
  // bridge.afterNarratorFinishes(); flow-fixing's local field is only kept as a
  // fallback safety net in startNight / resolveVotes (see usage below)
  private pendingPhaseTransition: (() => void) | null = null
  private fishjamPeerNames: Map<string, string> = new Map()

  // Voice agent state (from main)
  private voiceAgents: Map<string, VoiceAgent> = new Map()
  private voiceAgentCount = 0
  private activeVoiceAgentName: string | null = null
  private speakingVoiceAgents = new Set<string>()
  private pendingAfterSpeech: (() => void) | null = null

  // Sequential speak chain: agents speak in order, one at a time
  private agentChainActive = false          // true when agents are in active (non-phase-muted) mode
  private agentChainIndex = 0               // index into getOrderedVoiceAgentNames()
  // User-controlled global mute for all AI agents
  private agentsManuallyMuted = false
  // Which agents are individually selected to participate
  private selectedAgentNames: Set<string> = new Set()

  // Bot state (from main)
  private botNames: Set<string> = new Set()
  private mafiaVotes: Map<string, string> = new Map()
  private detectiveTarget: string | null = null
  private doctorTarget: string | null = null
  // Fix: nightActions used in main's logNightProgress / handleVoiceFallback
  private nightActions: Map<string, string> = new Map()

  // Night action windows — tracks which human players have their voice window open
  private nightActionWindowPlayers: Set<string> = new Set()

  // Timing helpers (from main)
  private dayStartedAt: number = 0
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private voiceFallbackTimeout: ReturnType<typeof setTimeout> | null = null
  private _gmAudioLogged = false
  private faceMetricsCooldowns: Map<string, number> = new Map()

  private static readonly VOICE_AGENT_POOL = [
    {
      name: 'Marcus',
      persona: 'The Skeptic — calm, analytical, always demands logic and evidence before trusting anyone. Speaks slowly and deliberately. Uses phrases like "that doesn\'t add up" and "prove it".',
      voice: 'Charon',
    },
    {
      name: 'Sophie',
      persona: 'The Empath — warm, perceptive, tries to defend the innocent. Speaks gently but gets very emotional when someone is accused unfairly. Uses phrases like "I just feel like..." and "something seems off".',
      voice: 'Kore',
    },
    {
      name: 'Rex',
      persona: 'The Alpha — confident, direct, and game-focused. Makes bold reads and sticks to them. Never rattled, never emotional — just decisive. Uses phrases like "my read is clear" and "I\'m locking in my vote".',
      voice: 'Fenrir',
    },
    {
      name: 'Luna',
      persona: 'The Strategist — cold, calculated, treats the game like a puzzle. Speaks in probabilities and patterns. Uses phrases like "statistically speaking" and "your behavior is consistent with mafia".',
      voice: 'Aoede',
    },
    {
      name: 'Finn',
      persona: 'The Joker — deflects with humor, hard to read, charismatic and likeable. Uses jokes to avoid suspicion. Uses phrases like "relax guys, it\'s just a game" and "okay okay, you got me... jk".',
      voice: 'Puck',
    },
    {
      name: 'Vera',
      persona: 'The Paranoid — anxious, suspects everyone, constantly changes her mind, talks fast. Uses phrases like "wait no I changed my mind" and "I don\'t trust anyone here".',
      voice: 'Zephyr',
    },
  ]

  constructor(roomId: string) {
    this.state = {
      roomId,
      phase: 'lobby',
      players: [],
      day: 1,
      winner: null,
      currentSpeakerId: null,
      voiceAgentIds: [],
      activeVoiceAgentId: null,
      agentsMuted: false,
      selectedAgentIds: [],
    }
    this.clients = new Map()
    log(roomId, 'init', 'Game created')
  }

  private log(tag: string, ...args: unknown[]) {
    log(this.state.roomId, tag, ...args)
  }

  get phase() { return this.state.phase }
  get players() { return this.state.players }
  get roomId() { return this.state.roomId }
  get connectedCount() { return this.clients.size }

  addPlayer(ws: ServerWebSocket<{ playerId: string }>, id: string, name: string): Player {
    const alreadyConnected = this.state.players.find((p) => p.name === name && p.isConnected)
    if (alreadyConnected) {
      this.clients.delete(alreadyConnected.id)
      alreadyConnected.id = id
      this.clients.set(id, ws)
      return alreadyConnected
    }

    const existing = this.state.players.find((p) => p.name === name && !p.isConnected)
    if (existing) {
      this.clients.delete(existing.id)
      existing.id = id
      existing.isConnected = true
      this.clients.set(id, ws)
      return existing
    }

    const player: Player = { id, name, role: 'civilian', status: 'alive', isConnected: true }
    this.state.players.push(player)
    this.clients.set(id, ws)
    this.log('addPlayer', `${name} joined. Total: ${this.state.players.length}`)
    return player
  }

  // addBot: internal helper used by addVoiceAgent (from main)
  private addBot(name: string): Player {
    const id = `voice-${crypto.randomUUID().slice(0, 8)}`
    const player: Player = { id, name, role: 'civilian', status: 'alive', isConnected: true }
    this.state.players.push(player)
    this.botNames.add(name)
    return player
  }

  isBot(name: string): boolean {
    return this.botNames.has(name)
  }

  getBotNames(): string[] {
    return [...this.botNames]
  }

  private afterAnyVoiceAgentStops(fn: () => void) {
    if (this.speakingVoiceAgents.size === 0) {
      fn()
    } else {
      this.pendingAfterSpeech = fn
    }
  }

  async addVoiceAgent() {
    if (this.voiceAgentCount >= 3) {
      this.log('voiceAgent', 'Maximum 3 AI agents allowed')
      return { error: 'Maximum 3 AI agents allowed' }
    }

    const pool = GameManager.VOICE_AGENT_POOL
    const agentDef = pool[this.voiceAgentCount % pool.length]
    const { name, persona, voice } = agentDef
    this.voiceAgentCount++

    if (this.voiceAgents.has(name)) {
      this.log('voiceAgent', `${name} already added, skipping`)
      return { error: 'Already added' }
    }

    const apiKey = process.env.GEMINI_API_KEY
    const fishjamId = process.env.FISHJAM_URL?.match(/\/\/([^.]+)/)?.[1]
    const managementToken = process.env.FISHJAM_MANAGEMENT_TOKEN

    if (!apiKey || !fishjamId || !managementToken) {
      this.log('voiceAgent', 'Missing credentials, skipping')
      return { error: 'Missing credentials' }
    }

    if (!this.fishjamRoomId) {
      this.log('voiceAgent', 'No Fishjam room ID set, skipping')
      return { error: 'Room not initialized' }
    }

    const fishjamRoomId = this.fishjamRoomId
    const player = this.addBot(name)

    const playerTools = [
      {
        name: 'cast_vote',
        description: 'Vote for a player to be eliminated during the voting phase',
        parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] }
      },
      {
        name: 'night_kill',
        description: 'Mafia only: Choose a player to kill at night',
        parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] }
      },
      {
        name: 'investigate',
        description: 'Detective only: Investigate a player to learn their role',
        parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] }
      },
      {
        name: 'doctor_save',
        description: 'Doctor only: Protect a player from being killed tonight',
        parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] }
      },
    ]

    const agent = new VoiceAgent(name, apiKey, fishjamId, managementToken, persona, voice)
    await agent.join(
      fishjamRoomId,
      player.role,
      playerTools,
      (toolName, args) => {
        this.handleGeminiCommand({
          action: toolName,
          voter: player.name,
          target: args.target
        } as any)
      },
      (speaking) => {
        if (speaking) {
          this.speakingVoiceAgents.add(player.name)
        } else {
          // Check wasAudible BEFORE deleting — guards against spurious silent turns
          const wasAudible = this.speakingVoiceAgents.has(player.name)
          this.speakingVoiceAgents.delete(player.name)
          this.advanceAgentChain(player.name, wasAudible)
          if (this.speakingVoiceAgents.size === 0 && this.pendingAfterSpeech) {
            const fn = this.pendingAfterSpeech
            this.pendingAfterSpeech = null
            fn()
          }
        }
        this.broadcastEvent({ type: 'speaker_changed', speakerId: speaking ? player.id : null })
      }
    )

    // Backfill already-known human peer IDs so this agent only accepts human audio.
    // Without this, allowedPeerIds stays null (all peers allowed), and the VAD floor
    // gets grabbed by other agents' output tracks, blocking human audio from reaching Gemini.
    for (const peerId of this.fishjamPeerNames.keys()) {
      agent.allowPeer(peerId)
    }

    this.voiceAgents.set(name, agent)
    this.selectedAgentNames.add(name)

    // Start the ordered speak chain (skipped during night/role_assignment or manual mute).
    if (this.state.phase !== 'night' && this.state.phase !== 'role_assignment' && !this.agentsManuallyMuted) {
      this.startAgentOutputChain()
    }

    this.broadcastEvent({
      type: 'phase_changed',
      phase: this.state.phase,
      state: this.getPublicState(),
    })

    return { ok: true, player }
  }

  setAllVoiceAgentsMuted(muted: boolean) {
    // Always mute everything first
    this.voiceAgents.forEach(a => { a.setMuteInput(true); a.setMuteOutput(true) })
    this.agentChainActive = false
    if (muted) {
      this.broadcastEvent({ type: 'speaker_changed', speakerId: null })
    }
  }

  setAgentsMuted(muted: boolean) {
    const lockedPhase = this.state.phase === 'night' || this.state.phase === 'role_assignment'
    if (lockedPhase) return // button is disabled in these phases — ignore

    this.agentsManuallyMuted = muted
    if (muted) {
      this.voiceAgents.forEach(a => { a.setMuteInput(true); a.setMuteOutput(true) })
      this.agentChainActive = false
      this.broadcastEvent({ type: 'speaker_changed', speakerId: null })
    } else {
      // Reset selection to all agents when turning AI back on, then start the speak chain
      this.voiceAgents.forEach((_, name) => this.selectedAgentNames.add(name))
      this.broadcastEvent({ type: 'agent_selection_changed', selectedAgentIds: this.getSelectedAgentIds() })
      this.startAgentOutputChain()
    }
    this.broadcastEvent({ type: 'agents_mute_changed', muted })
    this.log('voiceAgent', `Agents manually ${muted ? 'MUTED' : 'UNMUTED'}`)
  }

  setAgentSelected(agentId: string, selected: boolean) {
    const lockedPhase = this.state.phase === 'night' || this.state.phase === 'role_assignment'
    if (lockedPhase || this.agentsManuallyMuted) return

    const agentName = this.state.players.find(p => p.id === agentId)?.name
    if (!agentName || !this.voiceAgents.has(agentName)) return

    if (!selected) {
      // Must keep at least one agent selected
      if (this.selectedAgentNames.size <= 1) return
      this.selectedAgentNames.delete(agentName)
      this.voiceAgents.get(agentName)?.setMuteInput(true)
      this.voiceAgents.get(agentName)?.setMuteOutput(true)
    } else {
      this.selectedAgentNames.add(agentName)
    }
    // Restart chain so ordering is correct after selection change
    this.startAgentOutputChain()

    this.broadcastEvent({ type: 'agent_selection_changed', selectedAgentIds: this.getSelectedAgentIds() })
    this.log('voiceAgent', `Agent ${agentName} ${selected ? 'selected' : 'deselected'} — chain restarted`)
  }

  private getSelectedAgentIds(): string[] {
    return [...this.selectedAgentNames]
      .map(name => this.state.players.find(p => p.name === name)?.id)
      .filter((id): id is string => !!id)
  }

  private getOrderedVoiceAgentNames(): string[] {
    return GameManager.VOICE_AGENT_POOL
      .map(def => def.name)
      .filter(name =>
        this.voiceAgents.has(name) &&
        this.selectedAgentNames.has(name) &&
        this.state.players.find(p => p.name === name && p.status === 'alive')
      )
  }

  // Start sequential speak chain: mute all, unmute only the first in order.
  private startAgentOutputChain() {
    const ordered = this.getOrderedVoiceAgentNames()
    if (ordered.length === 0) { this.agentChainActive = false; return }
    this.agentChainActive = true
    this.agentChainIndex = 0
    this.voiceAgents.forEach(a => { a.setMuteInput(true); a.setMuteOutput(true) })
    const first = ordered[0]
    this.voiceAgents.get(first)?.setMuteInput(false)
    this.voiceAgents.get(first)?.setMuteOutput(false)
    this.log('chain', `Chain started — active: ${first} (${ordered.join(' → ')})`)
  }

  private advanceAgentChain(fromName: string, wasAudible: boolean) {
    if (!this.agentChainActive) return
    if (!wasAudible) return

    const ordered = this.getOrderedVoiceAgentNames()
    if (ordered.length === 0) { this.agentChainActive = false; return }

    const currentIndex = ordered.indexOf(fromName)
    if (currentIndex === -1) return

    // Mute current agent
    this.voiceAgents.get(fromName)?.setMuteInput(true)
    this.voiceAgents.get(fromName)?.setMuteOutput(true)
    this.broadcastEvent({ type: 'speaker_changed', speakerId: null })

    // Only notify GM during day/voting — during night this would trigger GM speech
    // that blocks player audio just as action windows open
    if (this.state.phase !== 'night') {
      this.bridge?.sendSilentContext(`[SYSTEM] ${fromName} has finished speaking.`)
    }

    // Advance to next (wraps around)
    const nextIndex = (currentIndex + 1) % ordered.length
    const nextName = ordered[nextIndex]
    this.agentChainIndex = nextIndex
    this.voiceAgents.get(nextName)?.setMuteInput(false)
    this.voiceAgents.get(nextName)?.setMuteOutput(false)
    this.log('chain', `Chain advanced: ${fromName} → ${nextName}`)
  }

  // kept for backwards-compat with any outstanding client set_active_agent messages
  setActiveVoiceAgent(_agentId: string | null) {}

  removePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (player) {
      player.isConnected = false
    }
    this.clients.delete(playerId)
    this.votes.delete(playerId)

    if (this.state.phase === 'voting') {
      const alivePlayers = this.state.players.filter((p) => p.status === 'alive' && p.isConnected)
      if (this.votes.size >= alivePlayers.length && alivePlayers.length > 0) {
        this.resolveVotes()
      }
    }
  }

  startGame() {
    if (this.state.phase !== 'lobby') return { error: 'Game already started' }
    if (this.state.players.length < GAME_CONSTANTS.MIN_PLAYERS) {
      return { error: `Need at least ${GAME_CONSTANTS.MIN_PLAYERS} players` }
    }

    // Wait for any speaking voice agent to finish before starting
    this.afterAnyVoiceAgentStops(() => this.doStartGame())
    return { ok: true }
  }

  private doStartGame() {
    this.log('startGame', `Starting with ${this.state.players.length} players`)
    this._gmAudioLogged = false
    this.assignRoles()
    this.state.phase = 'role_assignment'
    this.setAllVoiceAgentsMuted(true)
    this.broadcastEvent({ type: 'game_started', state: this.getPublicState() })

    this.state.players.forEach((player) => {
      this.sendToPlayer(player.id, { type: 'role_assigned', role: player.role })

      // Notify voice agents of their real role
      if (this.voiceAgents.has(player.name)) {
        this.voiceAgents.get(player.name)!.notifyRole(player.role)
      }
    })

    const roleSummary = this.state.players.map((p) => `${p.name}=${p.role}`).join(', ')
    this.log('roles', roleSummary)
    this.log('startGame', `initGemini launched`)
    this.initGemini()
  }

  private assignRoles() {
    const players = this.state.players
    const shuffled = [...players].sort(() => Math.random() - 0.5)

    const mafiaCount = Math.floor(players.length / 4)
    shuffled[0].role = 'detective'
    shuffled[1].role = 'doctor'
    for (let i = 0; i < mafiaCount; i++) {
      shuffled[i + 2].role = 'mafia'
    }
  }

  setFishjamRoomId(roomId: string) {
    this.fishjamRoomId = roomId
  }

  mapFishjamPeer(peerId: string, playerName: string) {
    this.fishjamPeerNames.set(peerId, playerName)
    // GM bridge has no allowedPeerIds filter (hears all Fishjam participants)
    this.voiceAgents.forEach((agent) => agent.allowPeer(peerId))
  }

  private async initGemini() {
    const apiKey = process.env.GEMINI_API_KEY
    const fishjamId = process.env.FISHJAM_URL?.match(/\/\/([^.]+)/)?.[1]
    const managementToken = process.env.FISHJAM_MANAGEMENT_TOKEN

    if (!apiKey || !fishjamId || !managementToken || !this.fishjamRoomId) {
      this.log('gemini', 'Missing credentials or room ID, skipping')
      return
    }

    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia')
    const detective = this.state.players.find((p) => p.role === 'detective')
    const doctor = this.state.players.find((p) => p.role === 'doctor')

    const prompt = buildGameMasterPrompt({
      players: this.state.players.map((p) => p.name),
      botNames: [...this.voiceAgents.keys()],
      mafiaNames: mafiaPlayers.map((p) => p.name),
      detectiveName: detective?.name || 'none',
      doctorName: doctor?.name || 'none',
    })

    const tools = [
      { name: 'night_kill', description: 'Mafia chooses a player to eliminate during night phase', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] } },
      { name: 'investigate', description: 'Detective investigates a player to learn their role', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] } },
      { name: 'doctor_save', description: 'Doctor protects a player from mafia kill', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] } },
      { name: 'resolve_night', description: 'Called after all night actions are collected to end the night phase', parameters: { type: 'OBJECT', properties: {} } },
      { name: 'start_voting', description: 'Start voting phase after discussion', parameters: { type: 'OBJECT', properties: {} } },
      { name: 'cast_vote', description: 'Record a vote from a player', parameters: { type: 'OBJECT', properties: { voter: { type: 'STRING' }, target: { type: 'STRING' } }, required: ['voter', 'target'] } },
      { name: 'update_suspicion', description: 'Update suspicion level for a player', parameters: { type: 'OBJECT', properties: { player: { type: 'STRING' }, score: { type: 'NUMBER' }, reason: { type: 'STRING' } }, required: ['player', 'score', 'reason'] } },
      { name: 'address_agent', description: 'Unmute a specific AI agent so they can respond when a player addresses them by name. Only call this when a player explicitly says an agent\'s name.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING', description: 'The agent name to unmute (e.g. Marcus, Sophie, Rex)' } }, required: ['name'] } },
    ]

    this.bridge = new AgentBridge(fishjamId, managementToken, apiKey, 'GameMaster')
    // No allowedPeerIds filter — GM hears all Fishjam participants (skipVAD lets Gemini handle VAD)

    this.bridge.on({
      onGeminiAudio: (audio) => {
        if (!this._gmAudioLogged) {
          this._gmAudioLogged = true
          this.log('GM', `First audio chunk received (${audio.length}b) — GM is speaking`)
        }
        this.broadcastBinary(audio)
      },

      onTranscript: (speaker, text, speakerId) => {
        const playerName = speakerId ? this.fishjamPeerNames.get(speakerId) : undefined
        this.broadcastEvent({ type: 'transcript', speaker, text, playerName })

        if (speaker === 'gemini') {
          this.log('GM', `Said: "${text.slice(0, 100)}"`)
          if (this.state.phase === 'day') this.resetSilenceTimer()
        }

        if (speaker === 'player') {
          if (playerName) {
            const player = this.state.players.find((p) => p.name === playerName)
            if (player) this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
          }
          this.log('GM', `Heard player${playerName ? ` (${playerName})` : ' (unknown)'}: "${text.slice(0, 100)}"`)
          this.handleVoiceFallback(text, playerName)
          if (this.state.phase === 'day') this.resetSilenceTimer()
        }
      },

      onTurnComplete: () => {
        this.broadcastEvent({ type: 'transcript_clear' })
        if (this.pendingPhaseTransition) {
          const fn = this.pendingPhaseTransition
          this.pendingPhaseTransition = null
          this.log('phase', 'turnComplete → pending transition')
          setTimeout(fn, 800)
        }
      },

      onSessionClose: () => {
        this.log('phase', 'GameMaster session closed — sending transcript_clear to unblock clients')
        this.broadcastEvent({ type: 'transcript_clear' })
      },

      onToolCall: (name, args) => {
        this.handleGeminiCommand({ action: name, ...args } as any)
      },
    })

    // skipVAD=true: all player audio reaches Gemini continuously (no floor-VAD blocking)
    await this.bridge.start(this.fishjamRoomId, prompt, tools, 'Orus', false, true)
    this.log('startGame', `Bridge READY — Game Master connected`)

    setTimeout(() => this.startNight(), GAME_CONSTANTS.ROLE_REVEAL_DELAY)
  }

  handleNightAction(playerId: string, targetId: string) {
    if (this.state.phase !== 'night') return
    const player = this.state.players.find((p) => p.id === playerId && p.status === 'alive')
    const target = this.state.players.find((p) => p.id === targetId && p.status === 'alive')
    if (!player || !target || player.id === target.id) return

    if (player.role === 'mafia') {
      this.mafiaVotes.set(playerId, targetId)
      this.closeNightActionWindow(playerId)
      // When all human mafia have voted, give 5s grace period for detective/doctor to act
      const humanMafia = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive' && !this.isBot(p.name))
      if (humanMafia.every((p) => this.mafiaVotes.has(p.id)) && !this.mafiaGraceTimer) {
        this.mafiaGraceTimer = setTimeout(() => {
          this.mafiaGraceTimer = null
          if (this.state.phase === 'night') {
            if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
            this.resolveNight()
          }
        }, 5000)
      }
    } else if (player.role === 'detective' && this.detectiveTarget === null) {
      this.detectiveTarget = targetId
      this.closeNightActionWindow(playerId)
    } else if (player.role === 'doctor' && this.doctorTarget === null) {
      this.doctorTarget = targetId
      this.closeNightActionWindow(playerId)
    }

    this.checkAllNightActionsComplete()
  }

  private isNightComplete(): boolean {
    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
    const detectiveAlive = this.state.players.some((p) => p.role === 'detective' && p.status === 'alive')
    const doctorAlive = this.state.players.some((p) => p.role === 'doctor' && p.status === 'alive')
    const humanMafia = mafiaPlayers.filter((p) => !this.isBot(p.name))
    const mafiaActed = mafiaPlayers.length === 0
      || (humanMafia.length === 0 ? this.mafiaVotes.size > 0 : humanMafia.every((p) => this.mafiaVotes.has(p.id)))
    const detectiveActed = this.detectiveTarget !== null || !detectiveAlive
    const doctorActed = this.doctorTarget !== null || !doctorAlive
    return mafiaActed && detectiveActed && doctorActed
  }

  private checkAllNightActionsComplete() {
    if (this.isNightComplete()) {
      if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
      this.resolveNight()
    }
  }

  private logNightProgress() {
    const nightActors = this.state.players.filter(
      (p) => p.status === 'alive' && (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
    )
    const acted = nightActors.filter((p) => this.nightActions.has(p.id))

    if (acted.length === nightActors.length) {
      setTimeout(() => {
        if (this.state.phase === 'night') {
          this.resolveNight()
        }
      }, 3000)
    }
  }

  private handleGeminiCommand(cmd: Record<string, string>) {
    const findAliveByName = (name: string) => {
      const lower = name?.toLowerCase()
      return this.state.players.find((p) => p.name.toLowerCase() === lower && p.status === 'alive')
    }

    switch (cmd.action) {
      case 'night_kill': {
        if (this.state.phase !== 'night') break
        const target = findAliveByName(cmd.target)
        const voterName = cmd.voter || cmd.player
        const voter = voterName
          ? findAliveByName(voterName)
          : this.state.players.find((p) => p.role === 'mafia' && p.status === 'alive')
        if (!target || !voter || voter.role !== 'mafia') break
        if (voter.id === target.id) break
        this.mafiaVotes.set(voter.id, target.id)
        if (!this.isBot(voter.name)) this.closeNightActionWindow(voter.id)
        // Notify narrator when a bot acts so it can continue narrating
        if (this.isBot(voter.name)) {
          const remainingMafia = this.state.players.filter(
            (p) => p.role === 'mafia' && p.status === 'alive' && !this.mafiaVotes.has(p.id)
          )
          if (remainingMafia.length === 0) {
            if (this.isNightComplete()) {
              this.bridge?.sendSilentContext(`[SYSTEM] All roles have acted. Call resolve_night now.`)
            } else {
              this.bridge?.sendSilentContext(`[SYSTEM] Mafia has acted. Do NOT speak. Stay silent and wait for remaining human roles to act.`)
            }
          }
        }
        this.checkAllNightActionsComplete()
        break
      }

      case 'investigate': {
        if (this.state.phase !== 'night' || this.detectiveTarget !== null) break
        const target = findAliveByName(cmd.target)
        if (!target) break
        this.detectiveTarget = target.id
        if (!this.isBot(cmd.voter || '')) {
          const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
          if (detective) this.closeNightActionWindow(detective.id)
        }
        // Notify narrator when a bot detective acts
        if (this.isBot(cmd.voter || '')) {
          if (this.isNightComplete()) {
            this.bridge?.sendSilentContext(`[SYSTEM] All roles have acted. Call resolve_night now.`)
          } else {
            this.bridge?.sendSilentContext(`[SYSTEM] Detective has acted. Do NOT speak. Stay silent and wait for remaining human roles.`)
          }
        }
        this.checkAllNightActionsComplete()
        break
      }

      case 'doctor_save': {
        if (this.state.phase !== 'night' || this.doctorTarget !== null) break
        const target = findAliveByName(cmd.target)
        if (!target) break
        this.doctorTarget = target.id
        if (!this.isBot(cmd.voter || '')) {
          const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')
          if (doctor) this.closeNightActionWindow(doctor.id)
        }
        // Notify narrator when a bot doctor acts
        if (this.isBot(cmd.voter || '')) {
          if (this.isNightComplete()) {
            this.bridge?.sendSilentContext(`[SYSTEM] All roles have acted. Call resolve_night now.`)
          } else {
            this.bridge?.sendSilentContext(`[SYSTEM] Bot Doctor has acted. Wait for remaining roles before calling resolve_night.`)
          }
        }
        this.checkAllNightActionsComplete()
        break
      }

      case 'resolve_night': {
        if (this.state.phase !== 'night') break
        if (!this.isNightComplete()) break
        if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
        this.resolveNight()
        break
      }

      case 'start_voting': {
        if (this.state.phase !== 'day') break
        this.startVoting()
        break
      }

      case 'cast_vote': {
        const findPlayer = (name: string) => {
          const lower = name.toLowerCase()
          return this.state.players.find((p) => p.name.toLowerCase() === lower && p.status === 'alive')
        }
        const voter = findPlayer(cmd.voter)
        const target = findPlayer(cmd.target)
        if (!voter || !target || this.state.phase !== 'voting') break
        this.votes.set(voter.id, target.id)
        this.broadcastEvent({ type: 'vote_cast', fromId: voter.id, targetId: target.id })

        // Fix (from main): count bots + connected humans, not just alive players
        const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
        if (this.votes.size >= eligibleVoters.length) {
          this.resolveVotes()
        }
        break
      }

      case 'update_suspicion': {
        const player = this.state.players.find((p) => {
          const lower = cmd.player?.toLowerCase()
          return p.name.toLowerCase() === lower && p.status === 'alive'
        })
        if (!player) break
        const score = Math.max(1, Math.min(10, Number(cmd.score) || 5))
        this.broadcastEvent({ type: 'suspicion_update', playerId: player.id, playerName: player.name, score, reason: cmd.reason })
        break
      }

      case 'address_agent': {
        const agentName = (cmd as any).name as string
        if (!agentName) break
        const agent = this.voiceAgents.get(agentName)
        if (!agent) {
          this.log('voiceAgent', `address_agent: unknown agent "${agentName}"`)
          break
        }
        if (this.agentsManuallyMuted) {
          this.log('voiceAgent', `address_agent: agents are manually muted — ignoring`)
          break
        }
        // Mute all agents first, then unmute only the addressed one
        this.voiceAgents.forEach(a => { a.setMuteInput(true); a.setMuteOutput(true) })
        agent.setMuteInput(false)
        agent.setMuteOutput(false)
        agent.sendContext(`[GAME] A player addressed you by name. Respond in 1–2 sentences then stop.`)
        const agentPlayer = this.state.players.find(p => p.name === agentName)
        if (agentPlayer) this.broadcastEvent({ type: 'speaker_changed', speakerId: agentPlayer.id })
        break
      }
    }
  }

  private handleVoiceFallback(text: string, speakerName?: string) {
    const lower = text.toLowerCase()
    const allPlayers = this.state.players
    const mentioned = allPlayers.find((p) => lower.includes(p.name.toLowerCase()))
    if (!mentioned) return

    if (this.state.phase === 'night') {
      const hasActed = (p: typeof this.state.players[0]) => {
        if (p.role === 'mafia') return this.mafiaVotes.has(p.id)
        if (p.role === 'detective') return this.detectiveTarget !== null
        if (p.role === 'doctor') return this.doctorTarget !== null
        return true
      }
      const humanNightActors = this.state.players.filter(
        (p) => p.status === 'alive' && !this.isBot(p.name) &&
          (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor') &&
          !hasActed(p)
      )
      // Prefer the actual speaker if known; fall back to first unacted human role
      const actorBySpeaker = speakerName
        ? humanNightActors.find((p) => p.name === speakerName)
        : undefined
      if (humanNightActors.length === 0) return
      if (humanNightActors.length > 0) {
        const actor = actorBySpeaker ?? humanNightActors[0]
        if (this.voiceFallbackTimeout) clearTimeout(this.voiceFallbackTimeout)
        this.voiceFallbackTimeout = setTimeout(() => {
          if (hasActed(actor)) return
          if (actor.role === 'mafia') this.mafiaVotes.set(actor.id, mentioned.id)
          else if (actor.role === 'detective') this.detectiveTarget = mentioned.id
          else if (actor.role === 'doctor') this.doctorTarget = mentioned.id
          this.closeNightActionWindow(actor.id)
          this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${mentioned.name}. Confirmed.` })
          this.bridge?.sendText(`[SYSTEM] ${actor.role} chose ${mentioned.name}. Say out loud: "${mentioned.name}. Noted." Then call resolve_night if all roles have acted, otherwise stay silent.`)
          this.checkAllNightActionsComplete()
        }, 500)
      }
    }

    if (this.state.phase === 'voting' && mentioned.status === 'alive') {
      const humanVoters = this.state.players.filter(
        (p) => p.status === 'alive' && !this.isBot(p.name) && !this.votes.has(p.id)
      )
      // Prefer the actual speaker if known; fall back to first human who hasn't voted
      const voterBySpeaker = speakerName
        ? humanVoters.find((p) => p.name === speakerName)
        : undefined
      if (humanVoters.length > 0) {
        const voter = voterBySpeaker ?? humanVoters[0]
        if (voter.id === mentioned.id) return
        if (this.voiceFallbackTimeout) clearTimeout(this.voiceFallbackTimeout)
        this.voiceFallbackTimeout = setTimeout(() => {
          if (this.votes.has(voter.id)) return
          this.votes.set(voter.id, mentioned.id)
          this.broadcastEvent({ type: 'vote_cast', fromId: voter.id, targetId: mentioned.id })
          this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${voter.name} votes for ${mentioned.name}.` })
          const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
          if (this.votes.size >= eligibleVoters.length) this.resolveVotes()
        }, 500)
      }
    }
  }


  // Handle text commands from player (typing fallback)
  handleTextCommand(playerId: string, text: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return



    const lower = text.toLowerCase()
    const mentioned = this.state.players.find(
      (p) => p.status === 'alive' && p.id !== player.id && lower.includes(p.name.toLowerCase())
    )

    if (!mentioned) {
      this.broadcastEvent({ type: 'transcript', speaker: 'player', text, playerName: player.name })
      this.bridge?.sendText(`[PLAYER] ${player.name} says: "${text}"`)
      return
    }

    if (this.state.phase === 'night') {
      if ((player.role === 'mafia' || player.role === 'detective' || player.role === 'doctor') && !this.nightActions.has(player.id)) {
        this.nightActions.set(player.id, mentioned.id)
        this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `Your choice: ${mentioned.name}. Confirmed.` })
        this.bridge?.sendText(`[SYSTEM] ${player.role} action received: target is ${mentioned.name}.`)
        this.logNightProgress()
      }
    } else if (this.state.phase === 'voting' && !this.votes.has(player.id)) {
      this.votes.set(player.id, mentioned.id)
      this.broadcastEvent({ type: 'vote_cast', fromId: player.id, targetId: mentioned.id })
      this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${player.name} votes for ${mentioned.name}.` })
      const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
      if (this.votes.size >= eligibleVoters.length) this.resolveVotes()
    } else if (this.state.phase === 'day') {
      this.broadcastEvent({ type: 'transcript', speaker: 'player', text, playerName: player.name })
      this.bridge?.sendText(`[PLAYER] ${player.name} says: "${text}"`)
    }
  }

  startNight() {
    this.resolving = false
    this.pendingPhaseTransition = null
    this.mafiaVotes.clear()
    this.detectiveTarget = null
    this.doctorTarget = null
    this.nightActions.clear()
    if (this.mafiaGraceTimer) { clearTimeout(this.mafiaGraceTimer); this.mafiaGraceTimer = null }
    this.state.phase = 'night'
    this.setAllVoiceAgentsMuted(true)
    this.broadcastEvent({ type: 'phase_changed', phase: 'night', state: this.getPublicState() })

    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
    const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
    const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')

    this.log('phase', `========== NIGHT ${this.state.day} ==========`)
    this.log('phase', `Alive players: ${this.state.players.filter(p => p.status === 'alive').map(p => `${p.name}(${p.role},${this.isBot(p.name) ? 'bot' : 'human'})`).join(', ')}`)
    this.log('phase', `Mafia: ${mafiaPlayers.map(p => `${p.name}(${this.isBot(p.name) ? 'bot' : 'human'})`).join(', ') || 'NONE'}`)
    this.log('phase', `Detective: ${detective ? `${detective.name}(${this.isBot(detective.name) ? 'bot' : 'human'})` : 'DEAD/NONE'}`)
    this.log('phase', `Doctor: ${doctor ? `${doctor.name}(${this.isBot(doctor.name) ? 'bot' : 'human'})` : 'DEAD/NONE'}`)
    this.log('GM', `Bridge alive: ${this.bridge?.isAlive() ?? false} — sending night prompt`)

    const roleInfo = (name: string | undefined, role: string) => {
      if (!name) return `No alive ${role}.`
      return `${role}: ${name} (${this.isBot(name) ? 'BOT — decide silently, call function without speaking' : 'HUMAN — wait for their voice response'}).`
    }

    this.bridge?.sendText(
      `[SYSTEM] Night ${this.state.day} begins.\n` +
      `Roles this night:\n` +
      `${roleInfo(mafiaPlayers.map((p) => p.name).join(', '), 'Mafia')}\n` +
      `${roleInfo(detective?.name, 'Detective')}\n` +
      `${roleInfo(doctor?.name, 'Doctor')}\n\n` +
      `INSTRUCTIONS:\n` +
      `1. Narrate the night atmosphere in 2-3 dramatic sentences. Do NOT reveal roles.\n` +
      `2. Then stay silent and listen. The server will tell you when each role has acted.\n` +
      `3. When you receive [SYSTEM] confirming an action, briefly acknowledge it out loud (one sentence).\n` +
      `4. When you receive [SYSTEM] that all roles are done → call resolve_night immediately.`
    )

    // Send direct night instructions to each VoiceAgent based on their role
    this.voiceAgents.forEach((agent, agentName) => {
      const player = this.state.players.find((p) => p.name === agentName && p.status === 'alive')
      if (!player) return
      const targets = this.state.players
        .filter((p) => p.status === 'alive' && p.name !== agentName)
        .map((p) => p.name).join(', ')
      if (player.role === 'mafia') {
        agent.sendContext(`[GAME] Night ${this.state.day}: You are Mafia. Call night_kill now. Choose from: ${targets}.`)
      } else if (player.role === 'detective') {
        agent.sendContext(`[GAME] Night ${this.state.day}: You are the Detective. Call investigate now. Choose from: ${targets}.`)
      } else if (player.role === 'doctor') {
        agent.sendContext(`[GAME] Night ${this.state.day}: You are the Doctor. Call doctor_save now. Choose from: ${targets}.`)
      }
    })

    // Bot retry: re-send instructions at 8s if bot hasn't acted yet
    setTimeout(() => {
      if (this.state.phase !== 'night') return
      this.voiceAgents.forEach((agent, agentName) => {
        const player = this.state.players.find((p) => p.name === agentName && p.status === 'alive')
        if (!player) return
        const targets = this.state.players
          .filter((p) => p.status === 'alive' && p.name !== agentName)
          .map((p) => p.name).join(', ')
        if (player.role === 'mafia' && !this.mafiaVotes.has(player.id)) {
          agent.sendContext(`[GAME] URGENT: You MUST call night_kill NOW. Pick one target from: ${targets}. Do NOT speak, just call the function.`)
        }
        if (player.role === 'detective' && this.detectiveTarget === null) {
          agent.sendContext(`[GAME] URGENT: You MUST call investigate NOW. Pick one target from: ${targets}. Do NOT speak, just call the function.`)
        }
        if (player.role === 'doctor' && this.doctorTarget === null) {
          agent.sendContext(`[GAME] URGENT: You MUST call doctor_save NOW. Pick one target from: ${targets}. Do NOT speak, just call the function.`)
        }
      })
    }, 8_000)

    // Bot fallback: if a bot hasn't called their function within 15s,
    // auto-assign a random target so the night doesn't stall
    setTimeout(() => {
      if (this.state.phase !== 'night') return
      const alivePlayers = this.state.players.filter((p) => p.status === 'alive')

      // Mafia bot fallback (NEW — was missing before!)
      const botMafia = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive' && this.isBot(p.name))
      for (const bot of botMafia) {
        if (!this.mafiaVotes.has(bot.id)) {
          const validTargets = alivePlayers.filter((p) => p.id !== bot.id)
          const randomTarget = validTargets[Math.floor(Math.random() * validTargets.length)]
          if (randomTarget) {
            this.mafiaVotes.set(bot.id, randomTarget.id)
          }
        }
      }

      const botDetective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive' && this.isBot(p.name))
      if (botDetective && this.detectiveTarget === null) {
        const validTargets = alivePlayers.filter((p) => p.id !== botDetective.id)
        const randomTarget = validTargets[Math.floor(Math.random() * validTargets.length)]
        if (randomTarget) {
          this.detectiveTarget = randomTarget.id
        }
      }

      const botDoctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive' && this.isBot(p.name))
      if (botDoctor && this.doctorTarget === null) {
        const validTargets = alivePlayers.filter((p) => p.id !== botDoctor.id)
        const randomTarget = validTargets[Math.floor(Math.random() * validTargets.length)]
        if (randomTarget) {
          this.doctorTarget = randomTarget.id
        }
      }

      this.checkAllNightActionsComplete()
    }, 15_000)

    // When narrator finishes → open voice action windows for human roles + start night timer
    this.pendingPhaseTransition = () => {
      this.openNightActionWindows()
      this.nightTimeout = setTimeout(() => this.resolveNight(), GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT)
    }

    // Safety fallback: if turnComplete never fires within 30s, start timer anyway
    setTimeout(() => {
      if (this.pendingPhaseTransition) {
        this.pendingPhaseTransition = null
        if (!this.nightTimeout) {
          this.nightTimeout = setTimeout(() => this.resolveNight(), GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT)
        }
      }
    }, 30_000)
  }

  private openNightActionWindows() {
    const humanSpecialRoles = this.state.players.filter(
      (p) => p.status === 'alive' && !this.isBot(p.name) &&
        (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
    )
    const unacted = humanSpecialRoles.filter((p) => {
      if (p.role === 'mafia') return !this.mafiaVotes.has(p.id)
      if (p.role === 'detective') return this.detectiveTarget === null
      if (p.role === 'doctor') return this.doctorTarget === null
      return false
    })
    for (const player of unacted) {
      this.nightActionWindowPlayers.add(player.id)
      this.sendToPlayer(player.id, { type: 'night_action_prompt', role: player.role })
    }
    // No sendSilentContext here — turnComplete:false caused 1008 session crashes.
    // The GM already has full instructions from the startNight() sendText call.
  }

  private closeNightActionWindow(playerId: string) {
    if (!this.nightActionWindowPlayers.has(playerId)) return
    this.nightActionWindowPlayers.delete(playerId)
    this.sendToPlayer(playerId, { type: 'night_action_received' })
  }

  private resolveNight() {
    if (this.resolving) return
    this.resolving = true
    if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
    if (this.mafiaGraceTimer) { clearTimeout(this.mafiaGraceTimer); this.mafiaGraceTimer = null }
    // Close any remaining open action windows
    this.nightActionWindowPlayers.forEach(pid => this.sendToPlayer(pid, { type: 'night_action_received' }))
    this.nightActionWindowPlayers.clear()

    // Log full night action summary
    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
    const detectivePlayer = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
    const doctorPlayer = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')
    // 1. Determine mafia kill target (majority vote, random on tie)
    const voteCounts = new Map<string, number>()
    this.mafiaVotes.forEach((targetId) => {
      voteCounts.set(targetId, (voteCounts.get(targetId) ?? 0) + 1)
    })
    let maxVotes = 0
    voteCounts.forEach((count) => { if (count > maxVotes) maxVotes = count })
    const topTargets = [...voteCounts.entries()].filter(([, c]) => c === maxVotes).map(([id]) => id)
    const mafiaTargetId = topTargets.length > 0
      ? topTargets[Math.floor(Math.random() * topTargets.length)]
      : null

    // 2. Check if doctor saved the target
    const doctorSaved = mafiaTargetId !== null && this.doctorTarget === mafiaTargetId
    const killedId = doctorSaved ? null : mafiaTargetId

    // 3. Detective gets investigation result
    if (this.detectiveTarget) {
      const target = this.state.players.find((p) => p.id === this.detectiveTarget)
      const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
      if (target && detective) {
        // Send via WebSocket for human detectives
        this.sendToPlayer(detective.id, {
          type: 'investigation_result',
          targetName: target.name,
          targetRole: target.role,
        })
        // Also send via voice agent context for bot detectives
        const detectiveAgent = this.voiceAgents.get(detective.name)
        if (detectiveAgent) {
          detectiveAgent.sendSilentContext(
            `[SYSTEM] Investigation result: ${target.name} is ${target.role === 'mafia' ? 'MAFIA' : 'NOT MAFIA (innocent)'}. Remember this — use it during the day discussion to guide the town.`
          )
        }
      }
    }

    // 4. Apply kill and check win condition
    if (killedId) {
      this.eliminatePlayer(killedId)
    }

    // 5. Reset night action storage
    this.mafiaVotes.clear()
    this.detectiveTarget = null
    this.doctorTarget = null

    // 6. Transition — wait for narrator AND any speaking voice agent before startDay
    if (this.bridge) {
      this.bridge.afterNarratorFinishes(() => this.afterAnyVoiceAgentStops(() => {
        if (this.state.phase !== 'game_over') this.startDay(killedId, doctorSaved)
      }))
    } else {
      setTimeout(() => this.afterAnyVoiceAgentStops(() => {
        if (this.state.phase !== 'game_over') this.startDay(killedId, doctorSaved)
      }), 3000)
    }
  }

  startDay(eliminatedId: string | null, doctorSaved: boolean = false) {
    this.resolving = false
    this.dayStartedAt = Date.now()
    const eliminatedName = eliminatedId
      ? this.state.players.find((p) => p.id === eliminatedId)?.name
      : null
    const eliminatedRole = eliminatedId
      ? this.state.players.find((p) => p.id === eliminatedId)?.role
      : null

    this.state.phase = 'day'
    this.state.day++
    this.setAllVoiceAgentsMuted(false)
    this.broadcastEvent({ type: 'phase_changed', phase: 'day', state: this.getPublicState() })

    const alivePlayers = this.state.players.filter((p) => p.status === 'alive')

    const dayMsg = eliminatedId
      ? `Day ${this.state.day}. ${eliminatedName} was killed last night. They were ${eliminatedRole}. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Dramatically announce the death, then facilitate the discussion. Then call start_voting when ready.`
      : doctorSaved
        ? `Day ${this.state.day}. The mafia struck last night, but the Doctor saved their target — nobody died. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Announce this, facilitate the discussion, then call start_voting.`
        : `Day ${this.state.day}. Nobody died last night. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Announce this, facilitate the discussion, then call start_voting.`

    this.log('GM', `Bridge alive: ${this.bridge?.isAlive() ?? false} — sending day prompt`)
    this.bridge?.sendText(`[SYSTEM] ${dayMsg}`)

    this.resetSilenceTimer()
    this.dayTimeout = setTimeout(() => {
      if (this.state.phase === 'day') this.startVoting()
    }, GAME_CONSTANTS.DAY_SPEECH_TIMEOUT)
  }

  private resetSilenceTimer() {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
    if (this.state.phase !== 'day') return
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      if (this.state.phase !== 'day') return
      const alivePlayers = this.state.players.filter((p) => p.status === 'alive').map((p) => p.name).join(', ')
      this.bridge?.sendText(
        `[SYSTEM] The room has gone silent. Drop a suspicion hint — point out something suspicious about one player's behavior (1 short sentence). Alive: ${alivePlayers}.`
      )
    }, 5_000)
  }

  startVoting() {
    if (this.dayTimeout) { clearTimeout(this.dayTimeout); this.dayTimeout = null }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
    this.resolving = false
    this.state.phase = 'voting'
    this.setAllVoiceAgentsMuted(false)
    this.votes.clear()

    const alivePlayers = this.state.players.filter((p) => p.status === 'alive')
    const aliveList = alivePlayers.map((p) => p.name).join(', ')
    const aliveHumans = alivePlayers.filter((p) => !this.isBot(p.name))
    this.broadcastEvent({ type: 'phase_changed', phase: 'voting', state: this.getPublicState() })

    // Narrator announces voting and solicits human players one by one
    const humanVoteOrder = aliveHumans.map((p) => p.name).join(', ')
    const humanSection = aliveHumans.length > 0
      ? `Go through each human player IN THIS ORDER: ${humanVoteOrder}. For each one, say their name and ask who they want to eliminate. Wait for their voice response, then call cast_vote with their answer. If they don't respond within 10 seconds, skip them (do NOT call cast_vote).`
      : `There are no human players to solicit.`
    this.log('GM', `Bridge alive: ${this.bridge?.isAlive() ?? false} — sending voting prompt`)
    this.bridge?.sendText(
      `[SYSTEM] Voting time! Alive players: ${aliveList}. Announce that voting begins (1-2 sentences). Then solicit HUMAN players only — bots will vote on their own. ${humanSection} After all humans have voted (or been skipped), announce the vote is closing.`
    )

    // Defer bot instructions + voting timer until narrator finishes speaking
    this.pendingPhaseTransition = () => {
      // Send direct voting instructions to each VoiceAgent
      this.voiceAgents.forEach((agent, agentName) => {
        const player = this.state.players.find((p) => p.name === agentName && p.status === 'alive')
        if (!player) return
        const targets = this.state.players
          .filter((p) => p.status === 'alive' && p.name !== agentName)
          .map((p) => p.name).join(', ')
        agent.sendContext(`[GAME] Voting phase: Call cast_vote now. Choose who to eliminate from: ${targets}.`)
      })

      // Bot voting retry at 10s
      setTimeout(() => {
        if (this.state.phase !== 'voting') return
        this.voiceAgents.forEach((agent, agentName) => {
          const player = this.state.players.find((p) => p.name === agentName && p.status === 'alive')
          if (!player || this.votes.has(player.id)) return
          const targets = this.state.players
            .filter((p) => p.status === 'alive' && p.name !== agentName)
            .map((p) => p.name).join(', ')
          agent.sendContext(`[GAME] URGENT: You MUST call cast_vote NOW. Pick one player to eliminate from: ${targets}. Do NOT speak, just call the function immediately.`)
        })
      }, 10_000)

      // Bot voting fallback at 20s
      setTimeout(() => {
        if (this.state.phase !== 'voting') return
        let fallbackTriggered = false
        this.voiceAgents.forEach((_agent, agentName) => {
          const player = this.state.players.find((p) => p.name === agentName && p.status === 'alive')
          if (!player || this.votes.has(player.id)) return
          const validTargets = this.state.players.filter((p) => p.status === 'alive' && p.id !== player.id)
          const randomTarget = validTargets[Math.floor(Math.random() * validTargets.length)]
          if (randomTarget) {
            this.votes.set(player.id, randomTarget.id)
            this.broadcastEvent({ type: 'vote_cast', fromId: player.id, targetId: randomTarget.id })
            fallbackTriggered = true
          }
        })
        if (fallbackTriggered) {
          const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
          if (this.votes.size >= eligibleVoters.length) this.resolveVotes()
        }
      }, 20_000)

      this.votingTimeout = setTimeout(() => this.resolveVotes(), GAME_CONSTANTS.VOTING_TIMEOUT)
    }

    // Safety fallback: if turnComplete never fires within 30s, start voting anyway
    setTimeout(() => {
      if (this.pendingPhaseTransition && this.state.phase === 'voting') {
        const fn = this.pendingPhaseTransition
        this.pendingPhaseTransition = null
        fn()
      }
    }, 30_000)
  }

  private resolveVotes() {
    if (this.resolving) return
    this.resolving = true
    if (this.votingTimeout) { clearTimeout(this.votingTimeout); this.votingTimeout = null }

    const voteCounts = new Map<string, number>()
    this.votes.forEach((targetId) => {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1)
    })

    let maxVotes = 0
    voteCounts.forEach((count) => { if (count > maxVotes) maxVotes = count })

    // Fix (from main): eliminatedId is null when nobody voted, not an empty string
    let eliminatedId: string | null = null
    if (maxVotes > 0) {
      const tiedPlayers: string[] = []
      voteCounts.forEach((count, playerId) => {
        if (count === maxVotes) tiedPlayers.push(playerId)
      })
      eliminatedId = tiedPlayers[Math.floor(Math.random() * tiedPlayers.length)]
    }

    const votesRecord: Record<string, string> = {}
    this.votes.forEach((target, from) => { votesRecord[from] = target })

    this.broadcastEvent({ type: 'vote_result', eliminatedId, votes: votesRecord })

    if (eliminatedId) this.eliminatePlayer(eliminatedId)

    if (this.state.phase !== 'game_over') {
      const eliminatedPlayer = eliminatedId ? this.state.players.find((p) => p.id === eliminatedId) : null
      this.bridge?.sendText(
        eliminatedPlayer
          ? `[SYSTEM] ${eliminatedPlayer.name} was eliminated. They were ${eliminatedPlayer.role}. Announce this dramatically (2-3 sentences), then stop.`
          : `[SYSTEM] No one was eliminated. Announce this briefly, then stop.`
      )

      if (this.bridge) {
        this.bridge.afterNarratorFinishes(() => this.afterAnyVoiceAgentStops(() => {
          if (this.state.phase !== 'game_over') this.startNight()
        }))
      } else {
        setTimeout(() => this.afterAnyVoiceAgentStops(() => {
          if (this.state.phase !== 'game_over') this.startNight()
        }), GAME_CONSTANTS.ROLE_REVEAL_DELAY)
      }

      // Safety fallback — only fire if startNight hasn't run yet (phase still !== 'night')
      setTimeout(() => {
        if (this.pendingPhaseTransition && this.state.phase !== 'game_over' && this.state.phase !== 'night') {
          this.pendingPhaseTransition = null
          this.startNight()
        }
      }, 15_000)
    }
  }

  castVote(fromId: string, targetId: string) {
    if (this.state.phase !== 'voting') return
    const from = this.state.players.find((p) => p.id === fromId)
    const target = this.state.players.find((p) => p.id === targetId && p.status === 'alive')
    if (!from || !target || from.status !== 'alive' || from.id === target.id) return

    this.votes.set(fromId, targetId)
    this.broadcastEvent({ type: 'vote_cast', fromId, targetId })
    const alive = this.state.players.filter((p) => p.status === 'alive')
    if (this.votes.size >= alive.length) this.resolveVotes()
  }

  handleFaceMetrics(playerId: string, metrics: { stress: number; surprise: number; happiness: number; lookingAway: boolean }) {
    if (this.state.phase !== 'day' && this.state.phase !== 'voting') return
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return
    const isNoteworthy = metrics.stress > 0.2 || metrics.surprise > 0.3 || metrics.lookingAway || metrics.happiness > 0.4
    if (!isNoteworthy) return
    const now = Date.now()
    const lastSent = this.faceMetricsCooldowns.get(playerId) ?? 0
    if (now - lastSent < 20_000) return
    this.faceMetricsCooldowns.set(playerId, now)
    const observations: string[] = []
    if (metrics.stress > 0.2) observations.push(`stress level ${(metrics.stress * 100).toFixed(0)}%`)
    if (metrics.surprise > 0.6) observations.push(`surprised expression ${(metrics.surprise * 100).toFixed(0)}%`)
    if (metrics.lookingAway) observations.push('looking away from camera')
    if (metrics.happiness > 0.4) observations.push(`smiling ${(metrics.happiness * 100).toFixed(0)}%`)
    if (metrics.happiness > 0.4 && metrics.stress > 0.2) observations.push('possible nervous smile')
    if (observations.length === 0) return
    this.bridge?.sendText(
      `[FACE_ANALYSIS] ${player.name} shows: ${observations.join(', ')}. You may briefly comment on this if relevant to the discussion.`
    )
    this.broadcastEvent({ type: 'behavioral_note', playerName: player.name, note: observations.join(', ') })
    if (metrics.stress > 0.2) {
      this.broadcastEvent({ type: 'stress_alert', playerId, playerName: player.name, level: metrics.stress })
    }
  }

  sendPlayerAudio(_chunk: Buffer) {
    // No-op: AgentBridge handles audio via Fishjam SFU
  }

  private eliminatePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player) return
    player.status = 'dead'

    // Silence and disconnect the voice agent if this player was one
    const voiceAgent = this.voiceAgents.get(player.name)
    if (voiceAgent) {
      voiceAgent.setMuteInput(true)
      voiceAgent.setMuteOutput(true)
      voiceAgent.disconnect()
      this.voiceAgents.delete(player.name)
      this.selectedAgentNames.delete(player.name)
      this.speakingVoiceAgents.delete(player.name)
      // Restart chain so eliminated agent is removed from rotation
      if (this.agentChainActive && !this.agentsManuallyMuted) {
        this.startAgentOutputChain()
      }
      this.broadcastEvent({ type: 'speaker_changed', speakerId: null })
    }

    this.broadcastEvent({ type: 'player_eliminated', playerId, role: player.role })
    this.checkWinCondition()
  }

  private checkWinCondition() {
    const alive = this.state.players.filter((p) => p.status === 'alive')
    const mafiaAlive = alive.filter((p) => p.role === 'mafia').length
    const civiliansAlive = alive.length - mafiaAlive
    if (mafiaAlive === 0) this.endGame('civilians')
    else if (mafiaAlive >= civiliansAlive) this.endGame('mafia')
  }

  private endGame(winner: 'mafia' | 'civilians') {
    this.state.winner = winner
    this.state.phase = 'game_over'
    this.log('phase', `========== GAME OVER: ${winner} win ==========`)
    this.broadcastEvent({ type: 'game_over', winner, state: this.state })
    this.bridge?.sendText(
      `[SYSTEM] Game over! ${winner} won! Roles: ${this.state.players.map((p) => `${p.name}=${p.role}`).join(', ')}. Announce dramatically.`
    )
    this.bridge?.afterNarratorFinishes(() => this.cleanup())
  }

  cleanup() {
    this.bridge?.disconnect()
    this.bridge = null
    this.voiceAgents.forEach((agent) => agent.disconnect())
    this.voiceAgents.clear()
    if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
    if (this.dayTimeout) { clearTimeout(this.dayTimeout); this.dayTimeout = null }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
    if (this.votingTimeout) { clearTimeout(this.votingTimeout); this.votingTimeout = null }
    if (this.voiceFallbackTimeout) { clearTimeout(this.voiceFallbackTimeout); this.voiceFallbackTimeout = null }
  }

  allDisconnected(): boolean { return this.clients.size === 0 }

  broadcastEvent(event: ServerEvent) {
    this.clients.forEach((ws) => ws.send(JSON.stringify(event)))
  }

  broadcastBinary(data: Buffer) {
    this.clients.forEach((ws) => ws.send(data))
  }

  sendToPlayer(playerId: string, event: ServerEvent) {
    const ws = this.clients.get(playerId)
    if (ws) ws.send(JSON.stringify(event))
  }

  getPublicState(): GameState {
    const voiceAgentIds = [...this.voiceAgents.keys()]
      .map((name) => this.state.players.find((p) => p.name === name)?.id)
      .filter((id): id is string => !!id)

    const activeVoiceAgentId = this.activeVoiceAgentName
      ? (this.state.players.find((p) => p.name === this.activeVoiceAgentName)?.id ?? null)
      : null

    const lockedPhase = this.state.phase === 'night' || this.state.phase === 'role_assignment'
    return {
      ...this.state,
      // Fix (from main): reveal role only for dead players — alive players show as 'civilian'
      players: this.state.players.map((p) => ({
        ...p,
        role: p.status === 'dead' ? p.role : 'civilian' as Role,
      })),
      voiceAgentIds,
      activeVoiceAgentId,
      agentsMuted: lockedPhase || this.agentsManuallyMuted,
      selectedAgentIds: this.getSelectedAgentIds(),
    }
  }
}
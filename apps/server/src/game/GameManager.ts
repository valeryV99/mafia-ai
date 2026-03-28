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

  // Bot state (from main)
  private botNames: Set<string> = new Set()
  private mafiaVotes: Map<string, string> = new Map()
  private detectiveTarget: string | null = null
  private doctorTarget: string | null = null
  // Fix: nightActions used in main's logNightProgress / handleVoiceFallback
  private nightActions: Map<string, string> = new Map()

  // Timing helpers (from main)
  private dayStartedAt: number = 0
  private voiceFallbackTimeout: ReturnType<typeof setTimeout> | null = null
  private geminiTranscriptBuffer = ''
  private geminiTranscriptTimer: ReturnType<typeof setTimeout> | null = null

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
      persona: 'The Hothead — aggressive and impulsive, quick to accuse, loud and dominant. Speaks fast and interrupts. Uses phrases like "obviously it\'s you!" and "stop making excuses".',
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
    this.log('addBot', `Bot "${name}" (${id}) added. Total: ${this.state.players.length}`)
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
          this.speakingVoiceAgents.delete(player.name)
          if (this.speakingVoiceAgents.size === 0 && this.pendingAfterSpeech) {
            const fn = this.pendingAfterSpeech
            this.pendingAfterSpeech = null
            fn()
          }
        }
        this.broadcastEvent({ type: 'speaker_changed', speakerId: speaking ? player.id : null })
      }
    )

    this.voiceAgents.set(name, agent)
    this.broadcastEvent({
      type: 'phase_changed',
      phase: this.state.phase,
      state: this.getPublicState(),
    })

    this.log('voiceAgent', `${name} joined as ${player.role}`)
    return { ok: true, player }
  }

  setActiveVoiceAgent(agentId: string | null) {
    const agentName = agentId
      ? this.state.players.find((p) => p.id === agentId)?.name ?? null
      : null

    this.activeVoiceAgentName = agentName

    // Mute all voice agents except the active one (both input and output)
    this.voiceAgents.forEach((agent, name) => {
      const isMuted = name !== agentName
      agent.setMuteInput(isMuted)
      agent.setMuteOutput(isMuted)
    })

    this.log('voiceAgent', `Active agent: ${agentName ?? 'none'}`)
    this.broadcastEvent({ type: 'agent_mute_changed', activeAgentId: agentId })
    // Clear any speaking indicator immediately — muted agents must not show as speaking
    this.broadcastEvent({ type: 'speaker_changed', speakerId: null })
  }

  removePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (player) {
      player.isConnected = false
      this.log('removePlayer', `${player.name} disconnected`)
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
    this.assignRoles()
    this.state.phase = 'role_assignment'
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
    this.log('timing', `startGame: initGemini launched, waiting for bridge before startNight`)
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
    this.log('peer', `Mapped ${peerId.slice(0, 8)} → "${playerName}"`)
    this.fishjamPeerNames.set(peerId, playerName)
    this.bridge?.allowPeer(peerId)
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
    ]

    this.bridge = new AgentBridge(fishjamId, managementToken, apiKey, 'GameMaster')

    // Register already-known human peers
    for (const peerId of this.fishjamPeerNames.keys()) {
      this.bridge.allowPeer(peerId)
    }

    this.bridge.on({
      onGeminiAudio: (audio) => {
        this.broadcastBinary(audio)
      },

      onTranscript: (speaker, text, speakerId) => {
        const playerName = speakerId ? this.fishjamPeerNames.get(speakerId) : undefined
        this.broadcastEvent({ type: 'transcript', speaker, text, playerName })

        if (speaker === 'player' && playerName) {
          const player = this.state.players.find((p) => p.name === playerName)
          if (player) this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
          this.handleVoiceFallback(text)
        }

        if (speaker === 'gemini') {
          this.handleGeminiTranscriptFallback(text)
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

      onToolCall: (name, args) => {
        this.handleGeminiCommand({ action: name, ...args } as any)
      },
    })

    this.log('timing', `initGemini START at ${Date.now()}`)
    await this.bridge.start(this.fishjamRoomId, prompt, tools, 'Orus', false)
    this.log('timing', `Bridge READY at ${Date.now()} — Game Master connected and audible`)

    setTimeout(() => this.startNight(), GAME_CONSTANTS.ROLE_REVEAL_DELAY)
  }

  handleNightAction(playerId: string, targetId: string) {
    if (this.state.phase !== 'night') return
    const player = this.state.players.find((p) => p.id === playerId && p.status === 'alive')
    const target = this.state.players.find((p) => p.id === targetId && p.status === 'alive')
    if (!player || !target || player.id === target.id) return

    if (player.role === 'mafia') {
      this.mafiaVotes.set(playerId, targetId)
      this.log('night', `${player.name} UI → kill → ${target.name}`)
      // When all human mafia have voted, give 5s grace period for detective/doctor to act
      const humanMafia = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive' && !this.isBot(p.name))
      if (humanMafia.every((p) => this.mafiaVotes.has(p.id)) && !this.mafiaGraceTimer) {
        this.log('night', 'All human mafia voted — 5s grace period for detective/doctor')
        this.mafiaGraceTimer = setTimeout(() => {
          this.mafiaGraceTimer = null
          if (this.state.phase === 'night') {
            this.log('night', 'Grace period expired → resolveNight()')
            if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
            this.resolveNight()
          }
        }, 5000)
      }
    } else if (player.role === 'detective' && this.detectiveTarget === null) {
      this.detectiveTarget = targetId
      this.log('night', `${player.name} UI → investigate → ${target.name}`)
    } else if (player.role === 'doctor' && this.doctorTarget === null) {
      this.doctorTarget = targetId
      this.log('night', `${player.name} UI → save → ${target.name}`)
    }

    this.checkAllNightActionsComplete()
  }

  private checkAllNightActionsComplete() {
    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
    const detectiveAlive = this.state.players.some((p) => p.role === 'detective' && p.status === 'alive')
    const doctorAlive = this.state.players.some((p) => p.role === 'doctor' && p.status === 'alive')

    // Only require HUMAN mafia to have voted — bots vote as a bonus if they respond in time
    const humanMafia = mafiaPlayers.filter((p) => !this.isBot(p.name))
    const mafiaActed = mafiaPlayers.length === 0
      || (humanMafia.length === 0 ? this.mafiaVotes.size > 0 : humanMafia.every((p) => this.mafiaVotes.has(p.id)))
    const detectiveActed = this.detectiveTarget !== null || !detectiveAlive
    const doctorActed = this.doctorTarget !== null || !doctorAlive

    this.log('night', `checkAllNightActionsComplete: mafia=${mafiaActed}(${this.mafiaVotes.size}/${mafiaPlayers.length}) detective=${detectiveActed} doctor=${doctorActed}`)

    if (mafiaActed && detectiveActed && doctorActed) {
      this.log('night', 'All roles acted → resolveNight()')
      if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
      this.resolveNight()
    }
  }

  private logNightProgress() {
    const nightActors = this.state.players.filter(
      (p) => p.status === 'alive' && (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
    )
    const acted = nightActors.filter((p) => this.nightActions.has(p.id))
    this.log('night', `Actions: ${acted.length}/${nightActors.length} (${acted.map((p) => p.role).join(', ')} done)`)

    // When all actions done, auto-resolve after 3 seconds
    if (acted.length === nightActors.length) {
      this.log('night', 'All night actors done — auto-resolve in 3 seconds')
      setTimeout(() => {
        if (this.state.phase === 'night') {
          this.log('night', 'Auto-resolving night')
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
        this.log('night', `${voter.name} → kill → ${target.name}`)
        this.mafiaVotes.set(voter.id, target.id)
        // Notify narrator when a bot acts so it can continue narrating
        if (this.isBot(voter.name)) {
          const remainingMafia = this.state.players.filter(
            (p) => p.role === 'mafia' && p.status === 'alive' && !this.mafiaVotes.has(p.id)
          )
          if (remainingMafia.length === 0) {
            this.bridge?.sendSilentContext(`[SYSTEM] All mafia bots have chosen their target. Say "The mafia has chosen." and move to Detective.`)
          }
        }
        this.checkAllNightActionsComplete()
        break
      }

      case 'investigate': {
        if (this.state.phase !== 'night' || this.detectiveTarget !== null) break
        const target = findAliveByName(cmd.target)
        if (!target) break
        this.log('night', `Detective → investigate → ${target.name}`)
        this.detectiveTarget = target.id
        // Notify narrator when a bot detective acts
        if (this.isBot(cmd.voter || '')) {
          this.bridge?.sendSilentContext(`[SYSTEM] Bot Detective has investigated. Say "The Detective has seen enough." and move to Doctor.`)
        }
        this.checkAllNightActionsComplete()
        break
      }

      case 'doctor_save': {
        if (this.state.phase !== 'night' || this.doctorTarget !== null) break
        const target = findAliveByName(cmd.target)
        if (!target) break
        this.log('night', `Doctor → save → ${target.name}`)
        this.doctorTarget = target.id
        // Notify narrator when a bot doctor acts
        if (this.isBot(cmd.voter || '')) {
          this.bridge?.sendSilentContext(`[SYSTEM] Bot Doctor has acted. All roles have had their turn — call resolve_night now.`)
        }
        this.checkAllNightActionsComplete()
        break
      }

      case 'resolve_night': {
        if (this.state.phase !== 'night') break
        this.log('night', 'resolve_night called by Gemini')
        if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
        this.resolveNight()
        break
      }

      case 'start_voting': {
        if (this.state.phase !== 'day') break
        this.log('command', 'start_voting by Gemini')
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
        this.log('command', `vote: ${voter.name} → ${target.name}`)
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

      default:
        this.log('command', `Unknown: ${cmd.action}`)
    }
  }

  private handleVoiceFallback(text: string) {
    const lower = text.toLowerCase()
    const allPlayers = this.state.players
    const mentioned = allPlayers.find((p) => lower.includes(p.name.toLowerCase()))
    if (!mentioned) return

    this.log('voiceFallback', `Heard player name "${mentioned.name}" in "${text}" (phase: ${this.state.phase}, alive: ${mentioned.status === 'alive'})`)

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
      if (humanNightActors.length > 0) {
        const actor = humanNightActors[0]
        if (this.voiceFallbackTimeout) clearTimeout(this.voiceFallbackTimeout)
        this.voiceFallbackTimeout = setTimeout(() => {
          if (hasActed(actor)) return
          this.log('voiceFallback', `${actor.name} (${actor.role}) said "${text}" → target: ${mentioned.name}`)
          if (actor.role === 'mafia') this.mafiaVotes.set(actor.id, mentioned.id)
          else if (actor.role === 'detective') this.detectiveTarget = mentioned.id
          else if (actor.role === 'doctor') this.doctorTarget = mentioned.id
          this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `Your choice: ${mentioned.name}. Confirmed.` })
          this.bridge?.sendText(`[SYSTEM] ${actor.role} action received: target is ${mentioned.name}. Move to the next role or call resolve_night if all done.`)
          this.checkAllNightActionsComplete()
        }, 2000)
      }
    }

    if (this.state.phase === 'voting' && mentioned.status === 'alive') {
      const humanVoters = this.state.players.filter(
        (p) => p.status === 'alive' && !this.isBot(p.name) && !this.votes.has(p.id)
      )
      if (humanVoters.length > 0) {
        const voter = humanVoters[0]
        if (voter.id === mentioned.id) return
        if (this.voiceFallbackTimeout) clearTimeout(this.voiceFallbackTimeout)
        this.voiceFallbackTimeout = setTimeout(() => {
          if (this.votes.has(voter.id)) return
          this.log('voiceFallback', `${voter.name} vote: "${text}" → ${mentioned.name}`)
          this.votes.set(voter.id, mentioned.id)
          this.broadcastEvent({ type: 'vote_cast', fromId: voter.id, targetId: mentioned.id })
          this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${voter.name} votes for ${mentioned.name}.` })
          const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
          if (this.votes.size >= eligibleVoters.length) this.resolveVotes()
        }, 1500)
      }
    }
  }

  private handleGeminiTranscriptFallback(text: string) {
    this.geminiTranscriptBuffer += ' ' + text
    if (this.geminiTranscriptTimer) clearTimeout(this.geminiTranscriptTimer)

    this.geminiTranscriptTimer = setTimeout(() => {
      const buf = this.geminiTranscriptBuffer.toLowerCase()
      this.geminiTranscriptBuffer = ''

      const alivePlayers = this.state.players.filter((p) => p.status === 'alive')
      const mentionedPlayer = alivePlayers.find((p) => buf.includes(p.name.toLowerCase()))

      if (this.state.phase === 'night') {
        const hasKill = buf.includes('night_kill') || buf.includes('nightly_kill') || buf.includes('night kill')
          || (buf.includes('mafia') && buf.includes('chosen'))
        const hasInvestigate = buf.includes('investigate')
        const hasDoctor = buf.includes('doctor_save') || buf.includes('doctor save')
        const hasResolve = buf.includes('resolve_night') || buf.includes('resolve night')
          || (buf.includes('sun') && buf.includes('rise'))

        if (hasKill && mentionedPlayer) {
          const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
          for (const m of mafiaPlayers) {
            if (!this.nightActions.has(m.id)) {
              this.log('transcriptFallback', `night_kill detected: ${mentionedPlayer.name}`)
              this.nightActions.set(m.id, mentionedPlayer.id)
            }
          }
          this.logNightProgress()
        }

        if (hasInvestigate && mentionedPlayer) {
          const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
          if (detective && !this.nightActions.has(detective.id)) {
            this.log('transcriptFallback', `investigate detected: ${mentionedPlayer.name}`)
            this.nightActions.set(detective.id, mentionedPlayer.id)
            this.sendToPlayer(detective.id, {
              type: 'investigation_result',
              targetName: mentionedPlayer.name,
              targetRole: mentionedPlayer.role,
            })
            this.logNightProgress()
          }
        }

        if (hasDoctor && mentionedPlayer) {
          const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')
          if (doctor && !this.nightActions.has(doctor.id)) {
            this.log('transcriptFallback', `doctor_save detected: ${mentionedPlayer.name}`)
            this.nightActions.set(doctor.id, mentionedPlayer.id)
            this.logNightProgress()
          }
        }

        if (hasResolve) {
          this.log('transcriptFallback', 'resolve_night detected from speech')
          if (this.state.phase === 'night') this.resolveNight()
        }
      }

      if (this.state.phase === 'day') {
        const hasStartVoting = buf.includes('start_voting') || buf.includes('start voting')
          || buf.includes('time to vote') || buf.includes('must vote') || buf.includes('cast your vote')
        if (hasStartVoting) {
          this.log('transcriptFallback', 'start_voting detected from speech')
          const dayElapsed = Date.now() - this.dayStartedAt
          if (dayElapsed >= GAME_CONSTANTS.DAY_MIN_DURATION) {
            this.startVoting()
          }
        }
      }

      if (this.state.phase === 'voting' && mentionedPlayer) {
        const hasCastVote = buf.includes('cast_vote') || buf.includes('cast vote')
          || buf.includes('vote for') || buf.includes('votes for') || buf.includes('i vote')
        if (hasCastVote) {
          for (const bot of this.state.players.filter((p) => this.isBot(p.name) && p.status === 'alive' && !this.votes.has(p.id))) {
            if (buf.includes(bot.name.toLowerCase())) {
              this.log('transcriptFallback', `vote detected: ${bot.name} → ${mentionedPlayer.name}`)
              this.votes.set(bot.id, mentionedPlayer.id)
              this.broadcastEvent({ type: 'vote_cast', fromId: bot.id, targetId: mentionedPlayer.id })
              const alive = this.state.players.filter((p) => p.status === 'alive')
              if (this.votes.size >= alive.length) this.resolveVotes()
              break
            }
          }
        }
      }
    }, 1500)
  }

  // Handle text commands from player (typing fallback)
  handleTextCommand(playerId: string, text: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return

    this.log('textCommand', `${player.name}: "${text}"`)

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
        this.log('textCommand', `Night action: ${player.name} (${player.role}) → ${mentioned.name}`)
        this.bridge?.sendText(`[SYSTEM] ${player.role} action received: target is ${mentioned.name}.`)
        this.logNightProgress()
      }
    } else if (this.state.phase === 'voting' && !this.votes.has(player.id)) {
      this.votes.set(player.id, mentioned.id)
      this.broadcastEvent({ type: 'vote_cast', fromId: player.id, targetId: mentioned.id })
      this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${player.name} votes for ${mentioned.name}.` })
      this.log('textCommand', `Vote: ${player.name} → ${mentioned.name}`)
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
    this.log('phase', `→ NIGHT ${this.state.day}`)
    this.state.phase = 'night'
    this.broadcastEvent({ type: 'phase_changed', phase: 'night', state: this.getPublicState() })

    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
    const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
    const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')

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
      `1. Narrate the night atmosphere only (2-3 dramatic sentences). Do NOT call out any roles.\n` +
      `2. Then go silent. The server manages all role actions.\n` +
      `3. For each HUMAN role: listen — when they say a name, IMMEDIATELY call the matching function (night_kill / investigate / doctor_save).\n` +
      `4. For each BOT role: do NOT call any functions — you will receive a [SYSTEM] notification when the bot has acted.\n` +
      `5. When you receive [SYSTEM] that all roles are done → call resolve_night immediately.\n\n` +
      `CRITICAL: When a human says a name like "I choose Bruno" — call the function right away. Do not just acknowledge verbally.`
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

    // Bot fallback: if a bot detective/doctor doesn't call their function within 12s,
    // auto-assign a random target so the night doesn't stall waiting for slow Gemini responses
    setTimeout(() => {
      if (this.state.phase !== 'night') return
      const alivePlayers = this.state.players.filter((p) => p.status === 'alive')
      const botDetective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive' && this.isBot(p.name))
      if (botDetective && this.detectiveTarget === null) {
        const randomTarget = alivePlayers.find((p) => p.id !== botDetective.id)
        if (randomTarget) {
          this.log('night', `Bot detective fallback — auto-assigning target: ${randomTarget.name}`)
          this.detectiveTarget = randomTarget.id
          this.checkAllNightActionsComplete()
        }
      }
      const botDoctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive' && this.isBot(p.name))
      if (botDoctor && this.doctorTarget === null) {
        const randomTarget = alivePlayers.find((p) => p.id !== botDoctor.id)
        if (randomTarget) {
          this.log('night', `Bot doctor fallback — auto-assigning target: ${randomTarget.name}`)
          this.doctorTarget = randomTarget.id
          this.checkAllNightActionsComplete()
        }
      }
    }, 12_000)

    // When narrator finishes → start night timer (so client and server timers are in sync)
    this.pendingPhaseTransition = () => {
      this.log('timer', `Night timer starts: ${GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT / 1000}s`)
      this.nightTimeout = setTimeout(() => {
        this.log('timer', 'Night timeout → resolveNight()')
        this.resolveNight()
      }, GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT)
    }

    // Safety fallback: if turnComplete never fires within 30s, start timer anyway
    setTimeout(() => {
      if (this.pendingPhaseTransition) {
        this.pendingPhaseTransition = null
        if (!this.nightTimeout) {
          this.log('timer', 'Night safety fallback: starting timer without turnComplete')
          this.nightTimeout = setTimeout(() => this.resolveNight(), GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT)
        }
      }
    }, 30_000)
  }

  private resolveNight() {
    if (this.resolving) return
    this.resolving = true
    if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
    if (this.mafiaGraceTimer) { clearTimeout(this.mafiaGraceTimer); this.mafiaGraceTimer = null }

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
        this.sendToPlayer(detective.id, {
          type: 'investigation_result',
          targetName: target.name,
          targetRole: target.role,
        })
        this.log('night', `Detective result: ${target.name} is ${target.role}`)
      }
    }

    // 4. Apply kill and check win condition
    if (killedId) {
      this.eliminatePlayer(killedId)
    }

    this.log('night', `resolveNight: killed=${killedId ? this.state.players.find(p => p.id === killedId)?.name : 'none'}, doctorSaved=${doctorSaved}`)

    // 5. Reset night action storage
    this.mafiaVotes.clear()
    this.detectiveTarget = null
    this.doctorTarget = null

    // 6. Transition — wait for narrator AND any speaking voice agent before startDay
    this.log('timing', `resolveNight done at ${Date.now()} — awaiting narrator before startDay`)
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
    this.log('phase', `→ DAY ${this.state.day}`)
    const eliminatedName = eliminatedId
      ? this.state.players.find((p) => p.id === eliminatedId)?.name
      : null
    const eliminatedRole = eliminatedId
      ? this.state.players.find((p) => p.id === eliminatedId)?.role
      : null

    this.state.phase = 'day'
    this.state.day++
    this.broadcastEvent({ type: 'phase_changed', phase: 'day', state: this.getPublicState() })

    const alivePlayers = this.state.players.filter((p) => p.status === 'alive')

    const dayMsg = eliminatedId
      ? `Day ${this.state.day}. ${eliminatedName} was killed last night. They were ${eliminatedRole}. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Dramatically announce the death, then facilitate the discussion. Then call start_voting when ready.`
      : doctorSaved
        ? `Day ${this.state.day}. The mafia struck last night, but the Doctor saved their target — nobody died. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Announce this, facilitate the discussion, then call start_voting.`
        : `Day ${this.state.day}. Nobody died last night. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Announce this, facilitate the discussion, then call start_voting.`

    this.bridge?.sendText(`[SYSTEM] ${dayMsg}`)

    this.log('timer', `Day timeout starts: ${GAME_CONSTANTS.DAY_SPEECH_TIMEOUT / 1000}s`)
    this.dayTimeout = setTimeout(() => {
      if (this.state.phase === 'day') {
        this.log('timer', 'Day timeout fired → startVoting()')
        this.startVoting()
      }
    }, GAME_CONSTANTS.DAY_SPEECH_TIMEOUT)
  }

  startVoting() {
    if (this.dayTimeout) { clearTimeout(this.dayTimeout); this.dayTimeout = null }
    this.resolving = false
    this.log('phase', `→ VOTING`)
    this.state.phase = 'voting'
    this.votes.clear()

    const aliveList = this.state.players.filter((p) => p.status === 'alive').map((p) => p.name).join(', ')
    this.broadcastEvent({ type: 'phase_changed', phase: 'voting', state: this.getPublicState() })

    this.bridge?.sendText(
      `[SYSTEM] Voting time! Alive: ${aliveList}. Announce voting starts (2-3 sentences). Call each player by name, ask who to eliminate, then call cast_vote for their answer.`
    )

    // Send direct voting instructions to each VoiceAgent
    this.voiceAgents.forEach((agent, agentName) => {
      const player = this.state.players.find((p) => p.name === agentName && p.status === 'alive')
      if (!player) return
      const targets = this.state.players
        .filter((p) => p.status === 'alive' && p.name !== agentName)
        .map((p) => p.name).join(', ')
      agent.sendContext(`[GAME] Voting phase: Call cast_vote now. Choose who to eliminate from: ${targets}.`)
    })

    this.log('timer', `Voting timeout starts: ${GAME_CONSTANTS.VOTING_TIMEOUT / 1000}s`)
    this.votingTimeout = setTimeout(() => {
      this.log('timer', 'Voting timeout fired → resolveVotes()')
      this.resolveVotes()
    }, GAME_CONSTANTS.VOTING_TIMEOUT)
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

    const votesSummary = Array.from(this.votes.entries())
      .map(([f, t]) => `${this.state.players.find((p) => p.id === f)?.name} → ${this.state.players.find((p) => p.id === t)?.name}`)
      .join(', ')
    const eliminatedName = eliminatedId ? this.state.players.find((p) => p.id === eliminatedId)?.name : 'nobody'
    this.log('resolveVotes', `[${votesSummary}] → eliminated: ${eliminatedName}`)

    this.broadcastEvent({ type: 'vote_result', eliminatedId, votes: votesRecord })

    if (eliminatedId) this.eliminatePlayer(eliminatedId)

    if (this.state.phase !== 'game_over') {
      const eliminatedPlayer = eliminatedId ? this.state.players.find((p) => p.id === eliminatedId) : null
      this.bridge?.sendText(
        eliminatedPlayer
          ? `[SYSTEM] ${eliminatedPlayer.name} was eliminated. They were ${eliminatedPlayer.role}. Announce this dramatically (2-3 sentences), then stop.`
          : `[SYSTEM] No one was eliminated. Announce this briefly, then stop.`
      )

      this.log('timing', `resolveVoting done at ${Date.now()} — awaiting turnComplete before startNight`)
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

    this.log('vote:manual', `${from.name} → ${target.name}`)
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

    const observations: string[] = []
    if (metrics.stress > 0.2) observations.push(`stress level ${(metrics.stress * 100).toFixed(0)}%`)
    if (metrics.surprise > 0.6) observations.push(`surprised expression ${(metrics.surprise * 100).toFixed(0)}%`)
    if (metrics.lookingAway) observations.push('looking away from camera')
    if (metrics.happiness > 0.4) observations.push(`smiling ${(metrics.happiness * 100).toFixed(0)}%`)
    if (metrics.happiness > 0.4 && metrics.stress > 0.2) observations.push('possible nervous smile')

    this.log('face', `${player.name}: ${observations.join(', ')}`)
  }

  sendPlayerAudio(_chunk: Buffer) {
    // No-op: AgentBridge handles audio via Fishjam SFU
  }

  private eliminatePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player) return
    player.status = 'dead'
    this.log('eliminate', `${player.name} (${player.role}) eliminated!`)

    // Silence and disconnect the voice agent if this player was one
    const voiceAgent = this.voiceAgents.get(player.name)
    if (voiceAgent) {
      voiceAgent.setMuteInput(true)
      voiceAgent.setMuteOutput(true)
      voiceAgent.disconnect()
      this.voiceAgents.delete(player.name)
      this.speakingVoiceAgents.delete(player.name)
      this.broadcastEvent({ type: 'speaker_changed', speakerId: null })
      this.log('eliminate', `Voice agent ${player.name} disconnected`)
    }

    this.broadcastEvent({ type: 'player_eliminated', playerId, role: player.role })
    this.checkWinCondition()
  }

  private checkWinCondition() {
    const alive = this.state.players.filter((p) => p.status === 'alive')
    const mafiaAlive = alive.filter((p) => p.role === 'mafia').length
    const civiliansAlive = alive.length - mafiaAlive
    this.log('winCheck', `Alive: ${alive.length} (mafia: ${mafiaAlive}, civilians: ${civiliansAlive})`)
    if (mafiaAlive === 0) this.endGame('civilians')
    else if (mafiaAlive >= civiliansAlive) this.endGame('mafia')
  }

  private endGame(winner: 'mafia' | 'civilians') {
    this.state.winner = winner
    this.state.phase = 'game_over'
    this.log('phase', `→ GAME OVER! Winner: ${winner}`)
    this.broadcastEvent({ type: 'game_over', winner, state: this.state })
    this.bridge?.sendText(
      `[SYSTEM] Game over! ${winner} won! Roles: ${this.state.players.map((p) => `${p.name}=${p.role}`).join(', ')}. Announce dramatically.`
    )
    this.cleanup()
  }

  cleanup() {
    this.bridge?.disconnect()
    this.bridge = null
    this.voiceAgents.forEach((agent) => agent.disconnect())
    this.voiceAgents.clear()
    if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
    if (this.dayTimeout) { clearTimeout(this.dayTimeout); this.dayTimeout = null }
    if (this.votingTimeout) { clearTimeout(this.votingTimeout); this.votingTimeout = null }
    if (this.voiceFallbackTimeout) { clearTimeout(this.voiceFallbackTimeout); this.voiceFallbackTimeout = null }
    if (this.geminiTranscriptTimer) { clearTimeout(this.geminiTranscriptTimer); this.geminiTranscriptTimer = null }
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

    return {
      ...this.state,
      // Fix (from main): reveal role only for dead players — alive players show as 'civilian'
      players: this.state.players.map((p) => ({
        ...p,
        role: p.status === 'dead' ? p.role : 'civilian' as Role,
      })),
      voiceAgentIds,
      activeVoiceAgentId,
    }
  }
}
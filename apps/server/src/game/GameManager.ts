import type { GameState, Player, Phase, Role, ServerEvent } from '@mafia-ai/types'
import type { ServerWebSocket } from 'bun'
import { AgentBridge } from '../fishjam/AgentBridge'
import { buildGameMasterPrompt } from '../gemini/prompts'
import { GAME_CONSTANTS } from './constants'
import { BotAgent } from './BotAgent'
import {VoiceAgent} from "./VoiceAgent";

const log = (roomId: string, tag: string, ...args: unknown[]) =>
  console.log(`[Game:${roomId}][${tag}]`, ...args)

export class GameManager {
  private state: GameState
  private clients: Map<string, ServerWebSocket<{ playerId: string }>>
  private votes: Map<string, string> = new Map()
  private nightActions: Map<string, string> = new Map()
  private bridge: AgentBridge | null = null
  private fishjamRoomId: string | null = null
  private nightTimeout: ReturnType<typeof setTimeout> | null = null
  private dayTimeout: ReturnType<typeof setTimeout> | null = null
  private votingTimeout: ReturnType<typeof setTimeout> | null = null
  private resolving = false
  private botNames: Set<string> = new Set()
  private botAgents: Map<string, BotAgent> = new Map()
  private dayStartedAt = 0
  private fishjamPeerNames: Map<string, string> = new Map()

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

  get phase() {
    return this.state.phase
  }

  get players() {
    return this.state.players
  }

  get roomId() {
    return this.state.roomId
  }

  get connectedCount() {
    return this.clients.size
  }

  addPlayer(ws: ServerWebSocket<{ playerId: string }>, id: string, name: string): Player {
    // Already connected with same name — update ws and id
    const alreadyConnected = this.state.players.find((p) => p.name === name && p.isConnected)
    if (alreadyConnected) {
      this.log('addPlayer', `${name} duplicate join, updating connection (was ${alreadyConnected.id}, now ${id})`)
      this.clients.delete(alreadyConnected.id)
      alreadyConnected.id = id
      this.clients.set(id, ws)
      return alreadyConnected
    }

    // Reconnect existing disconnected player with same name
    const existing = this.state.players.find((p) => p.name === name && !p.isConnected)
    if (existing) {
      this.log('addPlayer', `${name} reconnected (was ${existing.id}, now ${id})`)
      this.clients.delete(existing.id)
      existing.id = id
      existing.isConnected = true
      this.clients.set(id, ws)
      return existing
    }

    const player: Player = {
      id,
      name,
      role: 'civilian',
      status: 'alive',
      isConnected: true,
    }
    this.state.players.push(player)
    this.clients.set(id, ws)
    this.log('addPlayer', `${name} (${id}) joined. Total: ${this.state.players.length}`)
    return player
  }

  addBot(name: string): Player {
    const id = `bot-${crypto.randomUUID().slice(0, 8)}`
    const player: Player = {
      id,
      name,
      role: 'civilian',
      status: 'alive',
      isConnected: true,
    }
    this.state.players.push(player)
    this.botNames.add(name)
    this.log('addBot', `Bot "${name}" (${id}) added. Total: ${this.state.players.length}`)
    return player
  }

  private voiceAgents: Map<string, VoiceAgent> = new Map()
  private voiceAgentCount = 0
  private activeVoiceAgentName: string | null = null

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

  // Add this new method
  async addVoiceAgent() {
    const pool = GameManager.VOICE_AGENT_POOL
    const agentDef = pool[this.voiceAgentCount % pool.length]
    const { name, persona, voice } = agentDef
    this.voiceAgentCount++
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

    // 2. Define the tools available to a player
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

    // 3. Join with the action handler
    await agent.join(
        fishjamRoomId,
        player.role,
        playerTools,
        (name, args) => {
          this.handleGeminiCommand({
            action: name,
            voter: player.name,
            target: args.target
          } as any)
        }
    )

    this.voiceAgents.set(name, agent)
    // Broadcast the updated state so the frontend shows the new player
    this.broadcastEvent({
      type: 'phase_changed',
      phase: this.state.phase,
      state: this.getPublicState(),
    })

    return { ok: true, player }
  }

  setActiveVoiceAgent(agentId: string | null) {
    const agentName = agentId
      ? this.state.players.find((p) => p.id === agentId)?.name ?? null
      : null

    this.activeVoiceAgentName = agentName

    // Mute all voice agents except the active one
    this.voiceAgents.forEach((agent, name) => {
      agent.setMuteInput(name !== agentName)
    })

    this.log('voiceAgent', `Active agent: ${agentName ?? 'none'}`)
    this.broadcastEvent({ type: 'agent_mute_changed', activeAgentId: agentId })
  }

  isBot(name: string): boolean {
    return this.botNames.has(name)
  }

  getBotNames(): string[] {
    return [...this.botNames]
  }

  removePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (player) {
      player.isConnected = false
      this.log('removePlayer', `${player.name} disconnected`)
    }
    this.clients.delete(playerId)
    this.votes.delete(playerId)
    this.nightActions.delete(playerId)

    if (this.state.phase === 'night') {
      const nightActors = this.state.players.filter(
        (p) => p.status === 'alive' && p.isConnected &&
          (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
      )
      const allActed = nightActors.every((p) => this.nightActions.has(p.id))
      if (allActed && nightActors.length > 0) {
        this.log('removePlayer', 'All remaining night actors acted, resolving night')
        this.resolveNight()
      }
    }

    if (this.state.phase === 'voting') {
      const alivePlayers = this.state.players.filter((p) => p.status === 'alive' && p.isConnected)
      if (this.votes.size >= alivePlayers.length && alivePlayers.length > 0) {
        this.log('removePlayer', 'All remaining voters voted, resolving votes')
        this.resolveVotes()
      }
    }
  }

  startGame() {
    if (this.state.phase !== 'lobby') {
      this.log('startGame', `Ignored — already in phase ${this.state.phase}`)
      return { error: 'Game already started' }
    }
    if (this.state.players.length < GAME_CONSTANTS.MIN_PLAYERS) {
      return { error: `Need at least ${GAME_CONSTANTS.MIN_PLAYERS} players to start` }
    }

    this.log('startGame', `Starting with ${this.state.players.length} players`)
    this.assignRoles()
    this.state.phase = 'role_assignment'

    this.broadcastEvent({ type: 'game_started', state: this.getPublicState() })

    const personalities = ['paranoid', 'analytical', 'dramatic']
    this.state.players.forEach((player, i) => {
      this.log('startGame', `${player.name} → ${player.role}`)
      this.sendToPlayer(player.id, { type: 'role_assigned', role: player.role })

      // Notify voice agents of their real role
      if (this.voiceAgents.has(player.name)) {
        this.voiceAgents.get(player.name)!.notifyRole(player.role)
      }

      // Create bot agents
      // FIX: Only create a BotAgent if there isn't already a VoiceAgent with this name
      if (this.isBot(player.name) && !this.voiceAgents.has(player.name)) {
        const apiKey = process.env.GEMINI_API_KEY
        if (apiKey) {
          const agent = new BotAgent(player.name, player.role, personalities[i % personalities.length], apiKey)
          this.botAgents.set(player.name, agent)
        }
      }
    })

    this.log('timing', `startGame: initGemini launched, waiting for bridge before startNight`)
    this.initGemini()

    return { ok: true }
  }

  private assignRoles() {
    const players = this.state.players
    const shuffled = [...players].sort(() => Math.random() - 0.5)

    if (players.length === 1) {
      // Solo test mode — player is all roles for testing
      shuffled[0].role = 'mafia'
      this.log('roles', 'Solo test mode: player is mafia')
      return
    }

    if (players.length <= 3) {
      // Small game: 1 mafia, rest civilians, no special roles
      shuffled[0].role = 'mafia'
      this.log('roles', `Small game: ${shuffled[0].name} is mafia`)
      return
    }

    // Normal game: detective, doctor, mafia, rest civilian
    const mafiaCount = Math.max(1, Math.floor(players.length / 4))
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
    this.log('peer', `Mapped Fishjam peerId ${peerId} → "${playerName}"`)
    this.fishjamPeerNames.set(peerId, playerName)
  }

  private async initGemini() {
    const apiKey = process.env.GEMINI_API_KEY
    const fishjamId = process.env.FISHJAM_URL?.match(/\/\/([^.]+)/)?.[1]
    const managementToken = process.env.FISHJAM_MANAGEMENT_TOKEN

    if (!apiKey || !fishjamId || !managementToken) {
      this.log('gemini', 'Missing GEMINI_API_KEY or FISHJAM credentials, skipping')
      return
    }

    if (!this.fishjamRoomId) {
      this.log('gemini', 'No Fishjam room ID set, skipping')
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
      botNames: this.getBotNames(),
    })

    this.bridge = new AgentBridge(fishjamId, managementToken, apiKey)

    this.bridge.on({
      // Forward transcripts to all clients + detect speakers + voice/function fallbacks
      onTranscript: (speaker, text, speakerId) => {
        const playerName = speakerId ? this.fishjamPeerNames.get(speakerId) : undefined
        this.log('transcript', `speaker=${speaker} peerId=${speakerId ?? 'none'} resolvedName=${playerName ?? 'unknown'} text="${text.slice(0, 60)}"`)
        this.broadcastEvent({ type: 'transcript', speaker, text, playerName })
        if (!text) return

        if (speaker === 'gemini') {
          for (const botName of this.botNames) {
            if (text.includes(`${botName} says`) || text.includes(`${botName} speaks`) || text.startsWith(botName)) {
              const bot = this.state.players.find((p) => p.name === botName)
              if (bot) this.broadcastEvent({ type: 'speaker_changed', speakerId: bot.id })
              break
            }
          }
          this.handleGeminiTranscriptFallback(text)
        }

        if (speaker === 'player') {
          if (playerName) {
            const player = this.state.players.find((p) => p.name === playerName)
            if (player) this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
          }
          this.handleVoiceFallback(text)
        }
      },

      // Clear transcript on Gemini turn complete
      onTurnComplete: () => {
        this.log('timing', `turnComplete at ${Date.now()}`)
        this.broadcastEvent({ type: 'transcript_clear' })
      },

      // Handle tool calls from Gemini
      onToolCall: (name, args) => {
        this.handleGeminiCommand({ action: name, ...args } as any)
      },
    })

    // GAME_TOOLS for function calling (same as before)
    const tools = [
      { name: 'night_kill', description: 'Mafia chooses player to eliminate', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] } },
      { name: 'investigate', description: 'Detective investigates a player', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] } },
      { name: 'doctor_save', description: 'Doctor protects a player', parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] } },
      { name: 'resolve_night', description: 'End night phase', parameters: { type: 'OBJECT', properties: {} } },
      { name: 'start_voting', description: 'Start voting phase', parameters: { type: 'OBJECT', properties: {} } },
      { name: 'cast_vote', description: 'Record a vote', parameters: { type: 'OBJECT', properties: { voter: { type: 'STRING' }, target: { type: 'STRING' } }, required: ['voter', 'target'] } },
      { name: 'update_suspicion', description: 'Update suspicion level', parameters: { type: 'OBJECT', properties: { player: { type: 'STRING' }, score: { type: 'NUMBER' }, reason: { type: 'STRING' } }, required: ['player', 'score', 'reason'] } },
      { name: 'behavioral_note', description: 'Record behavior observation', parameters: { type: 'OBJECT', properties: { player: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['player', 'note'] } },
      { name: 'bot_speak', description: 'Make an AI bot player say something out loud during day discussion. Use this instead of narrating bot dialogue yourself.', parameters: { type: 'OBJECT', properties: { player: { type: 'STRING' }, message: { type: 'STRING' } }, required: ['player', 'message'] } },
    ]

    this.log('timing', `initGemini START at ${Date.now()}`)
    await this.bridge.start(this.fishjamRoomId, prompt, tools, 'Orus', false)
    this.log('timing', `Bridge READY at ${Date.now()} — Game Master connected and audible`)

    setTimeout(() => this.startNight(), GAME_CONSTANTS.ROLE_REVEAL_DELAY)
  }

  private handleGeminiCommand(cmd: Record<string, string>) {
    this.log('command', JSON.stringify(cmd))

    const findPlayer = (name: string): Player | undefined => {
      const lower = name.toLowerCase()
      return this.state.players.find(
        (p) => p.name.toLowerCase() === lower && p.status === 'alive'
      )
    }

    switch (cmd.action) {
      case 'night_kill': {
        const target = findPlayer(cmd.target)
        if (!target) {
          this.log('command', `night_kill: player "${cmd.target}" not found`)
          break
        }
        // Apply for all mafia members
        const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
        for (const m of mafiaPlayers) {
          this.nightActions.set(m.id, target.id)
          this.log('command', `night_kill: ${m.name} → ${target.name}`)
        }
        this.logNightProgress()
        break
      }

      case 'investigate': {
        const target = findPlayer(cmd.target)
        if (!target) {
          this.log('command', `investigate: player "${cmd.target}" not found`)
          break
        }
        const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
        if (detective) {
          this.nightActions.set(detective.id, target.id)
          this.log('command', `investigate: ${detective.name} → ${target.name} (${target.role})`)
          // Tell Gemini the result so it can inform the detective
          this.bridge?.sendText(
            `[SYSTEM] Investigation result: ${target.name} is ${target.role === 'mafia' ? 'MAFIA' : 'NOT MAFIA (innocent)'}. Tell the detective this result privately.`
          )
          // Also send to detective client
          this.sendToPlayer(detective.id, {
            type: 'investigation_result',
            targetName: target.name,
            targetRole: target.role,
          })
        }
        this.logNightProgress()
        break
      }

      case 'doctor_save': {
        const target = findPlayer(cmd.target)
        if (!target) {
          this.log('command', `doctor_save: player "${cmd.target}" not found`)
          break
        }
        const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')
        if (doctor) {
          this.nightActions.set(doctor.id, target.id)
          this.log('command', `doctor_save: ${doctor.name} → ${target.name}`)
        }
        this.logNightProgress()
        break
      }

      case 'resolve_night': {
        if (this.state.phase !== 'night') {
          this.log('command', `resolve_night ignored — wrong phase (${this.state.phase})`)
          break
        }
        this.log('command', 'resolve_night triggered by Gemini')
        this.resolveNight()
        break
      }

      case 'start_voting': {
        if (this.state.phase !== 'day') break
        const dayElapsed = Date.now() - this.dayStartedAt
        if (dayElapsed < GAME_CONSTANTS.DAY_MIN_DURATION) {
          this.log('command', `start_voting BLOCKED — only ${(dayElapsed / 1000).toFixed(0)}s into day, minimum ${GAME_CONSTANTS.DAY_MIN_DURATION / 1000}s`)
          this.bridge?.sendText('[SYSTEM] Voting cannot start yet — continue the discussion. Voice all bot players first, then ask the human player(s). Take your time.')
          break
        }
        this.log('command', 'start_voting triggered by Gemini')
        this.startVoting()
        break
      }

      case 'cast_vote': {
        const voter = findPlayer(cmd.voter)
        const target = findPlayer(cmd.target)
        if (!voter || !target) {
          this.log('command', `vote: voter "${cmd.voter}" or target "${cmd.target}" not found`)
          break
        }
        if (this.state.phase !== 'voting') {
          this.log('command', `vote: wrong phase (${this.state.phase})`)
          break
        }
        this.log('command', `vote: ${voter.name} → ${target.name}`)
        this.votes.set(voter.id, target.id)
        this.broadcastEvent({ type: 'vote_cast', fromId: voter.id, targetId: target.id })

        const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
        if (this.votes.size >= eligibleVoters.length) {
          this.resolveVotes()
        }
        break
      }

      case 'update_suspicion': {
        const player = findPlayer(cmd.player)
        if (!player) {
          this.log('command', `update_suspicion: player "${cmd.player}" not found`)
          break
        }
        const score = Math.max(1, Math.min(10, Number(cmd.score) || 5))
        this.log('suspicion', `${player.name}: ${score}/10 — "${cmd.reason}"`)
        this.broadcastEvent({
          type: 'suspicion_update',
          playerId: player.id,
          playerName: player.name,
          score,
          reason: cmd.reason,
        })
        break
      }

      case 'behavioral_note': {
        const player = findPlayer(cmd.player)
        if (!player) {
          this.log('command', `behavioral_note: player "${cmd.player}" not found`)
          break
        }
        this.log('behavior', `${player.name}: "${cmd.note}"`)
        this.broadcastEvent({
          type: 'behavioral_note',
          playerName: player.name,
          note: cmd.note,
        })
        break
      }

      case 'bot_speak': {
        const player = findPlayer(cmd.player)
        if (!player) {
          this.log('command', `bot_speak: player "${cmd.player}" not found`)
          break
        }
        this.log('botSpeak', `${player.name}: "${cmd.message}"`)
        this.broadcastEvent({
          type: 'bot_speech',
          playerName: player.name,
          playerId: player.id,
          message: cmd.message,
        })
        this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
        this.broadcastEvent({ type: 'transcript', speaker: 'player', text: cmd.message, playerName: player.name })
        break
      }

      default:
        this.log('command', `Unknown action: ${cmd.action}`)
    }
  }

  private logNightProgress() {
    const nightActors = this.state.players.filter(
      (p) => p.status === 'alive' && (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
    )
    const acted = nightActors.filter((p) => this.nightActions.has(p.id))
    this.log('night', `Actions: ${acted.length}/${nightActors.length} (${acted.map((p) => p.role).join(', ')} done)`)

    // When all actions done, auto-resolve after 3 seconds — don't spam Gemini
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

  private voiceFallbackTimeout: ReturnType<typeof setTimeout> | null = null

  private handleVoiceFallback(text: string) {
    // Find player name in voice input — check ALL players first, then alive only
    const lower = text.toLowerCase()
    const allPlayers = this.state.players
    const mentioned = allPlayers.find((p) => lower.includes(p.name.toLowerCase()))
    if (!mentioned) return

    this.log('voiceFallback', `Heard player name "${mentioned.name}" in "${text}" (phase: ${this.state.phase}, alive: ${mentioned.status === 'alive'})`)

    // During night — find unresolved human roles and submit their action
    if (this.state.phase === 'night') {
      // Find human players who haven't acted yet (they're the ones speaking)
      const humanNightActors = this.state.players.filter(
        (p) => p.status === 'alive' && !this.isBot(p.name) &&
          (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor') &&
          !this.nightActions.has(p.id)
      )
      if (humanNightActors.length > 0) {
        const actor = humanNightActors[0]
        // Debounce — wait 2 seconds in case player says more
        if (this.voiceFallbackTimeout) clearTimeout(this.voiceFallbackTimeout)
        this.voiceFallbackTimeout = setTimeout(() => {
          if (this.nightActions.has(actor.id)) return // Gemini already handled it
          this.log('voiceFallback', `${actor.name} (${actor.role}) said "${text}" → target: ${mentioned.name}`)
          this.nightActions.set(actor.id, mentioned.id)
          // Confirm to player via transcript
          this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `Your choice: ${mentioned.name}. Confirmed.` })
          // Tell Gemini the action was captured so it can move on
          this.bridge?.sendText(`[SYSTEM] ${actor.role} action received: target is ${mentioned.name}. Move to the next role or call resolve_night if all done.`)
          this.logNightProgress()
        }, 2000)
      }
    }

    // During voting — submit vote for human players
    if (this.state.phase === 'voting' && mentioned.status === 'alive') {
      const humanVoters = this.state.players.filter(
        (p) => p.status === 'alive' && !this.isBot(p.name) && !this.votes.has(p.id)
      )
      if (humanVoters.length > 0) {
        const voter = humanVoters[0]
        if (voter.id === mentioned.id) return // can't vote for self
        if (this.voiceFallbackTimeout) clearTimeout(this.voiceFallbackTimeout)
        this.voiceFallbackTimeout = setTimeout(() => {
          if (this.votes.has(voter.id)) return
          this.log('voiceFallback', `${voter.name} vote: "${text}" → ${mentioned.name}`)
          this.votes.set(voter.id, mentioned.id)
          this.broadcastEvent({ type: 'vote_cast', fromId: voter.id, targetId: mentioned.id })
          // Send transcript confirmation so player sees it
          this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${voter.name} votes for ${mentioned.name}.` })
          const eligibleVoters = this.state.players.filter((p) => p.status === 'alive' && (p.isConnected || this.isBot(p.name)))
          if (this.votes.size >= eligibleVoters.length) this.resolveVotes()
        }, 1500)
      }
    }
  }

  // Handle text commands from player (typing fallback)
  handleTextCommand(playerId: string, text: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return

    this.log('textCommand', `${player.name}: "${text}"`)

    // Find mentioned player name
    const lower = text.toLowerCase()
    const mentioned = this.state.players.find(
      (p) => p.status === 'alive' && p.id !== playerId && lower.includes(p.name.toLowerCase())
    )

    if (!mentioned) {
      this.broadcastEvent({ type: 'transcript', speaker: 'player', text })
      // Also send to Gemini as player speech
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
      this.broadcastEvent({ type: 'transcript', speaker: 'player', text })
      this.bridge?.sendText(`[PLAYER] ${player.name} says: "${text}"`)
    }
  }

  private geminiTranscriptBuffer = ''
  private geminiTranscriptTimer: ReturnType<typeof setTimeout> | null = null

  private handleGeminiTranscriptFallback(text: string) {
    // Accumulate Gemini's speech to detect function names + player names
    this.geminiTranscriptBuffer += ' ' + text
    if (this.geminiTranscriptTimer) clearTimeout(this.geminiTranscriptTimer)

    // Process after 1.5 seconds of silence from Gemini
    this.geminiTranscriptTimer = setTimeout(() => {
      const buf = this.geminiTranscriptBuffer.toLowerCase()
      this.geminiTranscriptBuffer = ''

      // Find any player name mentioned
      const alivePlayers = this.state.players.filter((p) => p.status === 'alive')
      const mentionedPlayer = alivePlayers.find((p) => buf.includes(p.name.toLowerCase()))

      if (this.state.phase === 'night') {
        // Detect function name patterns from Gemini speech
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
          // Find bot voter from context
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

  // Run bot discussion during day — each bot speaks with its own AI and TTS
  private async runBotDiscussion(context: string) {
    const aliveBots = this.state.players.filter((p) => this.isBot(p.name) && p.status === 'alive')
    if (aliveBots.length === 0) return

    for (const bot of aliveBots) {
      if (this.state.phase !== 'day') break // phase changed, stop

      const agent = this.botAgents.get(bot.name)
      if (!agent) continue

      agent.addMemory(context)

      // Show speaker indicator
      //this.broadcastEvent({ type: 'speaker_changed', speakerId: bot.id })

      const response = await agent.generateResponse(context)
      if (!response) continue

      // Send as bot_speech for TTS
      this.broadcastEvent({
        type: 'bot_speech',
        playerName: bot.name,
        playerId: bot.id,
        message: response,
      })

      // Also send as transcript for subtitles
      this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${bot.name}: ${response}` })

      // Tell Game Master what the bot said
      this.bridge?.sendText(`[BOT] ${bot.name} said: "${response}"`)

      // Wait for TTS to roughly finish (estimate ~100ms per word)
      const wordCount = response.split(/\s+/).length
      await new Promise((r) => setTimeout(r, Math.max(3000, wordCount * 150)))
    }
  }

  // Run bot night actions
  private async runBotNightActions() {
    const aliveBots = this.state.players.filter(
      (p) => this.isBot(p.name) && p.status === 'alive' &&
        (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
    )

    const aliveTargets = this.state.players
      .filter((p) => p.status === 'alive')
      .map((p) => p.name)

    for (const bot of aliveBots) {
      const agent = this.botAgents.get(bot.name)
      if (!agent) continue
      if (this.nightActions.has(bot.id)) continue

      const context = `Night ${this.state.day}. You are ${bot.role}. Choose wisely.`
      const targetName = await agent.chooseTarget(
        aliveTargets.filter((n) => n !== bot.name),
        context
      )

      const target = this.state.players.find((p) => p.name === targetName && p.status === 'alive')
      if (target) {
        this.nightActions.set(bot.id, target.id)
        this.log('botNight', `${bot.name} (${bot.role}) → ${target.name}`)

        if (bot.role === 'detective') {
          agent.addMemory(`I investigated ${target.name} — they are ${target.role === 'mafia' ? 'MAFIA' : 'innocent'}`)
        }
      }
    }

    this.logNightProgress()
  }

  // Run bot voting
  private async runBotVoting(context: string) {
    const aliveBots = this.state.players.filter((p) => this.isBot(p.name) && p.status === 'alive')
    const aliveNames = this.state.players.filter((p) => p.status === 'alive').map((p) => p.name)

    for (const bot of aliveBots) {
      if (this.state.phase !== 'voting') break
      if (this.votes.has(bot.id)) continue

      const agent = this.botAgents.get(bot.name)
      if (!agent) continue

      agent.addMemory(context)
      const targetName = await agent.chooseTarget(
        aliveNames.filter((n) => n !== bot.name),
        `Voting time. Who is most suspicious? ${context}`
      )

      const target = this.state.players.find((p) => p.name === targetName && p.status === 'alive')
      if (target) {
        this.votes.set(bot.id, target.id)
        this.broadcastEvent({ type: 'vote_cast', fromId: bot.id, targetId: target.id })
        this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${bot.name} votes for ${target.name}.` })
        this.log('botVote', `${bot.name} → ${target.name}`)

        // Check if all voted
        const alive = this.state.players.filter((p) => p.status === 'alive')
        if (this.votes.size >= alive.length) {
          this.resolveVotes()
          return
        }

        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }

  startNight() {
    this.resolving = false
    this.log('timing', `startNight at ${Date.now()}`)
    this.log('phase', `→ NIGHT ${this.state.day}`)
    this.log('gemini', `Session alive: ${this.bridge?.isAlive() ?? 'no session'}`)
    this.state.phase = 'night'
    this.nightActions.clear()
    this.broadcastEvent({
      type: 'phase_changed',
      phase: 'night',
      state: this.getPublicState(),
    })

    const mafiaPlayers = this.state.players.filter((p) => p.role === 'mafia' && p.status === 'alive')
    const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
    const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')

    const roleInfo = (name: string | undefined, role: string) => {
      if (!name) return `No alive ${role}.`
      return `${role}: ${name} (${this.isBot(name) ? 'BOT — decide silently, call function without speaking' : 'HUMAN — wait for their voice response'}).`
    }

    this.bridge?.sendText(
      `[SYSTEM] Night ${this.state.day} begins.\n` +
      `${roleInfo(mafiaPlayers.map((p) => p.name).join(', '), 'Mafia')}\n` +
      `${roleInfo(detective?.name, 'Detective')}\n` +
      `${roleInfo(doctor?.name, 'Doctor')}\n\n` +
      `INSTRUCTIONS:\n` +
      `1. Narrate: "The town falls asleep..." (2-3 sentences max)\n` +
      `2. Say: "Mafia, open your eyes. Choose your victim."\n` +
      `3. For HUMAN mafia: STOP and WAIT for their voice. When you hear a player name, call night_kill(target=NAME) IMMEDIATELY.\n` +
      `4. For BOT mafia: call night_kill silently, then say "The mafia has chosen."\n` +
      `5. Move to detective, then doctor — same pattern.\n` +
      `6. After all 3 functions called, call resolve_night.\n\n` +
      `CRITICAL: When human says a name like "Alexa" or "I choose Bruno" — you MUST call the function with that name. Do not just acknowledge verbally.`
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

    // Run bot night actions after delay (give human time to speak first)
    setTimeout(() => this.runBotNightActions(), 15_000)

    this.nightTimeout = setTimeout(() => {
      this.log('night', 'Timeout! Auto-resolving')
      this.resolveNight()
    }, GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT)
  }

  handleFaceMetrics(playerId: string, metrics: { stress: number; surprise: number; happiness: number; lookingAway: boolean }) {
    if (this.state.phase !== 'day' && this.state.phase !== 'voting') return

    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return

    // Only send to Gemini if metrics are noteworthy
    const isNoteworthy = metrics.stress > 0.2 || metrics.surprise > 0.3 || metrics.lookingAway || metrics.happiness > 0.4
    if (!isNoteworthy) return

    const observations: string[] = []
    if (metrics.stress > 0.2) observations.push(`stress level ${(metrics.stress * 100).toFixed(0)}%`)
    if (metrics.surprise > 0.6) observations.push(`surprised expression ${(metrics.surprise * 100).toFixed(0)}%`)
    if (metrics.lookingAway) observations.push('looking away from camera')
    if (metrics.happiness > 0.4) observations.push(`smiling ${(metrics.happiness * 100).toFixed(0)}%`)
    if (metrics.happiness > 0.4 && metrics.stress > 0.2) observations.push('possible nervous smile')

    this.log('face', `${player.name}: ${observations.join(', ')}`)

    this.bridge?.sendText(
      `[FACE ANALYSIS] ${player.name}'s face shows: ${observations.join(', ')}. Consider this in your behavioral analysis. You can comment on it naturally, e.g. "I notice ${player.name} seems tense..." and call update_suspicion if appropriate.`
    )
  }

  // Keep manual night action as fallback
  handleNightAction(playerId: string, targetId: string) {
    if (this.state.phase !== 'night') return
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return
    if (player.role !== 'mafia' && player.role !== 'detective' && player.role !== 'doctor') return
    const target = this.state.players.find((p) => p.id === targetId)
    if (!target || target.status !== 'alive' || target.id === playerId) return

    this.log('nightAction:manual', `${player.name} (${player.role}) → ${target.name}`)
    this.nightActions.set(playerId, targetId)

    const nightActors = this.state.players.filter(
      (p) => p.status === 'alive' && (p.role === 'mafia' || p.role === 'detective' || p.role === 'doctor')
    )
    if (nightActors.every((p) => this.nightActions.has(p.id))) {
      this.resolveNight()
    }
  }

  private resolveNight() {
    if (this.resolving) return
    this.resolving = true
    this.log('resolveNight', 'Resolving...')

    if (this.nightTimeout) {
      clearTimeout(this.nightTimeout)
      this.nightTimeout = null
    }

    // Mafia target
    const mafiaTargets = this.state.players
      .filter((p) => p.role === 'mafia' && p.status === 'alive')
      .map((p) => this.nightActions.get(p.id))
      .filter(Boolean) as string[]

    const targetCounts = new Map<string, number>()
    mafiaTargets.forEach((t) => targetCounts.set(t, (targetCounts.get(t) || 0) + 1))

    let mafiaTarget: string | null = null
    let maxVotes = 0
    targetCounts.forEach((count, target) => {
      if (count > maxVotes) {
        maxVotes = count
        mafiaTarget = target
      }
    })

    // Doctor save
    const doctor = this.state.players.find((p) => p.role === 'doctor' && p.status === 'alive')
    const doctorTarget = doctor ? this.nightActions.get(doctor.id) : null
    const eliminatedId = mafiaTarget === doctorTarget ? null : mafiaTarget

    const targetName = mafiaTarget ? this.state.players.find((p) => p.id === mafiaTarget)?.name : null
    const savedName = doctorTarget ? this.state.players.find((p) => p.id === doctorTarget)?.name : null

    this.log('resolveNight', `Mafia target: ${targetName || 'none'}, Doctor saved: ${savedName || 'none'}, Eliminated: ${eliminatedId ? targetName : 'nobody'}`)

    // Detective investigation (send result if not already sent via command)
    const detective = this.state.players.find((p) => p.role === 'detective' && p.status === 'alive')
    if (detective) {
      const investigatedId = this.nightActions.get(detective.id)
      if (investigatedId) {
        const investigated = this.state.players.find((p) => p.id === investigatedId)
        if (investigated) {
          this.log('resolveNight', `Detective investigated ${investigated.name} → ${investigated.role}`)
          this.sendToPlayer(detective.id, {
            type: 'investigation_result',
            targetName: investigated.name,
            targetRole: investigated.role,
          })
        }
      }
    }

    // Wait for narrator to finish before starting day
    this.log('timing', `resolveNight done at ${Date.now()} — awaiting turnComplete before startDay`)
    if (this.bridge) {
      this.bridge.afterNarratorFinishes(() => this.startDay(eliminatedId))
    } else {
      setTimeout(() => this.startDay(eliminatedId), 3000)
    }
  }

  startDay(eliminatedId: string | null) {
    this.resolving = false
    this.log('timing', `startDay at ${Date.now()}`)
    const eliminatedName = eliminatedId
      ? this.state.players.find((p) => p.id === eliminatedId)?.name
      : null

    if (eliminatedId) {
      this.eliminatePlayer(eliminatedId)
    }

    this.state.phase = 'day'
    this.state.day++
    this.dayStartedAt = Date.now()
    this.log('phase', `→ DAY ${this.state.day} (eliminated: ${eliminatedName || 'nobody'})`)
    this.log('gemini', `Session alive: ${this.bridge?.isAlive() ?? 'no session'}`)

    this.broadcastEvent({
      type: 'phase_changed',
      phase: 'day',
      state: this.getPublicState(),
    })

    const alivePlayers = this.state.players.filter((p) => p.status === 'alive')
    const aliveHumans = alivePlayers.filter((p) => !this.isBot(p.name))
    const aliveBots = alivePlayers.filter((p) => this.isBot(p.name))

    const botInstructions = aliveBots.length > 0
      ? `\n\nBOT PLAYERS TO VOICE (speak AS them, with distinct personalities):\n` +
        aliveBots.map((b) => `- ${b.name} (${b.role === 'mafia' ? 'secretly mafia — act defensive but not too obvious' : 'innocent — be genuinely confused or suspicious of others'})`).join('\n') +
        `\n\nYou MUST voice each bot during discussion. Format: "${aliveBots[0].name} says: [their opinion]"` +
        `\nMake each bot react to what happened. Mafia bots should subtly deflect. Innocent bots should accuse.` +
        `\nAfter voicing all bots, ask the human player(s) for their thoughts. WAIT for their response.`
      : ''

    const humanNames = aliveHumans.map((p) => p.name).join(', ')

    const dayMsg = eliminatedId
      ? `Day ${this.state.day}. ${eliminatedName} was killed. They were ${this.state.players.find((p) => p.id === eliminatedId)?.role}. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Dramatically announce the death (3-5 sentences). Finish your full announcement before addressing any player.`
      : `Day ${this.state.day}. Nobody died — doctor saved them! Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Dramatically announce that everyone survived (3-5 sentences). Finish your full announcement before addressing any player.`

    this.bridge?.sendText(`[SYSTEM] ${dayMsg}`)
    this.log('gemini', `Day message sent. Session alive: ${this.bridge?.isAlive()}`)

    // Run bot discussion after Gemini announces (give it 8 seconds to narrate)
    setTimeout(() => {
      if (this.state.phase === 'day') {
        this.runBotDiscussion(dayMsg)
      }
    }, 8000)

    // Retry if Gemini doesn't respond within 10 seconds
    const dayRetry = setTimeout(() => {
      if (this.state.phase === 'day' && this.bridge?.isAlive()) {
        this.log('gemini', 'No response from Gemini — retrying day prompt')
        this.bridge?.sendText(`[SYSTEM] It is DAY. You must speak! Announce what happened and start discussion with the players. Alive: ${alivePlayers.map((p) => p.name).join(', ')}.`)
      }
    }, 10_000)

    this.dayTimeout = setTimeout(() => {
      clearTimeout(dayRetry)
      if (this.state.phase === 'day') {
        this.log('day', 'Timeout! Auto-starting voting')
        this.startVoting()
      }
    }, GAME_CONSTANTS.DAY_SPEECH_TIMEOUT)
  }

  startVoting() {
    if (this.dayTimeout) {
      clearTimeout(this.dayTimeout)
      this.dayTimeout = null
    }

    this.resolving = false
    this.log('timing', `startVoting at ${Date.now()}`)
    this.state.phase = 'voting'
    this.votes.clear()

    const aliveList = this.state.players
      .filter((p) => p.status === 'alive')
      .map((p) => p.name)
      .join(', ')

    this.log('phase', `→ VOTING (alive: ${aliveList})`)

    this.broadcastEvent({
      type: 'phase_changed',
      phase: 'voting',
      state: this.getPublicState(),
    })

    this.bridge?.sendText(
      `[SYSTEM] Voting time! Alive players: ${aliveList}. First announce that voting begins (2-3 dramatic sentences). Then call each player by name and ask who they want to eliminate. After each player answers, call the cast_vote function. After all players have voted, the system will resolve automatically.`
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

    // Run bot votes after 5 seconds
    setTimeout(() => {
      if (this.state.phase === 'voting') {
        this.runBotVoting(`Day ${this.state.day} discussion is over.`)
      }
    }, 5000)

    this.votingTimeout = setTimeout(() => {
      this.log('voting', 'Timeout! Auto-resolving')
      this.resolveVotes()
    }, GAME_CONSTANTS.VOTING_TIMEOUT)
  }

  // Keep manual vote as fallback
  castVote(fromId: string, targetId: string) {
    if (this.state.phase !== 'voting') return
    const from = this.state.players.find((p) => p.id === fromId)
    if (!from || from.status !== 'alive') return
    const target = this.state.players.find((p) => p.id === targetId)
    if (!target || target.status !== 'alive' || target.id === fromId) return

    this.log('vote:manual', `${from.name} → ${target.name}`)
    this.votes.set(fromId, targetId)
    this.broadcastEvent({ type: 'vote_cast', fromId, targetId })

    const alivePlayers = this.state.players.filter((p) => p.status === 'alive')
    if (this.votes.size >= alivePlayers.length) {
      this.resolveVotes()
    }
  }

  private resolveVotes() {
    if (this.resolving) return
    this.resolving = true

    if (this.votingTimeout) {
      clearTimeout(this.votingTimeout)
      this.votingTimeout = null
    }

    const voteCounts = new Map<string, number>()
    this.votes.forEach((targetId) => {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1)
    })

    let maxVotes = 0
    voteCounts.forEach((count) => {
      if (count > maxVotes) maxVotes = count
    })

    let eliminatedId: string | null = null
    if (maxVotes > 0) {
      const tiedPlayers: string[] = []
      voteCounts.forEach((count, playerId) => {
        if (count === maxVotes) tiedPlayers.push(playerId)
      })
      eliminatedId = tiedPlayers[Math.floor(Math.random() * tiedPlayers.length)]
    }

    const votesRecord: Record<string, string> = {}
    this.votes.forEach((target, from) => {
      votesRecord[from] = target
    })

    // Log vote summary
    const votesSummary = Array.from(this.votes.entries())
      .map(([fromId, toId]) => {
        const from = this.state.players.find((p) => p.id === fromId)
        const to = this.state.players.find((p) => p.id === toId)
        return `${from?.name} → ${to?.name}`
      })
      .join(', ')
    const eliminatedName = eliminatedId ? this.state.players.find((p) => p.id === eliminatedId)?.name : 'nobody'
    this.log('resolveVotes', `Votes: [${votesSummary}] → eliminated: ${eliminatedName}`)

    this.broadcastEvent({ type: 'vote_result', eliminatedId, votes: votesRecord })

    if (eliminatedId) {
      this.eliminatePlayer(eliminatedId)
    }

    if (this.state.phase !== 'game_over') {
      const eliminatedPlayer = eliminatedId ? this.state.players.find((p) => p.id === eliminatedId) : null
      this.bridge?.sendText(
        eliminatedPlayer
          ? `[SYSTEM] Vote result: ${eliminatedPlayer.name} was eliminated by vote. They were ${eliminatedPlayer.role}. Announce this dramatically. Then prepare for night.`
          : `[SYSTEM] Vote result: No one was eliminated (no votes or tie). Announce this. Then prepare for night.`
      )
      this.log('timing', `resolveVoting done at ${Date.now()} — awaiting turnComplete before startNight`)
      if (this.bridge) {
        this.bridge.afterNarratorFinishes(() => this.startNight())
      } else {
        setTimeout(() => this.startNight(), GAME_CONSTANTS.ROLE_REVEAL_DELAY)
      }
    }
  }

  eliminatePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player) return

    player.status = 'dead'
    this.log('eliminate', `${player.name} (${player.role}) eliminated!`)
    this.broadcastEvent({ type: 'player_eliminated', playerId, role: player.role })
    this.checkWinCondition()
  }

  private checkWinCondition() {
    const alive = this.state.players.filter((p) => p.status === 'alive')
    const mafiaAlive = alive.filter((p) => p.role === 'mafia').length
    const civiliansAlive = alive.filter((p) => p.role !== 'mafia').length

    this.log('winCheck', `Alive: ${alive.length} (mafia: ${mafiaAlive}, civilians: ${civiliansAlive})`)

    if (mafiaAlive === 0) {
      this.endGame('civilians')
    } else if (mafiaAlive >= civiliansAlive) {
      this.endGame('mafia')
    }
  }

  private endGame(winner: 'mafia' | 'civilians') {
    this.state.winner = winner
    this.state.phase = 'game_over'

    this.log('phase', `→ GAME OVER! Winner: ${winner}`)
    this.log('endGame', 'Final roles: ' + this.state.players.map((p) => `${p.name}=${p.role}(${p.status})`).join(', '))

    this.broadcastEvent({ type: 'game_over', winner, state: this.state })
    this.bridge?.sendText(
      `[SYSTEM] Game over! The ${winner} won! All roles: ${this.state.players.map((p) => `${p.name} was ${p.role}`).join(', ')}. Announce the result dramatically and reveal all roles.`
    )
    this.cleanup()
  }

  cleanup() {
    this.log('cleanup', 'Cleaning up game resources')
    this.bridge?.disconnect()
    this.bridge = null

    // Disconnect all voice agents
    this.voiceAgents.forEach(agent => agent.disconnect())
    this.voiceAgents.clear()

    if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
    if (this.dayTimeout) { clearTimeout(this.dayTimeout); this.dayTimeout = null }
    if (this.votingTimeout) { clearTimeout(this.votingTimeout); this.votingTimeout = null }
  }

  // Audio now flows through Fishjam Agent — no manual forwarding needed
  sendPlayerAudio(_chunk: Buffer) {
    // No-op: AgentBridge handles audio via Fishjam SFU
  }

  allDisconnected(): boolean {
    return this.clients.size === 0
  }

  broadcastEvent(event: ServerEvent) {
    this.log('broadcast', event.type)
    this.clients.forEach((ws) => {
      ws.send(JSON.stringify(event))
    })
  }

  sendToPlayer(playerId: string, event: ServerEvent) {
    const player = this.state.players.find((p) => p.id === playerId)
    this.log('sendToPlayer', `${event.type} → ${player?.name || playerId}`)
    const ws = this.clients.get(playerId)
    if (ws) {
      ws.send(JSON.stringify(event))
    }
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
      players: this.state.players.map((p) => ({
        ...p,
        role: p.status === 'dead' ? p.role : 'civilian',
      })),
      voiceAgentIds,
      activeVoiceAgentId,
    }
  }
}

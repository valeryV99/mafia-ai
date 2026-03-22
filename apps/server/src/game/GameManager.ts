import type { GameState, Player, Phase, Role, ServerEvent } from '@mafia-ai/types'
import type { ServerWebSocket } from 'bun'
import { AgentBridge } from '../fishjam/AgentBridge'
import { buildGameMasterPrompt } from '../gemini/prompts'
import { GAME_CONSTANTS } from './constants'
import { BotAgent } from './BotAgent'
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
  private dayTimeout: ReturnType<typeof setTimeout> | null = null
  private votingTimeout: ReturnType<typeof setTimeout> | null = null
  private resolving = false
  private botNames: Set<string> = new Set()
  private botAgents: Map<string, BotAgent> = new Map()
  private voiceAgents: Map<string, VoiceAgent> = new Map()
  private fishjamPeerNames: Map<string, string> = new Map()

  constructor(roomId: string) {
    this.state = {
      roomId,
      phase: 'lobby',
      players: [],
      day: 1,
      winner: null,
      currentSpeakerId: null,
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

  addBot(name: string): Player {
    const id = `bot-${crypto.randomUUID().slice(0, 8)}`
    const player: Player = { id, name, role: 'civilian', status: 'alive', isConnected: true }
    this.state.players.push(player)
    this.botNames.add(name)
    this.log('addBot', `"${name}" added. Total: ${this.state.players.length}`)
    return player
  }

  isBot(name: string): boolean { return this.botNames.has(name) }
  getBotNames(): string[] { return [...this.botNames] }

  async addVoiceAgent(name: string = 'Alex') {
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

    const player = this.addBot(name)

    const playerTools = [
      {
        name: 'cast_vote',
        description: 'Vote for a player to be eliminated during the voting phase',
        parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] }
      },
    ]

    const agent = new VoiceAgent(name, apiKey, fishjamId, managementToken)
    await agent.join(
      this.fishjamRoomId,
      player.role,
      playerTools,
      (toolName, args) => {
        this.handleGeminiCommand({ action: toolName, voter: name, ...args } as any)
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

    this.log('startGame', `Starting with ${this.state.players.length} players`)
    this.assignRoles()
    this.state.phase = 'role_assignment'
    this.broadcastEvent({ type: 'game_started', state: this.getPublicState() })

    const personalities = ['paranoid', 'analytical', 'dramatic']
    this.state.players.forEach((player, i) => {
      this.log('startGame', `${player.name} → ${player.role}`)
      this.sendToPlayer(player.id, { type: 'role_assigned', role: player.role })

      if (this.isBot(player.name)) {
        const apiKey = process.env.GEMINI_API_KEY
        if (apiKey) {
          const agent = new BotAgent(player.name, player.role, personalities[i % personalities.length], apiKey)
          this.botAgents.set(player.name, agent)
        }
      }
    })

    this.initGemini()
    return { ok: true }
  }

  private assignRoles() {
    const players = this.state.players
    const shuffled = [...players].sort(() => Math.random() - 0.5)

    if (players.length === 1) {
      shuffled[0].role = 'mafia'
      return
    }
    if (players.length <= 3) {
      shuffled[0].role = 'mafia'
      return
    }

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
    this.log('peer', `Mapped ${peerId.slice(0, 8)} → "${playerName}"`)
    this.fishjamPeerNames.set(peerId, playerName)
    this.bridge?.allowPeer(peerId)
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
      botNames: this.getBotNames(),
    })

    const tools = [
      { name: 'start_voting', description: 'Start voting phase after discussion', parameters: { type: 'OBJECT', properties: {} } },
      { name: 'cast_vote', description: 'Record a vote from a player', parameters: { type: 'OBJECT', properties: { voter: { type: 'STRING' }, target: { type: 'STRING' } }, required: ['voter', 'target'] } },
      { name: 'update_suspicion', description: 'Update suspicion level for a player', parameters: { type: 'OBJECT', properties: { player: { type: 'STRING' }, score: { type: 'NUMBER' }, reason: { type: 'STRING' } }, required: ['player', 'score', 'reason'] } },
      { name: 'bot_speak', description: 'Make a bot player say something during discussion', parameters: { type: 'OBJECT', properties: { player: { type: 'STRING' }, message: { type: 'STRING' } }, required: ['player', 'message'] } },
    ]

    this.bridge = new AgentBridge(fishjamId, managementToken, apiKey)

    // Register already-known human peers
    for (const peerId of this.fishjamPeerNames.keys()) {
      this.bridge.allowPeer(peerId)
    }

    this.bridge.on({
      onTranscript: (speaker, text, speakerId) => {
        const playerName = speakerId ? this.fishjamPeerNames.get(speakerId) : undefined
        this.broadcastEvent({ type: 'transcript', speaker, text, playerName })

        if (speaker === 'gemini') {
          for (const botName of this.botNames) {
            if (text.includes(`${botName} says`) || text.startsWith(botName)) {
              const bot = this.state.players.find((p) => p.name === botName)
              if (bot) this.broadcastEvent({ type: 'speaker_changed', speakerId: bot.id })
              break
            }
          }
        }

        if (speaker === 'player' && playerName) {
          const player = this.state.players.find((p) => p.name === playerName)
          if (player) this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
          this.handleVoiceVote(playerName, text)
        }
      },

      onTurnComplete: () => {
        this.broadcastEvent({ type: 'transcript_clear' })
      },

      onToolCall: (name, args) => {
        this.handleGeminiCommand({ action: name, ...args } as any)
      },
    })

    await this.bridge.start(this.fishjamRoomId, prompt, tools, 'Orus', false)
    this.log('gemini', 'Bridge ready')
    setTimeout(() => this.startNight(), GAME_CONSTANTS.ROLE_REVEAL_DELAY)
  }

  private handleGeminiCommand(cmd: Record<string, string>) {
    switch (cmd.action) {
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
        const alive = this.state.players.filter((p) => p.status === 'alive')
        if (this.votes.size >= alive.length) this.resolveVotes()
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

      case 'bot_speak': {
        const player = this.state.players.find((p) => {
          const lower = cmd.player?.toLowerCase()
          return p.name.toLowerCase() === lower && p.status === 'alive'
        })
        if (!player) break
        this.log('botSpeak', `${player.name}: "${cmd.message}"`)
        this.broadcastEvent({ type: 'bot_speech', playerName: player.name, playerId: player.id, message: cmd.message })
        this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
        this.broadcastEvent({ type: 'transcript', speaker: 'player', text: cmd.message, playerName: player.name })
        break
      }

      default:
        this.log('command', `Unknown: ${cmd.action}`)
    }
  }

  // Detect player votes from voice during voting phase
  private handleVoiceVote(voterName: string, text: string) {
    if (this.state.phase !== 'voting') return
    const voter = this.state.players.find((p) => p.name === voterName && p.status === 'alive')
    if (!voter || this.votes.has(voter.id)) return

    const lower = text.toLowerCase()
    const mentioned = this.state.players.find(
      (p) => p.status === 'alive' && p.id !== voter.id && lower.includes(p.name.toLowerCase())
    )
    if (!mentioned) return

    setTimeout(() => {
      if (this.votes.has(voter.id)) return
      this.log('voiceVote', `${voterName} → ${mentioned.name}`)
      this.votes.set(voter.id, mentioned.id)
      this.broadcastEvent({ type: 'vote_cast', fromId: voter.id, targetId: mentioned.id })
      const alive = this.state.players.filter((p) => p.status === 'alive')
      if (this.votes.size >= alive.length) this.resolveVotes()
    }, 1500)
  }

  startNight() {
    this.resolving = false
    this.log('phase', `→ NIGHT ${this.state.day}`)
    this.state.phase = 'night'
    this.broadcastEvent({ type: 'phase_changed', phase: 'night', state: this.getPublicState() })

    this.bridge?.sendText(
      `[SYSTEM] Night ${this.state.day} begins. Narrate the town falling asleep (2-3 atmospheric sentences). Keep it short and dramatic.`
    )

    this.nightTimeout = setTimeout(() => {
      this.resolveNight()
    }, GAME_CONSTANTS.NIGHT_MAFIA_TIMEOUT)
  }

  private resolveNight() {
    if (this.resolving) return
    this.resolving = true
    if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }

    // No night actions — nobody dies yet
    this.startDay(null)
  }

  startDay(eliminatedId: string | null) {
    this.resolving = false
    this.log('phase', `→ DAY ${this.state.day}`)
    const eliminatedName = eliminatedId
      ? this.state.players.find((p) => p.id === eliminatedId)?.name
      : null

    if (eliminatedId) this.eliminatePlayer(eliminatedId)

    this.state.phase = 'day'
    this.state.day++
    this.broadcastEvent({ type: 'phase_changed', phase: 'day', state: this.getPublicState() })

    const alivePlayers = this.state.players.filter((p) => p.status === 'alive')

    const dayMsg = eliminatedId
      ? `Day ${this.state.day}. ${eliminatedName} was killed last night. They were ${this.state.players.find((p) => p.id === eliminatedId)?.role}. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Dramatically announce the death, then run the discussion. Voice each bot player. Then call start_voting when ready.`
      : `Day ${this.state.day}. Nobody died last night. Alive: ${alivePlayers.map((p) => p.name).join(', ')}. Announce this, run discussion, voice each bot, then call start_voting.`

    this.bridge?.sendText(`[SYSTEM] ${dayMsg}`)

    // Run bot voting responses after discussion
    setTimeout(() => {
      if (this.state.phase === 'day') {
        this.runBotVoting(`Day ${this.state.day} discussion.`)
      }
    }, GAME_CONSTANTS.DAY_MIN_DURATION)

    this.dayTimeout = setTimeout(() => {
      if (this.state.phase === 'day') {
        this.log('day', 'Timeout! Auto-starting voting')
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

    this.votingTimeout = setTimeout(() => {
      this.log('voting', 'Timeout! Auto-resolving')
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

    const tiedPlayers: string[] = []
    voteCounts.forEach((count, id) => { if (count === maxVotes) tiedPlayers.push(id) })
    const eliminatedId = tiedPlayers.length > 0
      ? tiedPlayers[Math.floor(Math.random() * tiedPlayers.length)]
      : ''

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
          ? `[SYSTEM] ${eliminatedPlayer.name} was eliminated. They were ${eliminatedPlayer.role}. Announce this dramatically, then prepare for night.`
          : `[SYSTEM] No one was eliminated. Announce this, then prepare for night.`
      )
      setTimeout(() => {
        if (this.state.phase !== 'game_over') this.startNight()
      }, 4000)
    }
  }

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
        `Voting. Who is most suspicious? ${context}`
      )

      const target = this.state.players.find((p) => p.name === targetName && p.status === 'alive')
      if (target) {
        this.votes.set(bot.id, target.id)
        this.broadcastEvent({ type: 'vote_cast', fromId: bot.id, targetId: target.id })
        this.broadcastEvent({ type: 'transcript', speaker: 'gemini', text: `${bot.name} votes for ${target.name}.` })
        this.log('botVote', `${bot.name} → ${target.name}`)
        const alive = this.state.players.filter((p) => p.status === 'alive')
        if (this.votes.size >= alive.length) { this.resolveVotes(); return }
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }

  handleTextCommand(playerId: string, text: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player || player.status !== 'alive') return

    this.broadcastEvent({ type: 'transcript', speaker: 'player', text, playerName: player.name })
    this.bridge?.sendText(`[PLAYER] ${player.name} says: "${text}"`)

    if (this.state.phase === 'voting') {
      const lower = text.toLowerCase()
      const mentioned = this.state.players.find(
        (p) => p.status === 'alive' && p.id !== playerId && lower.includes(p.name.toLowerCase())
      )
      if (mentioned && !this.votes.has(playerId)) {
        this.votes.set(playerId, mentioned.id)
        this.broadcastEvent({ type: 'vote_cast', fromId: playerId, targetId: mentioned.id })
        const alive = this.state.players.filter((p) => p.status === 'alive')
        if (this.votes.size >= alive.length) this.resolveVotes()
      }
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

  handleFaceMetrics(_playerId: string, _metrics: object) {
    // Disabled — was causing Gemini distraction
  }

  sendPlayerAudio(_chunk: Buffer) {
    // No-op: AgentBridge handles audio via Fishjam SFU
  }

  private eliminatePlayer(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId)
    if (!player) return
    player.status = 'dead'
    this.log('eliminate', `${player.name} (${player.role})`)
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
  }

  allDisconnected(): boolean { return this.clients.size === 0 }

  broadcastEvent(event: ServerEvent) {
    this.clients.forEach((ws) => ws.send(JSON.stringify(event)))
  }

  sendToPlayer(playerId: string, event: ServerEvent) {
    const ws = this.clients.get(playerId)
    if (ws) ws.send(JSON.stringify(event))
  }

  getPublicState(): GameState {
    return {
      ...this.state,
      players: this.state.players.map((p) => ({ ...p, role: 'civilian' as Role })),
    }
  }
}

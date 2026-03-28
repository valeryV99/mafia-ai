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
  private dayTimeout: ReturnType<typeof setTimeout> | null = null
  private votingTimeout: ReturnType<typeof setTimeout> | null = null
  private resolving = false
  private pendingPhaseTransition: (() => void) | null = null
  private voiceAgents: Map<string, VoiceAgent> = new Map()
  private mafiaVotes: Map<string, string> = new Map()
  private detectiveTarget: string | null = null
  private doctorTarget: string | null = null
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

  async addVoiceAgent(name: string = 'Alex') {
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

    const player: Player = { id: `voice-${crypto.randomUUID().slice(0, 8)}`, name, role: 'civilian', status: 'alive', isConnected: true }
    this.state.players.push(player)
    this.log('voiceAgent', `"${name}" added as player. Total: ${this.state.players.length}`)

    const playerTools = [
      {
        name: 'cast_vote',
        description: 'Vote for a player to be eliminated during the voting phase',
        parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } }, required: ['target'] }
      },
    ]

    // Only allow human peers — not GameMaster or other VoiceAgents
    const humanPeerIds = [...this.fishjamPeerNames.keys()]

    const agent = new VoiceAgent(name, apiKey, fishjamId, managementToken)
    await agent.join(
      this.fishjamRoomId,
      player.role,
      playerTools,
      humanPeerIds,
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

    this.log('voiceAgent', `${name} joined as ${player.role}, listening to ${humanPeerIds.length} human peer(s)`)
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

    this.state.players.forEach((player) => {
      this.sendToPlayer(player.id, { type: 'role_assigned', role: player.role })
    })

    const roleSummary = this.state.players.map((p) => `${p.name}=${p.role}`).join(', ')
    this.log('roles', roleSummary)

    this.initGemini()
    return { ok: true }
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
      onTranscript: (speaker, text, speakerId) => {
        const playerName = speakerId ? this.fishjamPeerNames.get(speakerId) : undefined
        this.broadcastEvent({ type: 'transcript', speaker, text, playerName })

        if (speaker === 'player' && playerName) {
          const player = this.state.players.find((p) => p.name === playerName)
          if (player) this.broadcastEvent({ type: 'speaker_changed', speakerId: player.id })
          this.handleVoiceVote(playerName, text)
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

    await this.bridge.start(this.fishjamRoomId, prompt, tools, 'Orus', false)
    this.log('gemini', 'Bridge ready')
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
    const mafiaAlive = this.state.players.some((p) => p.role === 'mafia' && p.status === 'alive')
    const detectiveAlive = this.state.players.some((p) => p.role === 'detective' && p.status === 'alive')
    const doctorAlive = this.state.players.some((p) => p.role === 'doctor' && p.status === 'alive')

    const mafiaActed = this.mafiaVotes.size > 0 || !mafiaAlive
    const detectiveActed = this.detectiveTarget !== null || !detectiveAlive
    const doctorActed = this.doctorTarget !== null || !doctorAlive

    if (mafiaActed && detectiveActed && doctorActed) {
      this.log('night', 'All roles acted → resolveNight()')
      if (this.nightTimeout) { clearTimeout(this.nightTimeout); this.nightTimeout = null }
      this.resolveNight()
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
        // voter = VoiceAgent name passed via handleGeminiCommand caller, or detect from player list
        const voterName = cmd.voter || cmd.player
        const voter = voterName
          ? findAliveByName(voterName)
          : this.state.players.find((p) => p.role === 'mafia' && p.status === 'alive')
        if (!target || !voter || voter.role !== 'mafia') break
        if (voter.id === target.id) break
        this.log('night', `${voter.name} → kill → ${target.name}`)
        this.mafiaVotes.set(voter.id, target.id)
        this.checkAllNightActionsComplete()
        break
      }

      case 'investigate': {
        if (this.state.phase !== 'night' || this.detectiveTarget !== null) break
        const target = findAliveByName(cmd.target)
        if (!target) break
        this.log('night', `Detective → investigate → ${target.name}`)
        this.detectiveTarget = target.id
        this.checkAllNightActionsComplete()
        break
      }

      case 'doctor_save': {
        if (this.state.phase !== 'night' || this.doctorTarget !== null) break
        const target = findAliveByName(cmd.target)
        if (!target) break
        this.log('night', `Doctor → save → ${target.name}`)
        this.doctorTarget = target.id
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
    this.pendingPhaseTransition = null
    this.mafiaVotes.clear()
    this.detectiveTarget = null
    this.doctorTarget = null
    this.log('phase', `→ NIGHT ${this.state.day}`)
    this.state.phase = 'night'
    this.broadcastEvent({ type: 'phase_changed', phase: 'night', state: this.getPublicState() })

    this.bridge?.sendText(
      `[SYSTEM] Night ${this.state.day} begins. Narrate the town falling asleep (2-3 atmospheric sentences). Keep it short and dramatic. Then go silent.`
    )

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

    // 3. Detective gets investigation result (even if target is killed this turn)
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

    // 6. Transition (eliminatePlayer may have ended the game)
    if (this.state.phase !== 'game_over') {
      this.startDay(killedId, doctorSaved)
    }
  }

  startDay(eliminatedId: string | null, doctorSaved: boolean = false) {
    this.resolving = false
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
          ? `[SYSTEM] ${eliminatedPlayer.name} was eliminated. They were ${eliminatedPlayer.role}. Announce this dramatically (2-3 sentences), then stop.`
          : `[SYSTEM] No one was eliminated. Announce this briefly, then stop.`
      )
      // Wait for narrator to finish announcement, then start night
      this.pendingPhaseTransition = () => {
        if (this.state.phase !== 'game_over') this.startNight()
      }
      // Fallback
      setTimeout(() => {
        if (this.pendingPhaseTransition && this.state.phase !== 'game_over') {
          this.pendingPhaseTransition = null
          this.startNight()
        }
      }, 15_000)
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

// Player
export type Role = 'mafia' | 'civilian' | 'detective' | 'doctor'
export type PlayerStatus = 'alive' | 'dead'

export interface Player {
  id: string
  name: string
  role: Role
  status: PlayerStatus
  isConnected: boolean
}

// Game
export type Phase =
  | 'lobby'
  | 'role_assignment'
  | 'night'
  | 'day'
  | 'voting'
  | 'game_over'

export interface GameState {
  roomId: string
  phase: Phase
  players: Player[]
  day: number
  winner: 'mafia' | 'civilians' | null
  currentSpeakerId: string | null
  voiceAgentIds: string[]
  activeVoiceAgentId: string | null
  agentsMuted: boolean
  selectedAgentIds: string[]
}

// WebSocket Events — Server → Client
export type ServerEvent =
  | { type: 'room_joined'; playerId: string; state: GameState; fishjamToken?: string }
  | { type: 'game_started'; state: GameState }
  | { type: 'role_assigned'; role: Role }
  | { type: 'phase_changed'; phase: Phase; state: GameState }
  | { type: 'player_eliminated'; playerId: string; role: Role }
  | { type: 'vote_cast'; fromId: string; targetId: string }
  | { type: 'vote_result'; eliminatedId: string | null; votes: Record<string, string> }
  | { type: 'speaker_changed'; speakerId: string | null }
  | { type: 'game_over'; winner: 'mafia' | 'civilians'; state: GameState }
  | { type: 'night_action_prompt'; role: Role }
  | { type: 'night_action_received' }
  | { type: 'investigation_result'; targetName: string; targetRole: Role }
  | { type: 'transcript'; speaker: 'gemini' | 'player'; text: string; playerName?: string }
  | { type: 'transcript_clear' }
  | { type: 'suspicion_update'; playerId: string; playerName: string; score: number; reason: string }
  | { type: 'behavioral_note'; playerName: string; note: string }
  | { type: 'stress_alert'; playerId: string; playerName: string; level: number }
  | { type: 'bot_speech'; playerName: string; playerId: string; message: string }
  | { type: 'agent_mute_changed'; activeAgentId: string | null }
  | { type: 'agents_mute_changed'; muted: boolean }
  | { type: 'agent_selection_changed'; selectedAgentIds: string[] }
  | { type: 'error'; message: string }

// Room listing
export interface RoomInfo {
  roomId: string
  playerCount: number
  phase: Phase
}

// WebSocket Events — Client → Server
export type ClientEvent =
  | { type: 'join_room'; roomId: string; playerName: string }
  | { type: 'start_game' }
  | { type: 'start_voting' }
  | { type: 'cast_vote'; targetId: string }
  | { type: 'night_action'; targetId: string }
  | { type: 'text_command'; text: string }
  | { type: 'face_metrics'; stress: number; surprise: number; happiness: number; lookingAway: boolean }
  | { type: 'add_voice_agent' }
  | { type: 'set_active_agent'; agentId: string | null }
  | { type: 'set_agents_muted'; muted: boolean }
  | { type: 'set_agent_selected'; agentId: string; selected: boolean }

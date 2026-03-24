import { create } from 'zustand'
import type { GameState, Role } from '@mafia-ai/types'

interface GameStore {
  roomId: string | null
  playerId: string | null
  playerName: string | null
  myRole: Role | null
  gameState: GameState | null
  fishjamToken: string | null
  lastTranscript: { speaker: 'gemini' | 'player'; text: string } | null
  playerTranscripts: Record<string, string>
  votes: Record<string, string>
  suspicions: Record<string, { score: number; reason: string }>
  behavioralNotes: Array<{ playerName: string; note: string; timestamp: number }>
  faceMetrics: { stress: number; surprise: number; happiness: number; lookingAway: boolean } | null
  currentSpeakerId: string | null
  isNarratorSpeaking: boolean
  investigationResult: { targetName: string; targetRole: Role } | null
  activeVoiceAgentId: string | null

  setRoomId: (id: string) => void
  setPlayerId: (id: string) => void
  setPlayerName: (name: string) => void
  setMyRole: (role: Role) => void
  setGameState: (state: GameState) => void
  setFishjamToken: (token: string) => void
  setLastTranscript: (t: { speaker: 'gemini' | 'player'; text: string }) => void
  appendGeminiTranscript: (text: string) => void
  clearTranscript: () => void
  appendPlayerTranscript: (playerName: string, text: string) => void
  clearPlayerTranscript: (playerName: string) => void
  addVote: (fromId: string, targetId: string) => void
  clearVotes: () => void
  updateSuspicion: (playerId: string, score: number, reason: string) => void
  addBehavioralNote: (playerName: string, note: string) => void
  setFaceMetrics: (m: { stress: number; surprise: number; happiness: number; lookingAway: boolean }) => void
  setCurrentSpeaker: (id: string | null) => void
  setNarratorSpeaking: (val: boolean) => void
  setInvestigationResult: (r: { targetName: string; targetRole: Role } | null) => void
  setActiveVoiceAgent: (id: string | null) => void
  reset: () => void
}

export const useGameStore = create<GameStore>((set) => ({
  roomId: null,
  playerId: null,
  playerName: null,
  myRole: null,
  gameState: null,
  fishjamToken: null,
  lastTranscript: null,
  playerTranscripts: {},
  votes: {},
  suspicions: {},
  behavioralNotes: [],
  faceMetrics: null,
  currentSpeakerId: null,
  isNarratorSpeaking: false,
  investigationResult: null,
  activeVoiceAgentId: null,

  setRoomId: (roomId) => set({ roomId }),
  setPlayerId: (playerId) => set({ playerId }),
  setPlayerName: (playerName) => set({ playerName }),
  setMyRole: (myRole) => set({ myRole }),
  setGameState: (gameState) => set({ gameState }),
  setFishjamToken: (fishjamToken) => set({ fishjamToken }),
  setLastTranscript: (lastTranscript) => set({ lastTranscript }),
  appendGeminiTranscript: (text) => set((state) => {
    const current = state.lastTranscript?.speaker === 'gemini' ? state.lastTranscript.text : ''
    return { lastTranscript: { speaker: 'gemini', text: current ? current + ' ' + text : text } }
  }),
  clearTranscript: () => set({ lastTranscript: null }),
  appendPlayerTranscript: (playerName, text) => set((state) => {
    const current = state.playerTranscripts[playerName] ?? ''
    return { playerTranscripts: { ...state.playerTranscripts, [playerName]: current ? current + text : text } }
  }),
  clearPlayerTranscript: (playerName) => set((state) => {
    const next = { ...state.playerTranscripts }
    delete next[playerName]
    return { playerTranscripts: next }
  }),
  addVote: (fromId, targetId) => set((state) => ({ votes: { ...state.votes, [fromId]: targetId } })),
  clearVotes: () => set({ votes: {} }),
  updateSuspicion: (playerId, score, reason) => set((state) => ({
    suspicions: { ...state.suspicions, [playerId]: { score, reason } }
  })),
  addBehavioralNote: (playerName, note) => set((state) => ({
    behavioralNotes: [...state.behavioralNotes.slice(-20), { playerName, note, timestamp: Date.now() }]
  })),
  setFaceMetrics: (faceMetrics) => set({ faceMetrics }),
  setCurrentSpeaker: (currentSpeakerId) => set({ currentSpeakerId }),
  setNarratorSpeaking: (isNarratorSpeaking) => set({ isNarratorSpeaking }),
  setInvestigationResult: (investigationResult) => set({ investigationResult }),
  setActiveVoiceAgent: (activeVoiceAgentId) => set({ activeVoiceAgentId }),
  reset: () => set({ roomId: null, playerId: null, playerName: null, myRole: null, gameState: null, fishjamToken: null, lastTranscript: null, playerTranscripts: {}, votes: {}, suspicions: {}, behavioralNotes: [], faceMetrics: null, currentSpeakerId: null, isNarratorSpeaking: false, investigationResult: null, activeVoiceAgentId: null }),
}))

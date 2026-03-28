import { useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useConnection, usePeers, useCamera, useMicrophone, useInitializeDevices } from '@fishjam-cloud/react-client'
import { useGameStore, useGameSocket, useFaceAnalysis, useAudioPipeline } from '@/entities/game'
import { RoleCard } from '@/entities/player'
import { PhaseOverlay } from '@/widgets/phase-overlay'
import { VideoGrid } from '@/widgets/video-grid'
import { GameOver } from '@/widgets/game-over'
import { AiAnalysis } from '@/widgets/ai-analysis'
import { Countdown } from '@/widgets/countdown'
import { VoteTracker } from '@/widgets/vote-tracker'
import { NightPanel } from '@/features/night-action'
import { VotePanel } from '@/features/vote'
import { StartButton } from '@/features/start-game'
import { VictoryConfetti, NightShaderOverlay } from '@/widgets/gpu-effects'
import type { Phase } from '@mafia-ai/types'

const PHASE_DURATIONS: Partial<Record<Phase, number>> = {
  night: 45,
  day: 80,
  voting: 40,
}

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const { playerId, playerName, myRole, gameState, fishjamToken, lastTranscript } = useGameStore()
  const isNarratorSpeaking = useGameStore((s) => s.isNarratorSpeaking)
  const investigationResult = useGameStore((s) => s.investigationResult)
  const agentsMuted = useGameStore((s) => s.agentsMuted)
  const selectedAgentIds = useGameStore((s) => s.selectedAgentIds)
  const nightActionWindowOpen = useGameStore((s) => s.nightActionWindowOpen)
  const { send, wsRef, setOnBinary } = useGameSocket()
  const { playAudio } = useAudioPipeline(wsRef)
  const { metrics: faceMetrics, setVideoElement, startAnalysis, stopAnalysis, onMetrics } = useFaceAnalysis()

  // Fishjam hooks
  const { joinRoom, peerStatus } = useConnection()
  const { localPeer, remotePeers } = usePeers()
  const { startCamera } = useCamera()
  const { startMicrophone, toggleMicrophoneMute, isMicrophoneMuted } = useMicrophone()
  const { initializeDevices } = useInitializeDevices()

  const fishjamJoinInitiated = useRef(false)
  const autoMutedRef = useRef(false)

  // Register WebSocket binary handler for Game Master audio
  useEffect(() => {
    setOnBinary(playAudio)
  }, [setOnBinary, playAudio])

  // Single effect managing mic mute state — never includes isMicrophoneMuted as dep
  // to avoid infinite loops when toggleMicrophoneMute triggers a re-render.
  useEffect(() => {
    const phase = gameState?.phase
    if (!phase) return

    // Desired state: muted unless we're in an action window
    const shouldBeMuted = (phase === 'role_assignment' || phase === 'night') && !nightActionWindowOpen

    if (shouldBeMuted && !isMicrophoneMuted) {
      toggleMicrophoneMute()
    } else if (!shouldBeMuted && isMicrophoneMuted && autoMutedRef.current) {
      toggleMicrophoneMute()
    }

    autoMutedRef.current = shouldBeMuted
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.phase, nightActionWindowOpen])

  // Redirect to lobby if no playerName (direct URL navigation)
  useEffect(() => {
    if (!playerName) {
      navigate('/')
    }
  }, [playerName, navigate])

  // Join game room via WebSocket
  useEffect(() => {
    if (roomId && playerName && !playerId) {
      send({ type: 'join_room', roomId, playerName })
    }
  }, [roomId, playerName, playerId, send])

  // Join Fishjam room when token is received — only re-run when token changes
  useEffect(() => {
    if (!fishjamToken || fishjamJoinInitiated.current) return
    fishjamJoinInitiated.current = true

    initializeDevices({})
      .then(() =>
        joinRoom({
          peerToken: fishjamToken,
          peerMetadata: { name: playerName },
        })
      )
      .then(() => {
        startCamera()
        startMicrophone()
      })
      .catch((err) => {
        console.error('Fishjam setup failed:', err)
        fishjamJoinInitiated.current = false
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fishjamToken])

  // Audio now goes through Fishjam Agent — no manual mic/playback needed

  // After Fishjam camera starts, set up face analysis
  useEffect(() => {
    if (localPeer?.cameraTrack?.stream) {
      // Create a hidden video element for MediaPipe analysis
      const video = document.createElement('video')
      video.srcObject = localPeer.cameraTrack.stream
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      video.play()
      setVideoElement(video)
      startAnalysis()

      return () => {
        stopAnalysis()
        video.srcObject = null
        setVideoElement(null)
      }
    }
  }, [localPeer?.cameraTrack?.stream, setVideoElement, startAnalysis, stopAnalysis])

  // Forward face metrics to server + store locally
  useEffect(() => {
    const { setFaceMetrics } = useGameStore.getState()
    onMetrics((m) => {
      setFaceMetrics(m)
      send({
        type: 'face_metrics',
        stress: m.stress,
        surprise: m.surprise,
        happiness: m.happiness,
        lookingAway: m.lookingAway,
      })
    })
  }, [onMetrics, send])

  if (!playerName) {
    return null
  }

  if (!gameState) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0a0a1a] text-white">
        Connecting...
      </div>
    )
  }

  const isLobby = gameState.phase === 'lobby'
  const isVoting = gameState.phase === 'voting'
  const isNight = gameState.phase === 'night'
  const isGameOver = gameState.phase === 'game_over'
  const myPlayer = gameState.players.find((p) => p.id === playerId)
  const isAlive = myPlayer?.status === 'alive'

  return (
    <div className={`min-h-screen text-white font-[system-ui,sans-serif] transition-[background] duration-1000 ${isNight ? 'bg-[#05051a]' : 'bg-[#0a0a1a]'}`}>
      <PhaseOverlay phase={gameState.phase} />
      <NightShaderOverlay isNight={isNight} />
      <VictoryConfetti winner={isGameOver ? gameState.winner : null} />

      <div className="max-w-[900px] mx-auto pt-[60px] px-5 pb-5">
        {/* Room header */}
        <div className="flex justify-between items-center mb-5">
          <div>
            <span className="text-[#888] text-[0.85rem]">Room: </span>
            <span className="text-white font-bold">{gameState.roomId}</span>
          </div>
          <div className="text-[#888] text-[0.85rem]">
            Day {gameState.day} · {gameState.players.filter((p) => p.status === 'alive').length} alive
            {peerStatus === 'connected' && ' · Video connected'}
          </div>
        </div>

        {/* Role display */}
        {myRole && (
          <div className="flex justify-center mb-5">
            <RoleCard role={myRole} />
          </div>
        )}

        {/* Status bar: subtitles + mic + phase hint */}
        {!isLobby && (
          <div className="mb-4 space-y-3">
            {/* Live subtitles */}
            <div className="bg-black/60 rounded-lg px-4 py-3 min-h-[48px] flex items-center">
              {lastTranscript?.speaker === 'gemini' ? (
                <p className="text-sm text-amber-400 flex items-center gap-2">
                  {isNarratorSpeaking && <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse flex-shrink-0" />}
                  <span><span className="font-bold">Game Master:</span>{' '}{lastTranscript.text}</span>
                </p>
              ) : (
                <p className="text-sm text-[#555] italic">Listening...</p>
              )}
            </div>

            {/* Phase hint + face tracking + mic */}
            <div className="flex items-center justify-between">
              <div className="text-xs text-[#888] flex items-center gap-3">
                <span>
                  {isNight && myRole === 'mafia' && 'Mafia turn — choose who to eliminate'}
                  {isNight && myRole === 'detective' && 'Detective turn — choose who to investigate'}
                  {isNight && myRole === 'doctor' && 'Doctor turn — choose who to save'}
                  {isNight && myRole === 'civilian' && 'Night — wait for dawn...'}
                  {gameState.phase === 'day' && 'Day — discuss and find the mafia!'}
                  {isVoting && 'Voting — choose who to eliminate!'}
                </span>
                {faceMetrics && (
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                    <span className={faceMetrics.stress > 0.3 ? 'text-red-400' : 'text-[#666]'}>
                      Stress {(faceMetrics.stress * 100).toFixed(0)}%
                    </span>
                    <span className={faceMetrics.surprise > 0.3 ? 'text-yellow-400' : 'text-[#666]'}>
                      Surprise {(faceMetrics.surprise * 100).toFixed(0)}%
                    </span>
                    {faceMetrics.lookingAway && (
                      <span className="text-orange-400">Looking away</span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {gameState.voiceAgentIds.length > 0 && (() => {
                  const locked = gameState.phase === 'night' || gameState.phase === 'role_assignment'
                  const agentPlayers = gameState.players.filter(p => gameState.voiceAgentIds.includes(p.id))
                  return (
                    <>
                      <button
                        disabled={locked}
                        onClick={() => !locked && send({ type: 'set_agents_muted', muted: !agentsMuted })}
                        className={`px-3 py-1.5 rounded-full font-bold text-xs transition-all duration-200 ${
                          locked
                            ? 'bg-gray-700/80 text-gray-400 cursor-not-allowed'
                            : agentsMuted
                              ? 'bg-red-600/80 hover:bg-red-600 text-white'
                              : 'bg-purple-600/80 hover:bg-purple-600 text-white'
                        }`}
                        title={locked ? 'AI agents are always muted in this phase' : agentsMuted ? 'Unmute AI agents' : 'Mute AI agents'}
                      >
                        {locked ? 'AI MUTED' : agentsMuted ? 'AI OFF' : 'AI ON'}
                      </button>
                      {agentPlayers.map(agent => {
                        const isSelected = selectedAgentIds.includes(agent.id)
                        const isOnlyOne = selectedAgentIds.length <= 1 && isSelected
                        const disabled = locked || agentsMuted || isOnlyOne
                        return (
                          <button
                            key={agent.id}
                            disabled={disabled}
                            onClick={() => !disabled && send({ type: 'set_agent_selected', agentId: agent.id, selected: !isSelected })}
                            className={`px-3 py-1.5 rounded-full font-bold text-xs transition-all duration-200 ${
                              (locked || agentsMuted)
                                ? 'bg-gray-700/60 text-gray-500 cursor-not-allowed'
                                : isSelected
                                  ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white cursor-not-allowed'
                                  : 'bg-gray-600/80 hover:bg-gray-500/80 text-gray-300'
                            }`}
                            title={isOnlyOne ? 'At least one agent must be active' : isSelected ? `Mute ${agent.name}` : `Unmute ${agent.name}`}
                          >
                            {agent.name}
                          </button>
                        )
                      })}
                    </>
                  )
                })()}
                <button
                  onClick={() => !isNarratorSpeaking && toggleMicrophoneMute()}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-xs transition-all duration-200 ${
                    isNarratorSpeaking
                      ? 'bg-indigo-600/80 text-white cursor-not-allowed'
                      : isMicrophoneMuted
                        ? 'bg-red-600/80 hover:bg-red-600 text-white'
                        : 'bg-green-600/80 hover:bg-green-600 text-white animate-pulse'
                  }`}
                >
                  {isNarratorSpeaking ? 'NARRATOR' : isMicrophoneMuted ? 'MIC OFF' : 'LIVE'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Countdown timer */}
        {!isLobby && PHASE_DURATIONS[gameState.phase] && (
          <Countdown
            duration={PHASE_DURATIONS[gameState.phase]!}
            phase={gameState.phase}
            paused={isNarratorSpeaking}
          />
        )}

        {/* Video grid */}
        <VideoGrid
          players={gameState.players}
          playerId={playerId}
          playerName={playerName}
          localPeer={localPeer}
          remotePeers={remotePeers}
        />

        {/* AI Analysis panel */}
        {(gameState.phase === 'day' || isVoting) && (
          <AiAnalysis />
        )}

        {/* Night panel — shown only after narrator finishes speaking */}
        {isNight && isAlive && !isNarratorSpeaking && (
          <NightPanel />
        )}

        {/* Detective investigation result */}
        {myRole === 'detective' && investigationResult && (
          <div className="mb-5 p-4 bg-[#1a1a2e] rounded-xl border-2 border-purple-700 text-center">
            <p className="text-purple-300 text-xs font-bold uppercase tracking-wider mb-1">Investigation Result</p>
            <p className="text-white text-sm">
              <span className="font-bold">{investigationResult.targetName}</span> is{' '}
              <span className={`font-bold ${investigationResult.targetRole === 'mafia' ? 'text-red-400' : 'text-green-400'}`}>
                {investigationResult.targetRole}
              </span>
            </p>
          </div>
        )}

        {/* Lobby: add bots + start */}
        {isLobby && (
          <div className="flex flex-col items-center gap-3 mt-5">
            {(() => {
              const agentCount = gameState.voiceAgentIds?.length ?? 0
              const atLimit = agentCount >= 3
              return (
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => send({ type: 'add_voice_agent' })}
                    disabled={atLimit}
                    className={`px-6 py-2.5 rounded-lg font-bold transition-colors ${
                      atLimit
                        ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    }`}
                  >
                    {atLimit ? 'AI Agent Limit Reached (3/3)' : `+ Add Voice Agent (${agentCount}/3)`}
                  </button>
                  {agentCount > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => send({ type: 'set_agents_muted', muted: !agentsMuted })}
                        className={`px-4 py-2 rounded-lg font-bold text-xs transition-colors ${
                          agentsMuted
                            ? 'bg-red-600/80 hover:bg-red-600 text-white'
                            : 'bg-purple-600/80 hover:bg-purple-600 text-white'
                        }`}
                        title={agentsMuted ? 'Unmute AI agents' : 'Mute AI agents'}
                      >
                        {agentsMuted ? 'AI OFF' : 'AI ON'}
                      </button>
                      {gameState.players.filter(p => gameState.voiceAgentIds.includes(p.id)).map(agent => {
                        const isSelected = selectedAgentIds.includes(agent.id)
                        const isOnlyOne = selectedAgentIds.length <= 1 && isSelected
                        const disabled = agentsMuted || isOnlyOne
                        return (
                          <button
                            key={agent.id}
                            disabled={disabled}
                            onClick={() => !disabled && send({ type: 'set_agent_selected', agentId: agent.id, selected: !isSelected })}
                            className={`px-3 py-2 rounded-lg font-bold text-xs transition-colors ${
                              agentsMuted
                                ? 'bg-gray-700/60 text-gray-500 cursor-not-allowed'
                                : isSelected
                                  ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white cursor-not-allowed'
                                  : 'bg-gray-600/80 hover:bg-gray-500/80 text-gray-300'
                            }`}
                            title={isOnlyOne ? 'At least one agent must be active' : isSelected ? `Mute ${agent.name}` : `Unmute ${agent.name}`}
                          >
                            {agent.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}
            <StartButton
              playerCount={gameState.players.length}
              minPlayers={4}
              onStart={() => send({ type: 'start_game' })}
            />
          </div>
        )}

        {/* Vote tracker */}
        {isVoting && (
          <VoteTracker players={gameState.players} />
        )}

        {/* Voting panel */}
        {isVoting && isAlive && (
          <div className="max-w-[400px] mx-auto my-5">
            <VotePanel />
          </div>
        )}

        {/* Game over */}
        {isGameOver && gameState.winner && (
          <GameOver winner={gameState.winner} players={gameState.players} />
        )}
      </div>
    </div>
  )
}

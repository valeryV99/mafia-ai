import { useParams, useNavigate } from 'react-router-dom'
import { useGameStore, useGameSocket, useFaceAnalysis, useAudioPipeline } from '@/entities/game'
import { PHASE_DURATIONS } from '@/entities/game/config/phaseDurations'
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
import {VictoryConfetti, GpuErrorBoundary, NightShaderOverlay} from '@/widgets/gpu-effects'
import { RoomHeader } from '@/widgets/room-header'
import { RoomInGameStatusBar } from '@/widgets/room-status-bar'
import { InvestigationResultCard } from '@/widgets/investigation-result'
// import { LobbyVoiceSetup } from '@/widgets/lobby-voice-setup'
import { RoomShell, RoomContent } from '@/widgets/room-shell'
import { useGameMasterAudioBinary } from '../model/useGameMasterAudioBinary'
import { useRedirectIfNoPlayerName } from '../model/useRedirectIfNoPlayerName'
import { useSocketJoinRoom } from '../model/useSocketJoinRoom'
import { useFishjamMediaSession } from '../model/useFishjamMediaSession'
import { usePhaseMicAutoMute } from '../model/usePhaseMicAutoMute'
import { useFaceAnalysisForLocalCamera } from '../model/useFaceAnalysisForLocalCamera'
import { useFaceMetricsToServer } from '../model/useFaceMetricsToServer'

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

  const { peerStatus, localPeer, remotePeers, toggleMicrophoneMute, isMicrophoneMuted, cameraStream } =
    useFishjamMediaSession(fishjamToken, playerName)

  useGameMasterAudioBinary(setOnBinary, playAudio)

  // Audio to Game Master goes through Fishjam SFU (trackData with native peerId speaker identification)
  useRedirectIfNoPlayerName(playerName, navigate)
  useSocketJoinRoom(roomId, playerName, playerId, send)
  usePhaseMicAutoMute(gameState?.phase, nightActionWindowOpen, isMicrophoneMuted, toggleMicrophoneMute)
  useFaceAnalysisForLocalCamera(localPeer, setVideoElement, startAnalysis, stopAnalysis)
  useFaceMetricsToServer(onMetrics, send)

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
  const phaseLocked = gameState.phase === 'night' || gameState.phase === 'role_assignment'

  const toggleAgentsMuted = () => send({ type: 'set_agents_muted', muted: !agentsMuted })
  const toggleAgentSelected = (agentId: string, selected: boolean) =>
    send({ type: 'set_agent_selected', agentId, selected })

  const handleMicToggle = () => {
    toggleMicrophoneMute()
  }

  return (
    <RoomShell isNight={isNight}>
      {/* Mic mute button — fixed top-right */}
      <button
        type="button"
        onClick={handleMicToggle}
        className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-full font-bold text-sm transition-all duration-200 ${
          isMicrophoneMuted
            ? 'bg-red-600 hover:bg-red-700 text-white'
            : 'bg-green-600 hover:bg-green-700 text-white animate-pulse'
        }`}
      >
        {isMicrophoneMuted ? '🔇 MIC OFF' : '🎤 MIC ON'}
      </button>

      <PhaseOverlay phase={gameState.phase} />
      <GpuErrorBoundary>
        <NightShaderOverlay isNight={isNight} />
        <VictoryConfetti winner={isGameOver ? gameState.winner : null} />
      </GpuErrorBoundary>

      <RoomContent>
        <RoomHeader gameState={gameState} peerStatus={peerStatus} />

        {myRole && (
          <div className="flex justify-center mb-5">
            <RoleCard role={myRole} />
          </div>
        )}

        {!isLobby && (
          <RoomInGameStatusBar
            phase={gameState.phase}
            myRole={myRole}
            lastTranscript={lastTranscript}
            isNarratorSpeaking={isNarratorSpeaking}
            faceMetrics={faceMetrics}
            voiceAgentIds={gameState.voiceAgentIds}
            players={gameState.players}
            agentsMuted={agentsMuted}
            selectedAgentIds={selectedAgentIds}
            phaseLocked={phaseLocked}
            isMicrophoneMuted={isMicrophoneMuted}
            onToggleAgentsMuted={toggleAgentsMuted}
            onToggleAgentSelected={toggleAgentSelected}
            onToggleMicrophoneMute={toggleMicrophoneMute}
          />
        )}

        {!isLobby && PHASE_DURATIONS[gameState.phase] && (
          <Countdown
            duration={PHASE_DURATIONS[gameState.phase]!}
            phase={gameState.phase}
            paused={isNarratorSpeaking}
          />
        )}

        <VideoGrid
          players={gameState.players}
          playerId={playerId}
          playerName={playerName}
          localPeer={localPeer}
          remotePeers={remotePeers}
          localCameraStream={cameraStream}
        />

        {(gameState.phase === 'day' || isVoting) && <AiAnalysis />}

        {isNight && isAlive && !isNarratorSpeaking && (
          <NightPanel onAction={(targetId) => send({ type: 'night_action', targetId })} />
        )}

        {myRole === 'detective' && investigationResult && (
          <InvestigationResultCard
            targetName={investigationResult.targetName}
            targetRole={investigationResult.targetRole}
          />
        )}

        {isLobby && (
          <div className="flex flex-col items-center gap-3 mt-5">
            {/* AI voice agents deactivated for hackathon demo — humans-only mode */}
            <StartButton
              playerCount={gameState.players.length}
              minPlayers={4}
              onStart={() => send({ type: 'start_game' })}
            />
          </div>
        )}

        {isVoting && <VoteTracker players={gameState.players} />}

        {isVoting && isAlive && (
          <div className="max-w-[400px] mx-auto my-5">
            <VotePanel />
          </div>
        )}

        {isGameOver && gameState.winner && (
          <GameOver winner={gameState.winner} players={gameState.players} />
        )}
      </RoomContent>
    </RoomShell>
  )
}

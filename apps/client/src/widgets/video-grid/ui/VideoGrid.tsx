import { useEffect, useRef } from 'react'
import type { Player } from '@mafia-ai/types'
import type { PeerWithTracks } from '@fishjam-cloud/react-client'
import { VideoTile } from '@/entities/player'
import { useGameStore } from '@/entities/game'

type Peer = PeerWithTracks<Record<string, unknown>, Record<string, unknown>>

function getPeerName(peer: Peer): string {
  const meta = peer.metadata as any
  return meta?.peer?.name || meta?.name || ''
}

function AudioPlayer({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = stream
    }
    return () => {
      if (audioRef.current) {
        audioRef.current.srcObject = null
      }
    }
  }, [stream])
  return <audio ref={audioRef} autoPlay playsInline className="hidden" />
}

interface VideoGridProps {
  players: Player[]
  playerId: string | null
  playerName: string | null
  localPeer: Peer | null
  remotePeers: Peer[]
}

export function VideoGrid({ players, playerId, playerName, localPeer, remotePeers }: VideoGridProps) {
  const suspicions = useGameStore((s) => s.suspicions)
  const currentSpeakerId = useGameStore((s) => s.currentSpeakerId)
  const playerTranscripts = useGameStore((s) => s.playerTranscripts)

  // Build a map: playerName → Fishjam stream
  const streamByName = new Map<string, MediaStream | null>()
  const audioByName = new Map<string, MediaStream | null>()

  if (localPeer && playerName) {
    streamByName.set(playerName, localPeer.cameraTrack?.stream ?? null)
  }
  for (const peer of remotePeers) {
    const name = getPeerName(peer)
    if (name) {
      streamByName.set(name, peer.cameraTrack?.stream ?? null)
      if (peer.microphoneTrack?.stream) {
        audioByName.set(name, peer.microphoneTrack.stream)
      }
    }
  }

  // Play ALL remote peers' audio (including Fishjam Agent = AI voice)
  const allAudioStreams: MediaStream[] = []
  for (const peer of remotePeers) {
    // Check all tracks — agent uses custom tracks, not microphoneTrack
    for (const track of peer.tracks) {
      if (track.stream) allAudioStreams.push(track.stream)
    }
  }

  // Render one tile per game player — no duplicates possible
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 mb-5">
      {/* Hidden audio players for ALL remote peers (including AI agent) */}
      {allAudioStreams.map((stream, i) => (
        <AudioPlayer key={`audio-${i}`} stream={stream} />
      ))}

      {players.map((player) => {
        const isYou = player.id === playerId
        const stream = streamByName.get(player.name) ?? null

        return (
          <div key={player.id}>
            <VideoTile
              stream={stream}
              name={player.name}
              isYou={isYou}
              isDead={player.status === 'dead'}
              suspicion={suspicions[player.id]}
              isSpeaking={player.id === currentSpeakerId}
              transcript={playerTranscripts[player.name]}
            />
          </div>
        )
      })}
    </div>
  )
}

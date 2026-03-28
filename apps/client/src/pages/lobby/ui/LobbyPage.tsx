import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore } from '@/entities/game'
import { JoinForm } from '@/features/join-game'
import type { RoomInfo } from '@mafia-ai/types'

const SERVER_URL = import.meta.env.VITE_SERVER_WS_URL
  ? import.meta.env.VITE_SERVER_WS_URL.replace(/^ws/, 'http').replace('/ws', '')
  : 'http://localhost:3001'

const PHASE_LABEL: Record<string, string> = {
  lobby: 'Waiting',
  role_assignment: 'Starting',
  night: 'Night',
  day: 'Day',
  voting: 'Voting',
  game_over: 'Ended',
}

export function LobbyPage() {
  const navigate = useNavigate()
  const { setRoomId, setPlayerName } = useGameStore()
  const [rooms, setRooms] = useState<RoomInfo[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchRooms = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/active-rooms`)
        if (!res.ok) return
        const data: RoomInfo[] = await res.json()
        if (!cancelled) setRooms(data)
      } catch {
        // server may not be reachable yet
      }
    }

    fetchRooms()
    const interval = setInterval(fetchRooms, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const handleJoin = (name: string, roomId: string) => {
    setRoomId(roomId)
    setPlayerName(name)
    navigate(`/room/${roomId}`)
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#0a0a1a] text-white font-[system-ui,sans-serif]">
      <h1 className="text-5xl mb-2 font-bold">AI Mafia</h1>
      <p className="text-[#888] mb-10">Powered by Gemini Live</p>
      <JoinForm onJoin={handleJoin} prefillRoomId={selectedRoomId ?? ''} />

      {rooms.length > 0 && (
        <div className="mt-10 w-[300px]">
          <p className="text-[#888] text-sm mb-3 uppercase tracking-widest">Active Rooms</p>
          <div className="flex flex-col gap-2">
            {rooms.map((room) => (
              <button
                key={room.roomId}
                onClick={() => setSelectedRoomId(room.roomId)}
                className={`flex items-center justify-between px-4 py-3 rounded-lg border text-left transition-colors ${
                  selectedRoomId === room.roomId
                    ? 'border-white bg-white/10'
                    : 'border-white/20 bg-white/5 hover:bg-white/10 hover:border-white/40'
                }`}
              >
                <span className="font-mono text-sm text-white">{room.roomId}</span>
                <span className="flex items-center gap-3 text-sm">
                  <span className="text-[#888]">{room.playerCount} player{room.playerCount !== 1 ? 's' : ''}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      room.phase === 'lobby'
                        ? 'bg-green-900/60 text-green-400'
                        : room.phase === 'game_over'
                          ? 'bg-gray-700 text-gray-400'
                          : 'bg-yellow-900/60 text-yellow-400'
                    }`}
                  >
                    {PHASE_LABEL[room.phase] ?? room.phase}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { useGameStore } from '@/entities/game'

const SERVER_URL = import.meta.env.VITE_SERVER_WS_URL
  ? import.meta.env.VITE_SERVER_WS_URL.replace(/^ws/, 'http').replace('/ws', '')
  : 'http://localhost:3001'

export function AddAiPlayerButton() {
  const roomId = useGameStore((s) => s.roomId)
  const [loading, setLoading] = useState(false)
  const [added, setAdded] = useState(false)

  const handleAddAiPlayer = async () => {
    if (!roomId || loading || added) return
    setLoading(true)
    try {
      const res = await fetch(`${SERVER_URL}/rooms/${roomId}/voice-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Gemini',
          persona: 'The Skeptic — analytical, always questions motives, demands hard evidence before trusting anyone',
          voice: 'Puck',
        }),
      })
      const data = await res.json()
      if (data.added) {
        setAdded(true)
        console.log(`[AI] Voice agent "${data.name}" joined the game`)
      } else {
        console.error('[AI] Failed to add voice agent:', data.error)
      }
    } catch (err) {
      console.error('[AI] Request failed:', err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleAddAiPlayer}
      disabled={loading || added}
      className={`px-6 py-2.5 rounded-lg font-bold transition-colors ${
        added
          ? 'bg-green-700 text-white cursor-default'
          : loading
            ? 'bg-blue-800 text-white/60 cursor-wait'
            : 'bg-blue-600 hover:bg-blue-700 text-white'
      }`}
    >
      {added ? '✓ AI Player Added' : loading ? 'Adding...' : '+ Add AI Player'}
    </button>
  )
}

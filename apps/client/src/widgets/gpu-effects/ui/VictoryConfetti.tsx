import { useEffect, useRef } from 'react'
import { Confetti } from 'typegpu-confetti/react'
import type { ConfettiRef } from 'typegpu-confetti'

interface VictoryConfettiProps {
  winner: 'mafia' | 'civilians' | null
}

const MAFIA_COLORS: [number, number, number, number][] = [
  [220, 38, 38, 255],
  [185, 28, 28, 255],
  [239, 68, 68, 255],
  [127, 29, 29, 255],
  [255, 255, 255, 255],
]

const CIVILIAN_COLORS: [number, number, number, number][] = [
  [255, 215, 0, 255],
  [59, 130, 246, 255],
  [34, 197, 94, 255],
  [255, 255, 255, 255],
  [168, 85, 247, 255],
]

export function VictoryConfetti({ winner }: VictoryConfettiProps) {
  const confettiRef = useRef<ConfettiRef>(null)

  useEffect(() => {
    if (winner && confettiRef.current) {
      confettiRef.current.addParticles(300)
      const timer = setTimeout(() => confettiRef.current?.addParticles(200), 800)
      return () => clearTimeout(timer)
    }
  }, [winner])

  if (!navigator.gpu || !winner) return null

  return (
    <Confetti
      ref={confettiRef}
      initParticleAmount={0}
      maxParticleAmount={600}
      maxDurationTime={6}
      size={1.8}
      colorPalette={winner === 'mafia' ? MAFIA_COLORS : CIVILIAN_COLORS}
    />
  )
}

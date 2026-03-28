import { useState, useEffect } from 'react'

interface CountdownProps {
  duration: number
  phase: string
  paused?: boolean
}

export function Countdown({ duration, phase, paused }: CountdownProps) {
  const [remaining, setRemaining] = useState(duration)

  useEffect(() => {
    setRemaining(duration)
  }, [duration, phase])

  useEffect(() => {
    if (paused) return
    const interval = setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [paused])

  const percent = (remaining / duration) * 100
  const color = remaining > duration * 0.5
    ? 'bg-green-500'
    : remaining > duration * 0.2
      ? 'bg-yellow-500'
      : 'bg-red-500'

  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-[#666]">
          {paused ? 'Narrator speaking...' : 'Time remaining'}
        </span>
        <span className={`text-xs font-mono font-bold ${remaining <= 10 && !paused ? 'text-red-500' : 'text-[#888]'}`}>
          {remaining}s
        </span>
      </div>
      <div className="w-full h-1.5 bg-[#222] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ease-linear ${paused ? 'bg-indigo-500' : color} ${remaining <= 10 && !paused ? 'animate-pulse' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

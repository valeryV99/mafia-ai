import type { Phase } from '@mafia-ai/types'

export const PHASE_DURATIONS: Partial<Record<Phase, number>> = {
  night: 20,
  day: 40,
  voting: 20,
}

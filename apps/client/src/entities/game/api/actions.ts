import type { ClientEvent } from '@mafia-ai/types'

let sendFunction: ((event: ClientEvent) => void) | null = null

export function initializeGameActions(send: (event: ClientEvent) => void) {
  sendFunction = send
}

export function sendGameEvent(event: ClientEvent) {
  if (sendFunction) {
    sendFunction(event)
  } else {
    console.error('Game actions not initialized. Cannot send event:', event)
  }
}

import { useEffect, useRef } from 'react'
import { useConnection, usePeers, useCamera, useMicrophone, useInitializeDevices } from '@fishjam-cloud/react-client'

export function useFishjamMediaSession(fishjamToken: string | null, playerName: string | null) {
  const { joinRoom, peerStatus } = useConnection()
  const { localPeer, remotePeers } = usePeers()
  const { startCamera, cameraStream } = useCamera()
  const { startMicrophone, toggleMicrophoneMute, isMicrophoneMuted } = useMicrophone()
  const { initializeDevices } = useInitializeDevices()
  const fishjamJoinInitiated = useRef(false)

  useEffect(() => {
    if (!fishjamToken || fishjamJoinInitiated.current) return
    fishjamJoinInitiated.current = true

    initializeDevices({})
      .then(() =>
        joinRoom({
          peerToken: fishjamToken,
          peerMetadata: { name: playerName ?? '' },
        })
      )
      .then(async () => {
        console.log('[FISHJAM] Joined room, starting camera + microphone...')
        const [, camErr] = await startCamera()
        if (camErr) console.error('[FISHJAM] Camera start failed:', camErr)
        else console.log('[FISHJAM] Camera started')
        startMicrophone()
      })
      .catch((err) => {
        console.error('[FISHJAM] Setup FAILED:', err)
        fishjamJoinInitiated.current = false
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fishjamToken])

  return {
    peerStatus,
    localPeer,
    remotePeers,
    toggleMicrophoneMute,
    isMicrophoneMuted,
    cameraStream,
  }
}

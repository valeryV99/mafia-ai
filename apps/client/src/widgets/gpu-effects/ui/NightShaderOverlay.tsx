// @ts-nocheck — GPU shader functions use TypeGPU's 'use gpu' directive, type-checked by unplugin-typegpu, not tsc
import { Suspense, useMemo } from 'react'
import { useRoot, useConfigureContext, useFrame, useUniformValue } from '@typegpu/react'
import tgpu, { d, std } from 'typegpu'

const darknessAccess = tgpu.accessor(d.f32)
const timeAccess = tgpu.accessor(d.f32)

const fullscreenVertex = tgpu.vertexFn({
  in: { vertexIndex: d.builtin.vertexIndex },
  out: { outPos: d.builtin.position, uv: d.vec2f },
})(({ vertexIndex }) => {
  'use gpu'
  const pos = [
    d.vec2f(-1.0, 1.0), d.vec2f(-1.0, -1.0), d.vec2f(1.0, -1.0),
    d.vec2f(-1.0, 1.0), d.vec2f(1.0, -1.0), d.vec2f(1.0, 1.0),
  ]
  const uv = [
    d.vec2f(0.0, 1.0), d.vec2f(0.0, 0.0), d.vec2f(1.0, 0.0),
    d.vec2f(0.0, 1.0), d.vec2f(1.0, 0.0), d.vec2f(1.0, 1.0),
  ]
  return { outPos: d.vec4f(pos[vertexIndex], 0.0, 1.0), uv: uv[vertexIndex] }
})

const nightFragment = tgpu.fragmentFn({
  in: { uv: d.vec2f },
  out: d.vec4f,
})(({ uv }) => {
  'use gpu'
  const dark = darknessAccess.$
  const t = timeAccess.$
  const nightColor = d.vec3f(0.03, 0.01, 0.12)
  const center = uv - d.vec2f(0.5, 0.5)
  const vignette = 1.0 - std.length(center) * 0.6
  const pulse = std.sin(t * 0.8) * 0.03 + 1.0
  const alpha = dark * (0.65 + 0.35 * (1.0 - vignette)) * pulse
  return d.vec4f(nightColor * alpha, alpha)
})

function NightScene({ darkness }: { darkness: number }) {
  const root = useRoot()
  const { canvasRefCallback, ctxRef } = useConfigureContext({
    alphaMode: 'premultiplied',
    autoResize: true,
  })

  const timeUniform = useUniformValue(d.f32, 0)
  const darknessUniform = useUniformValue(d.f32, darkness)

  const pipeline = useMemo(
    () =>
      root
        .with(timeAccess, timeUniform)
        .with(darknessAccess, darknessUniform)
        .createRenderPipeline({
          vertex: fullscreenVertex,
          fragment: nightFragment,
        }),
    [root, timeUniform, darknessUniform]
  )

  darknessUniform.value = darkness

  useFrame(({ elapsedSeconds }) => {
    const ctx = ctxRef.current
    if (!ctx) return
    timeUniform.value = elapsedSeconds
    pipeline.withColorAttachment({ view: ctx }).draw(6)
  })

  return (
    <canvas
      ref={canvasRefCallback}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 5,
        opacity: darkness > 0 ? 1 : 0,
        transition: 'opacity 1s ease',
      }}
    />
  )
}

interface NightShaderOverlayProps {
  isNight: boolean
}

// GPU context stays mounted — darkness controlled via uniform (no re-init on phase change)
export function NightShaderOverlay({ isNight }: NightShaderOverlayProps) {
  if (!navigator.gpu) return null

  return (
    <Suspense fallback={null}>
      <NightScene darkness={isNight ? 0.85 : 0} />
    </Suspense>
  )
}

import { useEffect, useMemo, useRef } from 'react'
import { cellPhase, type CellState, type SwarmCounts } from './useSwarmRun'

// The mission-control view of a run: a coordinator dispatches to a fan of cells,
// each colored by its real verdict, and the settled ones stream back into an
// aggregator that produces the report. It is the same data as the grid, drawn as
// a live map. Everything animated here (pulses, particles) is cosmetic; every
// position and color is derived from the actual cell states.

const PALETTE = {
  bg: '#07080a',
  ink: '#8b9199',
  text: '#e8eaed',
  orange: '#ff7a18',
  red: '#ff4d4d',
  amber: '#f5b942',
  green: '#4ade80',
  grey: '#5b6066',
  purple: '#c084fc',
} as const

type CellColor = keyof typeof PALETTE

// A cell's color is its phase, and for a settled cell its disposition. Running
// cells glow orange (work in flight); queued ones are dim.
function cellColor(state: CellState): CellColor {
  const phase = cellPhase(state)
  if (phase === 'failed') return 'grey'
  if (phase === 'running') return 'orange'
  if (phase === 'queued') return 'grey'
  const d = state.finding?.disposition
  if (d === 'exposed') return 'red'
  if (d === 'needs-review') return 'amber'
  return 'green'
}

// A cell is "active" — drawn with a bright edge and particles — while it is
// running, or once it found something worth reporting.
function cellActive(state: CellState): boolean {
  const phase = cellPhase(state)
  if (phase === 'running') return true
  return state.finding?.disposition === 'exposed' ||
    state.finding?.disposition === 'needs-review'
}

export function SwarmMap({
  states,
  counts,
  settled,
}: {
  states: CellState[]
  counts: SwarmCounts
  settled: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // The draw loop reads live data from a ref so we animate continuously without
  // restarting the loop (and the effect) on every poll.
  const dataRef = useRef({ states, counts, settled })

  // Stable per-cell jitter so the fan doesn't reshuffle between polls.
  const seeds = useMemo(
    () => states.map((_, i) => ((i * 2654435761) % 1000) / 1000),
    [states],
  )
  const seedsRef = useRef(seeds)

  // Keep the refs the draw loop reads in sync with each render's live data,
  // without restarting the animation effect.
  useEffect(() => {
    dataRef.current = { states, counts, settled }
    seedsRef.current = seeds
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let frame = 0
    let width = 0
    let height = 0

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      width = container.clientWidth
      height = Math.max(360, Math.round(width * 0.42))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    const quad = (
      ax: number, ay: number, bx: number, by: number,
      cx: number, cy: number, t: number,
    ): [number, number] => {
      const u = 1 - t
      return [
        u * u * ax + 2 * u * t * bx + t * t * cx,
        u * u * ay + 2 * u * t * by + t * t * cy,
      ]
    }

    const node = (
      x: number, y: number, label: string, sub: string, color: string,
    ) => {
      const pulse = 0.5 + 0.5 * Math.sin(frame * 0.05)
      ctx.shadowColor = color
      ctx.shadowBlur = 12 + pulse * 10
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.25 + pulse * 0.35
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x, y, 13 + pulse * 5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.font = 'bold 10px ui-monospace, "Courier New", monospace'
      ctx.fillStyle = PALETTE.text
      ctx.textAlign = 'center'
      ctx.fillText(label, x, y - 20)
      ctx.font = '8px ui-monospace, "Courier New", monospace'
      ctx.fillStyle = PALETTE.ink
      ctx.fillText(sub, x, y + 26)
      ctx.textAlign = 'left'
    }

    const draw = () => {
      frame++
      const { states: st, counts: ct, settled: done } = dataRef.current
      const sd = seedsRef.current
      const n = st.length

      ctx.fillStyle = PALETTE.bg
      ctx.fillRect(0, 0, width, height)

      const coordX = width * 0.1
      const coordY = height * 0.5
      const aggX = width * 0.9
      const aggY = height * 0.5
      const arcCx = width * 0.52
      const arcCy = height * 0.5
      const arcR = Math.min(height * 0.42, width * 0.28)
      const aStart = -Math.PI * 0.6
      const aEnd = Math.PI * 0.6

      // Cell positions on the fan.
      const pts = st.map((_, i) => {
        const t = n <= 1 ? 0.5 : i / (n - 1)
        const jitter = (sd[i] - 0.5) * (arcR * 0.06)
        const ang = aStart + t * (aEnd - aStart)
        return {
          ang,
          x: arcCx - Math.cos(ang) * (arcR + jitter),
          y: arcCy + Math.sin(ang) * (arcR + jitter),
        }
      })

      // Dispatch edges: coordinator → each cell, particles on active ones.
      ctx.lineCap = 'round'
      st.forEach((cell, i) => {
        const p = pts[i]
        const color = PALETTE[cellColor(cell)]
        const active = cellActive(cell)
        const o0y = coordY + (i - n / 2) * 0.5
        const midx = (coordX + p.x) / 2 + width * 0.03
        const midy = (coordY + p.y) / 2 - height * 0.03
        ctx.strokeStyle = color
        ctx.globalAlpha = active ? 0.3 : 0.1
        ctx.lineWidth = active ? 1.3 : 0.6
        ctx.beginPath()
        ctx.moveTo(coordX, o0y)
        ctx.quadraticCurveTo(midx, midy, p.x, p.y)
        ctx.stroke()
        if (active) {
          for (let k = 0; k < 2; k++) {
            const t = ((frame * 0.008) + sd[i] + k * 0.5) % 1
            const [px, py] = quad(coordX, o0y, midx, midy, p.x, p.y, t)
            ctx.globalAlpha = 1
            ctx.shadowColor = color
            ctx.shadowBlur = 8
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(px, py, 2, 0, Math.PI * 2)
            ctx.fill()
            ctx.shadowBlur = 0
          }
        }
      })
      ctx.globalAlpha = 1

      // Cell ticks on the fan.
      st.forEach((cell, i) => {
        const p = pts[i]
        const color = PALETTE[cellColor(cell)]
        const active = cellActive(cell)
        const flash = active ? 0.6 + 0.4 * Math.sin(frame * 0.08 + sd[i] * 6.28) : 0.55
        const inner = arcR - 5
        const outer = arcR + (active ? 14 : 6)
        const ix = arcCx - Math.cos(p.ang) * inner
        const iy = arcCy + Math.sin(p.ang) * inner
        const ox = arcCx - Math.cos(p.ang) * outer
        const oy = arcCy + Math.sin(p.ang) * outer
        ctx.strokeStyle = color
        ctx.globalAlpha = flash
        ctx.lineWidth = active ? 2.4 : 1.4
        if (active) {
          ctx.shadowColor = color
          ctx.shadowBlur = 8
        }
        ctx.beginPath()
        ctx.moveTo(ix, iy)
        ctx.lineTo(ox, oy)
        ctx.stroke()
        ctx.shadowBlur = 0
      })
      ctx.globalAlpha = 1

      // Return edges: settled, reportable cells → aggregator.
      st.forEach((cell, i) => {
        if (cell.finding?.disposition !== 'exposed' &&
          cell.finding?.disposition !== 'needs-review') return
        const p = pts[i]
        const color = PALETTE[cellColor(cell)]
        const mx = arcCx + width * 0.2
        const my = (p.y + aggY) / 2
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.22
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.quadraticCurveTo(mx, my, aggX, aggY)
        ctx.stroke()
        const t = (frame * 0.006 + sd[i]) % 1
        const [px, py] = quad(p.x, p.y, mx, my, aggX, aggY, t)
        ctx.globalAlpha = 1
        ctx.shadowColor = color
        ctx.shadowBlur = 8
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(px, py, 2, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      })
      ctx.globalAlpha = 1

      const live = ct.pending
      node(coordX, coordY, 'COORDINATOR',
        done ? `${n} dispatched` : `dispatch · ${live} live`, PALETTE.orange)
      const reportable = ct.exposed + ct['needs-review']
      node(aggX, aggY, 'AGGREGATOR',
        done ? `report · ${reportable} findings` : 'aggregating…', PALETTE.purple)

      raf = requestAnimationFrame(draw)
    }
    draw()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-lg border"
      style={{ background: PALETTE.bg }}
    >
      <canvas ref={canvasRef} className="block w-full" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 px-4 py-2 font-mono text-[11px]">
        <LegendDot color={PALETTE.orange} label={`${counts.pending} running`} />
        <LegendDot color={PALETTE.red} label={`${counts.exposed} exposed`} />
        <LegendDot color={PALETTE.amber} label={`${counts['needs-review']} review`} />
        <LegendDot color={PALETTE.green} label={`${counts['not-exposed']} clear`} />
        {counts.failed > 0 ? (
          <LegendDot color={PALETTE.grey} label={`${counts.failed} failed`} />
        ) : null}
        <span className="ml-auto" style={{ color: PALETTE.ink }}>
          {settled ? 'run complete' : 'live'}
        </span>
      </div>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: '#c8cdd2' }}>
      <span
        className="inline-block size-2 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      />
      {label}
    </span>
  )
}

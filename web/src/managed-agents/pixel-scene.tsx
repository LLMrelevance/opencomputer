import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'

// A faint pixel-art scene under the setup context: the computer, a cactus
// and a couple of clouds, in the spirit of Chrome's offline dinosaur. Pure
// decoration (Igor, 2026-10-13: "subtle, pixelated, nerdy, not contrast"), so
// it is hidden from assistive tech and holds still for reduced motion.

/** Rows of pixels: `#` is on, anything else is off. */
type Sprite = readonly string[]

const MONITOR: Sprite = [
  '.############.',
  '#............#',
  '#............#',
  '#............#',
  '#............#',
  '#............#',
  '#............#',
  '#............#',
  '.############.',
  '......##......',
  '....######....',
]
const EYES_OPEN: Sprite = ['...##....##...', '...##....##...']
const EYES_SHUT: Sprite = ['..............', '..###....###..']
const SMILE: Sprite = ['....#....#....', '.....####.....']
const CACTUS: Sprite = [
  '..#..',
  '..#..',
  '#.#..',
  '#.#.#',
  '###.#',
  '..###',
  '..#..',
  '..#..',
]
const CLOUD: Sprite = ['..####..', '.######.', '########']
const ZED: Sprite = ['###', '..#', '.#.', '###']

const SMALL_CACTUS: Sprite = ['.#.', '##.', '.##', '.#.', '.#.']

/**
 * Two compositions at about the same pixel size: a panorama for a whole
 * bottom row, and a taller one for a single column.
 */
const SHAPES = {
  wide: {
    width: 240,
    height: 26,
    monitorX: 10,
    clouds: [
      { x: 58, y: 4, drift: -6, dur: 40 },
      { x: 118, y: 9, drift: 5, dur: 55 },
      { x: 186, y: 2, drift: -4, dur: 48 },
    ],
    cacti: [
      { sprite: CACTUS, x: 148 },
      { sprite: SMALL_CACTUS, x: 156 },
      { sprite: CACTUS, x: 214 },
    ],
    pebbles: [3, 24, 37, 52, 71, 90, 104, 131, 163, 177, 196, 228, 236],
  },
  compact: {
    width: 64,
    height: 44,
    monitorX: 4,
    clouds: [
      { x: 28, y: 4, drift: -5, dur: 40 },
      { x: 6, y: 13, drift: 4, dur: 55 },
    ],
    cacti: [
      { sprite: CACTUS, x: 46 },
      { sprite: SMALL_CACTUS, x: 54 },
    ],
    pebbles: [3, 11, 19, 30, 41, 58],
  },
} as const

function Pixels({
  sprite,
  x,
  y,
  className,
  children,
}: {
  sprite: Sprite
  x: number
  y: number
  className?: string
  children?: React.ReactNode
}) {
  return (
    <g className={className}>
      {sprite.flatMap((row, dy) =>
        [...row].map((cell, dx) =>
          cell === '#' ? (
            <rect
              key={`${dx},${dy}`}
              x={x + dx}
              y={y + dy}
              width={1}
              height={1}
            />
          ) : null,
        ),
      )}
      {children}
    </g>
  )
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () =>
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    () => true,
  )
}

/**
 * `asleep` before the computer is in Slack (it dozes, Zs rising); awake
 * after, blinking now and then.
 */
export function PixelScene({
  asleep,
  shape,
  className,
}: {
  asleep: boolean
  shape: keyof typeof SHAPES
  className?: string
}) {
  const still = useReducedMotion()
  const { width, height, monitorX, clouds, cacti, pebbles } = SHAPES[shape]
  const ground = height - 3
  const monitorY = ground - MONITOR.length
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      className={cn('text-foreground/15 w-full fill-current', className)}
      aria-hidden
    >
      {clouds.map((cloud) => (
        <Pixels key={cloud.x} sprite={CLOUD} x={cloud.x} y={cloud.y}>
          {still ? null : (
            <animateTransform
              attributeName="transform"
              type="translate"
              values={`0 0; ${cloud.drift} 0; 0 0`}
              dur={`${cloud.dur}s`}
              repeatCount="indefinite"
            />
          )}
        </Pixels>
      ))}

      <Pixels sprite={MONITOR} x={monitorX} y={monitorY} />
      {asleep ? (
        <>
          <Pixels sprite={EYES_SHUT} x={monitorX} y={monitorY + 2} />
          <Pixels sprite={ZED} x={monitorX + 15} y={monitorY - 6}>
            {still ? null : (
              <>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values="0 3; 2 -1"
                  dur="3s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0; 1; 0"
                  dur="3s"
                  repeatCount="indefinite"
                />
              </>
            )}
          </Pixels>
        </>
      ) : (
        <>
          <Pixels sprite={EYES_OPEN} x={monitorX} y={monitorY + 2}>
            {still ? null : (
              <animate
                attributeName="opacity"
                values="1; 1; 0; 1"
                keyTimes="0; 0.94; 0.97; 1"
                dur="5s"
                repeatCount="indefinite"
              />
            )}
          </Pixels>
          <Pixels sprite={SMILE} x={monitorX} y={monitorY + 5} />
        </>
      )}

      {cacti.map((cactus) => (
        <Pixels
          key={cactus.x}
          sprite={cactus.sprite}
          x={cactus.x}
          y={ground - cactus.sprite.length}
        />
      ))}

      {/* The ground: a line with a few pebbles, Chrome-dino style. */}
      <rect x={0} y={ground} width={width} height={1} />
      {pebbles.map((x, i) => (
        <rect
          key={x}
          x={x}
          y={ground + 1 + (i % 2)}
          width={i % 3 ? 1 : 2}
          height={1}
        />
      ))}
    </svg>
  )
}

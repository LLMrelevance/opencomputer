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

const WIDTH = 72
const HEIGHT = 24
const GROUND = 21

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
  className,
}: {
  asleep: boolean
  className?: string
}) {
  const still = useReducedMotion()
  const monitorX = 6
  const monitorY = GROUND - MONITOR.length
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      shapeRendering="crispEdges"
      className={cn('text-foreground/15 w-full fill-current', className)}
      aria-hidden
    >
      <Pixels sprite={CLOUD} x={34} y={2}>
        {still ? null : (
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; -6 0; 0 0"
            dur="40s"
            repeatCount="indefinite"
          />
        )}
      </Pixels>
      <Pixels sprite={CLOUD} x={54} y={6}>
        {still ? null : (
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 5 0; 0 0"
            dur="55s"
            repeatCount="indefinite"
          />
        )}
      </Pixels>

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

      <Pixels sprite={CACTUS} x={50} y={GROUND - CACTUS.length} />

      {/* The ground: a line with a few pebbles, Chrome-dino style. */}
      <rect x={0} y={GROUND} width={WIDTH} height={1} />
      {[3, 11, 19, 30, 41, 47, 58, 66].map((x, i) => (
        <rect
          key={x}
          x={x}
          y={GROUND + 2 + (i % 2)}
          width={i % 3 ? 1 : 2}
          height={1}
        />
      ))}
    </svg>
  )
}

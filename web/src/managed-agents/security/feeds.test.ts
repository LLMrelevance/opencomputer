import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_ANGLES,
  SWARM_FEEDS,
  assignAngles,
  feedSeedingLines,
} from './feeds'

describe('discovery angles', () => {
  it('round-robins angles across cells so a swarm diverges', () => {
    const three = assignAngles(3).map((a) => a.id)
    expect(three).toEqual(DISCOVERY_ANGLES.slice(0, 3).map((a) => a.id))
    expect(new Set(three).size).toBe(3)
  })

  it('wraps back to the first angle once the catalog is exhausted', () => {
    const count = DISCOVERY_ANGLES.length + 2
    const assigned = assignAngles(count)
    expect(assigned).toHaveLength(count)
    expect(assigned[DISCOVERY_ANGLES.length].id).toBe(DISCOVERY_ANGLES[0].id)
    expect(assigned[DISCOVERY_ANGLES.length + 1].id).toBe(DISCOVERY_ANGLES[1].id)
  })

  it('is empty for a non-positive count', () => {
    expect(assignAngles(0)).toEqual([])
    expect(assignAngles(-3)).toEqual([])
  })

  it('every angle carries an id, label and focus line', () => {
    for (const angle of DISCOVERY_ANGLES) {
      expect(angle.id).toMatch(/^[a-z-]+$/)
      expect(angle.label.length).toBeGreaterThan(0)
      expect(angle.focus.length).toBeGreaterThan(0)
    }
  })
})

describe('feed seeding', () => {
  it('names both live feeds with reachable JSON endpoints', () => {
    const ids = SWARM_FEEDS.map((f) => f.id)
    expect(ids).toContain('cve.now')
    expect(ids).toContain('pwn.watch')
    for (const feed of SWARM_FEEDS) {
      expect(feed.json).toMatch(/^https:\/\//)
    }
  })

  it('points the agent at live feeds and the lockfile match', () => {
    const text = feedSeedingLines().join('\n')
    expect(text).toContain('cve.now')
    expect(text).toContain('pwn.watch')
    expect(text).toContain('check_stack')
  })
})

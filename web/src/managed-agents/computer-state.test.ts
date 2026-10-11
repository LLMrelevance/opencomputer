import { describe, expect, it } from 'vitest'
import {
  computerSessionsSchema,
  computerStatusSchema,
  computerSlackInstallSchema,
  type Computer,
  type ComputerStatus,
} from './computer-api'
import {
  FAST_POLL_MS,
  SLOW_POLL_MS,
  computerChecklist,
  computerPollInterval,
  computerPresentation,
  formatCapacity,
  slackReturnFromSearch,
} from './computer-state'

const computer: Computer = {
  state: 'ready',
  connected: true,
  vcpus: 2,
  memoryGiB: 8,
  diskGiB: 128,
  lastError: null,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:05:00.000Z',
}

function status(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    computer,
    slack: { installed: false },
    github: { connected: false, installations: [] },
    plan: 'free',
    ...overrides,
  }
}

const FORBIDDEN = /azure|aws|gcp|cloud|region|instance|vm\b|host/i

describe('computer contract schemas', () => {
  it('parses the GET /computer body, with and without a computer', () => {
    expect(
      computerStatusSchema.parse({
        computer,
        slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
        github: {
          connected: true,
          installations: [{ id: '42', accountLogin: 'acme' }],
        },
        plan: 'paid',
      }),
    ).toMatchObject({ slack: { teamName: 'Acme' }, plan: 'paid' })
    expect(
      computerStatusSchema.parse({
        computer: null,
        slack: { installed: false },
        github: { connected: false, installations: [] },
        plan: 'free',
      }).computer,
    ).toBeNull()
  })

  it('rejects states and plans outside the contract', () => {
    expect(
      computerStatusSchema.safeParse(
        status({ computer: { ...computer, state: 'sleeping' as never } }),
      ).success,
    ).toBe(false)
    expect(
      computerStatusSchema.safeParse({ ...status(), plan: 'enterprise' })
        .success,
    ).toBe(false)
  })

  it('parses sessions and the Slack install URL', () => {
    expect(
      computerSessionsSchema.parse({
        sessions: [
          {
            key: 'C1:1.2',
            title: 'Fix it',
            channelId: 'C1',
            threadTs: '1.2',
            ownerSlackUserId: null,
            status: 'idle',
            updatedAt: '2026-10-11T10:05:00.000Z',
            slackUrl: null,
          },
        ],
      }).sessions,
    ).toHaveLength(1)
    expect(
      computerSlackInstallSchema.safeParse({ url: 'not a url' }).success,
    ).toBe(false)
  })
})

describe('computer state copy', () => {
  it.each([
    [null, 'Setting up'],
    [{ ...computer, state: 'provisioning' as const }, 'Setting up'],
    [computer, 'Online'],
    [{ ...computer, connected: false }, 'Offline'],
    [{ ...computer, state: 'parked' as const, connected: false }, 'Sleeping'],
    [{ ...computer, state: 'waking' as const, connected: false }, 'Waking'],
    [{ ...computer, state: 'failed' as const }, 'Failed'],
    [{ ...computer, state: 'deleting' as const }, 'Removing'],
  ])('labels %o as %s without naming the infrastructure', (value, label) => {
    const presentation = computerPresentation(value, 'free')
    expect(presentation.label).toBe(label)
    expect(presentation.description).not.toMatch(FORBIDDEN)
  })

  it('suggests an upgrade only to free organizations whose computer sleeps', () => {
    const parked = { ...computer, state: 'parked' as const }
    expect(computerPresentation(parked, 'free').description).toContain(
      'wakes when you message it; upgrade to keep it always on',
    )
    expect(computerPresentation(parked, 'paid').description).not.toContain(
      'upgrade',
    )
  })

  it('shows the last error of a failed computer', () => {
    expect(
      computerPresentation(
        { ...computer, state: 'failed', lastError: 'Setup timed out.' },
        'free',
      ).description,
    ).toBe('Setup timed out.')
  })

  it('formats capacity as vCPUs, memory and disk', () => {
    expect(formatCapacity(computer)).toEqual([
      { label: 'vCPUs', value: '2' },
      { label: 'Memory', value: '8 GiB' },
      { label: 'Disk', value: '128 GiB' },
    ])
  })
})

describe('computer polling', () => {
  it('polls quickly while the computer is changing or not connected', () => {
    expect(computerPollInterval(undefined)).toBe(FAST_POLL_MS)
    expect(computerPollInterval(status({ computer: null }))).toBe(FAST_POLL_MS)
    for (const state of ['provisioning', 'waking', 'deleting'] as const) {
      expect(
        computerPollInterval(status({ computer: { ...computer, state } })),
      ).toBe(FAST_POLL_MS)
    }
    expect(
      computerPollInterval(
        status({ computer: { ...computer, connected: false } }),
      ),
    ).toBe(FAST_POLL_MS)
  })

  it('polls slowly once online, asleep or failed', () => {
    expect(computerPollInterval(status())).toBe(SLOW_POLL_MS)
    for (const state of ['parked', 'failed'] as const) {
      expect(
        computerPollInterval(
          status({ computer: { ...computer, state, connected: false } }),
        ),
      ).toBe(SLOW_POLL_MS)
    }
  })
})

describe('computer checklist', () => {
  it('ticks each step from the status and the sessions', () => {
    const done = (value: ComputerStatus, sessions?: unknown[]) =>
      computerChecklist(value, sessions as never).map((step) => step.done)

    expect(done(status({ computer: null }))).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect(
      done(
        status({
          slack: { installed: true, teamName: 'Acme' },
          github: {
            connected: true,
            installations: [{ id: '1', accountLogin: 'acme' }],
          },
        }),
        [{}],
      ),
    ).toEqual([true, true, true, true])
    expect(
      done(status({ computer: { ...computer, state: 'parked' } }))[0],
    ).toBe(true)
    expect(
      done(status({ computer: { ...computer, state: 'failed' } }))[0],
    ).toBe(false)
  })
})

describe('Slack install return', () => {
  it('reads connected and error returns', () => {
    expect(
      slackReturnFromSearch(new URLSearchParams('slack=connected')),
    ).toEqual({ kind: 'connected' })
    expect(
      slackReturnFromSearch(
        new URLSearchParams('slack=error&reason=access_denied'),
      ),
    ).toEqual({ kind: 'error', message: 'The Slack install was cancelled.' })
    expect(
      slackReturnFromSearch(
        new URLSearchParams('slack=error&reason=constructor'),
      ),
    ).toEqual({
      kind: 'error',
      message: 'Slack could not be connected. Try again.',
    })
    expect(slackReturnFromSearch(new URLSearchParams(''))).toBeNull()
  })
})

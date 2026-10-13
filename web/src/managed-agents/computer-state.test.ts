import { describe, expect, it } from 'vitest'
import {
  computerSessionsSchema,
  computerStatusSchema,
  computerSlackInstallSchema,
  type Computer,
  type ComputerSession,
  type ComputerStatus,
} from './computer-api'
import {
  FAST_POLL_MS,
  LIVE_SESSION_POLL_MS,
  SESSION_POLL_MS,
  SLOW_POLL_MS,
  compactStatusLine,
  computerChecklist,
  computerIsOnboarded,
  computerPollInterval,
  computerPresentation,
  heroCopy,
  relativeTime,
  sessionPollInterval,
  alreadyLinkedCopy,
  slackReturnFromSearch,
  splitSessions,
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

  it('writes a headline for every state without naming hardware or vendors', () => {
    const states = [
      'provisioning',
      'ready',
      'parked',
      'waking',
      'failed',
      'deleting',
    ] as const
    for (const state of states) {
      for (const plan of ['free', 'paid'] as const) {
        const copy = heroCopy({ ...computer, state }, plan)
        expect(copy.headline.length).toBeGreaterThan(0)
        expect(`${copy.headline} ${copy.subline}`).not.toMatch(
          /vCPU|GiB|azure|region|instance/i,
        )
      }
    }
    expect(heroCopy(null, 'free').headline).toBe(
      heroCopy({ ...computer, state: 'provisioning' }, 'free').headline,
    )
  })

  it('offers the upgrade only to a sleeping free computer', () => {
    const parked = { ...computer, state: 'parked' as const }
    expect(heroCopy(parked, 'free').subline).toContain('Upgrade')
    expect(heroCopy(parked, 'paid').subline).not.toContain('Upgrade')
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

  it('reads an already-linked workspace and whether its owner was asked', () => {
    expect(
      slackReturnFromSearch(
        new URLSearchParams(
          'slack=error&reason=team_already_linked&notified=1',
        ),
      ),
    ).toEqual({ kind: 'already_linked', notified: true })
    expect(
      slackReturnFromSearch(
        new URLSearchParams(
          'slack=error&reason=team_already_linked&notified=0',
        ),
      ),
    ).toEqual({ kind: 'already_linked', notified: false })
    // Redirects from before `notified` existed: nobody was asked.
    expect(
      slackReturnFromSearch(
        new URLSearchParams('slack=error&reason=team_already_linked'),
      ),
    ).toEqual({ kind: 'already_linked', notified: false })
    expect(alreadyLinkedCopy(true).body).toContain(
      "We've messaged the person who set it up",
    )
    expect(alreadyLinkedCopy(false).body).toContain(
      'Ask a teammate who uses it to invite you',
    )
    for (const notified of [true, false]) {
      expect(alreadyLinkedCopy(notified).headline).toBe(
        'Your team is already here.',
      )
    }
  })
})

function session(
  key: string,
  status: ComputerSession['status'],
  updatedAt: string,
): ComputerSession {
  return {
    key,
    title: key,
    channelId: 'C1',
    threadTs: '1.2',
    ownerSlackUserId: null,
    status,
    updatedAt,
    slackUrl: null,
  }
}

describe('onboarding', () => {
  it('is onboarded once Slack is installed and GitHub connected', () => {
    const slack = { installed: true, teamName: 'Acme' }
    const github = {
      connected: true,
      installations: [{ id: '1', accountLogin: 'acme' }],
    }
    expect(computerIsOnboarded(status())).toBe(false)
    expect(computerIsOnboarded(status({ slack }))).toBe(false)
    expect(computerIsOnboarded(status({ github }))).toBe(false)
    expect(computerIsOnboarded(status({ slack, github }))).toBe(true)
    // Onboarding is about the person's setup, not the computer's mood.
    expect(
      computerIsOnboarded(
        status({ slack, github, computer: { ...computer, state: 'parked' } }),
      ),
    ).toBe(true)
  })
})

describe('live and recent sessions', () => {
  const sessions = [
    session('old-idle', 'idle', '2026-10-11T09:00:00.000Z'),
    session('busy', 'busy', '2026-10-11T10:00:00.000Z'),
    session('ended', 'ended', '2026-10-11T11:00:00.000Z'),
    session('starting', 'starting', '2026-10-11T12:00:00.000Z'),
    session('error', 'error', '2026-10-11T08:00:00.000Z'),
  ]

  it('splits starting and busy from the rest, each newest first', () => {
    const { live, recent } = splitSessions(sessions)
    expect(live.map((s) => s.key)).toEqual(['starting', 'busy'])
    expect(recent.map((s) => s.key)).toEqual(['ended', 'old-idle', 'error'])
    expect(splitSessions([])).toEqual({ live: [], recent: [] })
  })

  it('polls sessions faster while any is live', () => {
    expect(sessionPollInterval(undefined)).toBe(SESSION_POLL_MS)
    expect(sessionPollInterval([])).toBe(SESSION_POLL_MS)
    expect(
      sessionPollInterval(sessions.filter((s) => s.status === 'idle')),
    ).toBe(SESSION_POLL_MS)
    expect(sessionPollInterval(sessions)).toBe(LIVE_SESSION_POLL_MS)
    expect(LIVE_SESSION_POLL_MS).toBe(5_000)
    expect(SESSION_POLL_MS).toBe(15_000)
  })
})

describe('relative time', () => {
  const now = new Date('2026-10-11T12:00:00.000Z').getTime()
  const ago = (ms: number) =>
    relativeTime(new Date(now - ms).toISOString(), now)

  it('reads like a person would say it', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(59_000)).toBe('just now')
    expect(ago(2 * 60_000)).toBe('2 min ago')
    expect(ago(59 * 60_000 + 59_000)).toBe('59 min ago')
    expect(ago(3 * 3_600_000)).toBe('3 hr ago')
    expect(ago(30 * 3_600_000)).toBe('yesterday')
    expect(ago(4 * 86_400_000)).toBe('4 days ago')
    expect(ago(30 * 86_400_000)).not.toMatch(/ago|yesterday/)
  })

  it('treats clock skew as now and ignores bad timestamps', () => {
    expect(ago(-60_000)).toBe('just now')
    expect(relativeTime('not a date', now)).toBe('')
  })
})

describe('compact status line', () => {
  it('talks about the work when there is work', () => {
    expect(compactStatusLine(computer, 'free', 0).headline).toBe(
      'Ready when you are.',
    )
    expect(compactStatusLine(computer, 'free', 1).headline).toContain(
      'One thing',
    )
    expect(compactStatusLine(computer, 'free', 3).headline).toContain(
      '3 things',
    )
  })

  it('keeps resting, waking and failure visible, upgrade for free only', () => {
    const parked = { ...computer, state: 'parked' as const }
    expect(compactStatusLine(parked, 'free', 0)).toEqual({
      headline: 'Resting — wakes when you mention it.',
      detail: 'Upgrade and it never sleeps.',
    })
    expect(compactStatusLine(parked, 'paid', 0).detail).toBeUndefined()
    expect(
      compactStatusLine({ ...computer, state: 'waking' }, 'free', 0).headline,
    ).toContain('Waking')
    expect(
      compactStatusLine(
        { ...computer, state: 'failed', lastError: 'Setup timed out.' },
        'free',
        0,
      ),
    ).toEqual({ headline: 'Something went wrong.', detail: 'Setup timed out.' })
  })
})

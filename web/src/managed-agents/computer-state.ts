import type {
  Computer,
  ComputerSession,
  ComputerSessionStatus,
  ComputerStatus,
} from './computer-api'

// Presentation of the organization's computer: plain-language copy for its
// state, the setup checklist and how often the page re-reads it. Kept pure so
// the mapping is tested without rendering. Public copy names the computer by
// state and capacity only (design 002, forbidden vocabulary).

export const START_SESSION_COPY =
  'Mention @OpenComputer in any channel, or DM it.'

export type ComputerPresentation = {
  /** StatusBadge key: picks the tone and icon. */
  badge: string
  label: string
  description: string
}

export function computerPresentation(
  computer: Computer | null,
  plan: ComputerStatus['plan'],
): ComputerPresentation {
  if (!computer) {
    return {
      badge: 'starting',
      label: 'Setting up',
      description: 'We are setting up your computer. This takes a few minutes.',
    }
  }
  switch (computer.state) {
    case 'provisioning':
      return {
        badge: 'starting',
        label: 'Setting up',
        description:
          'We are setting up your computer. This takes a few minutes.',
      }
    case 'ready':
      return computer.connected
        ? {
            badge: 'running',
            label: 'Online',
            description: 'Your computer is on and ready for work.',
          }
        : {
            badge: 'stopped',
            label: 'Offline',
            description:
              'Your computer is on but not connected. It reconnects by itself, usually within a minute.',
          }
    case 'parked':
      return {
        badge: 'hibernated',
        label: 'Sleeping',
        description:
          plan === 'paid'
            ? 'Your computer is asleep. It wakes when you message it.'
            : 'Your computer is asleep. It wakes when you message it; upgrade to keep it always on.',
      }
    case 'waking':
      return {
        badge: 'starting',
        label: 'Waking',
        description:
          'Your computer is waking up with everything on its disk intact. This takes a minute or two.',
      }
    case 'failed':
      return {
        badge: 'failed',
        label: 'Failed',
        description:
          computer.lastError ??
          'Something went wrong with your computer. Try again, or contact support if it keeps failing.',
      }
    case 'deleting':
      return {
        badge: 'deleting',
        label: 'Removing',
        description: 'Your computer is being removed.',
      }
  }
}

/** Whether the computer has been set up (it may be asleep or waking). */
export function computerIsSetUp(computer: Computer | null): boolean {
  return (
    computer?.state === 'ready' ||
    computer?.state === 'parked' ||
    computer?.state === 'waking'
  )
}

export const FAST_POLL_MS = 5_000
export const SLOW_POLL_MS = 30_000

/**
 * Re-read quickly while something is about to change on its own (setting up,
 * waking, removing, or a running computer that has not connected yet), and
 * slowly otherwise. A sleeping or failed computer changes only on request.
 */
export function computerPollInterval(
  status: ComputerStatus | undefined,
): number {
  const computer = status?.computer
  if (!computer) return FAST_POLL_MS
  switch (computer.state) {
    case 'provisioning':
    case 'waking':
    case 'deleting':
      return FAST_POLL_MS
    case 'ready':
      return computer.connected ? SLOW_POLL_MS : FAST_POLL_MS
    case 'parked':
    case 'failed':
      return SLOW_POLL_MS
  }
}

export type ChecklistStep = {
  id: 'computer' | 'slack' | 'github' | 'session'
  title: string
  done: boolean
}

export function computerChecklist(
  status: ComputerStatus,
  sessions: ComputerSession[] | undefined,
): ChecklistStep[] {
  return [
    {
      id: 'computer',
      title: 'Computer ready',
      done: computerIsSetUp(status.computer),
    },
    {
      id: 'slack',
      title: 'Install the Slack app',
      done: status.slack.installed,
    },
    { id: 'github', title: 'Connect GitHub', done: status.github.connected },
    {
      id: 'session',
      title: 'Start a session',
      done: (sessions?.length ?? 0) > 0,
    },
  ]
}

export const SESSION_STATUS: Record<
  ComputerSessionStatus,
  { badge: string; label: string }
> = {
  starting: { badge: 'starting', label: 'Starting' },
  busy: { badge: 'running', label: 'Working' },
  idle: { badge: 'idle', label: 'Idle' },
  ended: { badge: 'stopped', label: 'Ended' },
  error: { badge: 'error', label: 'Error' },
}

const SLACK_RETURN_REASONS = new Map<string, string>([
  ['access_denied', 'The Slack install was cancelled.'],
  ['cancelled', 'The Slack install was cancelled.'],
  ['invalid_state', 'The install link expired. Start the install again.'],
  ['state_expired', 'The install link expired. Start the install again.'],
  [
    'already_linked',
    'That Slack workspace is already linked to another organization.',
  ],
  [
    'team_already_linked',
    'That Slack workspace is already linked to another organization.',
  ],
])

export type SlackReturn =
  | { kind: 'connected' }
  | { kind: 'error'; message: string }
  | null

/** Reads `?slack=connected|error&reason=` from Slack's install redirect. */
export function slackReturnFromSearch(search: URLSearchParams): SlackReturn {
  const slack = search.get('slack')
  if (slack === 'connected') return { kind: 'connected' }
  if (slack !== 'error') return null
  const reason = search.get('reason') ?? ''
  return {
    kind: 'error',
    message:
      SLACK_RETURN_REASONS.get(reason) ??
      'Slack could not be connected. Try again.',
  }
}

export type HeroCopy = { headline: string; subline: string }

/**
 * The page's headline for each state: what the computer means to the team,
 * never what it is made of (Mohamed, 2026-10-11: no specs, make people want it).
 */
export function heroCopy(
  computer: Computer | null,
  plan: ComputerStatus['plan'],
): HeroCopy {
  switch (computer?.state ?? 'provisioning') {
    case 'provisioning':
      return {
        headline: 'Your computer is coming to life.',
        subline:
          'A minute or two, and your team has a colleague that never logs off. Invite it into Slack while you wait.',
      }
    case 'ready':
      return computer?.connected
        ? {
            headline: 'Your team just got a colleague that never logs off.',
            subline:
              'It knows your code, lives in your Slack, and keeps going while you sleep. Ask it anything. Hand it anything.',
          }
        : {
            headline: 'Reconnecting.',
            subline:
              'Your computer is on and finding its way back. Usually within a minute.',
          }
    case 'parked':
      return {
        headline: 'Resting, not gone.',
        subline:
          plan === 'paid'
            ? 'Everything it knows is right where it left it. Mention it and it is back in a minute.'
            : 'Everything it knows is right where it left it. Mention it and it is back in a minute. Upgrade and it never sleeps.',
      }
    case 'waking':
      return {
        headline: 'Waking up.',
        subline:
          'Picking up exactly where it left off. Your message is already waiting for it.',
      }
    case 'failed':
      return {
        headline: 'Something went wrong.',
        subline:
          computer?.lastError ??
          'Your computer could not start. Try again, or tell us if it keeps happening.',
      }
    case 'deleting':
      return {
        headline: 'Saying goodbye.',
        subline: 'Your computer is being removed.',
      }
  }
}

/** Things to ask first: concrete, so the first message is easy to write. */
export const EXAMPLE_ASKS = [
  'why is the checkout test flaky? Fix it and open a PR.',
  'walk me through how billing works in our codebase.',
  'upgrade us to the latest React and tell me what broke.',
  'every morning, summarize what changed in main yesterday.',
] as const

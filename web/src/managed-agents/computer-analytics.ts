import posthog from 'posthog-js'
import type {
  AgentChoice,
  ComputerAgentConnect,
  SubscriptionProvider,
} from './computer-api'

// Setup step 1 funnel on /computer (serverless-agents-ws work 081,
// "Telemetry"). Same shape as `lib/billing-onramp.ts`: one named helper per
// event. The organization is on the person's identity already
// (`posthog.identify` in `hooks/auth-provider.tsx` carries `org_id`), so the
// payloads don't repeat it. Nothing here ever receives a token.

/** The code of a failed connect: the edge's `computer_agent_*` code, the
 * client-side format check, or `unknown` when the server was not reached. */
export type AgentFailureCode =
  | 'computer_agent_token_format'
  | (string & {})
  | 'unknown'

export function trackAgentStepShown(): void {
  posthog.capture('computer.setup.agent_shown')
}

/** Fired once the server has recorded the choice, never on the click. */
export function trackAgentChosen(choice: AgentChoice): void {
  posthog.capture('computer.setup.agent_chosen', { choice })
}

/** `via: 'command'`: connected with the one-command CLI (work 082). */
export function trackAgentConnected(props: {
  provider: SubscriptionProvider
  verified: boolean
  via: ComputerAgentConnect['via'] | 'command'
}): void {
  posthog.capture('computer.setup.agent_connected', props)
}

export function trackAgentFailed(code: AgentFailureCode): void {
  posthog.capture('computer.setup.agent_failed', { code })
}

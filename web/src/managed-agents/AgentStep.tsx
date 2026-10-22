import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { ApiError } from '@/api/errors'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyRow } from '@/components/copy-row'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { BASE_GRANT_CENTS } from '@/lib/billing-onramp'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  trackAgentChosen,
  trackAgentConnected,
  trackAgentFailed,
  trackAgentStepShown,
} from './computer-analytics'
import {
  computerQueryKey,
  connectClaudeSubscription,
  disconnectClaudeSubscription,
  resumeClaudeSubscription,
  setAgentChoice,
  type AgentChoice,
  type ComputerAgent,
  type ComputerStatus,
} from './computer-api'
import { agentSummary, linkedSlackUserLine } from './computer-state'

/**
 * Setup step 1 and the Your agent card (serverless-agents-ws work 081): the
 * person brings their own Claude subscription, or starts on free credits.
 * Copy is the doc's Copy table, kept short.
 */

/** The card picked in step 1; Codex records interest until it runs. */
export type AgentCardChoice = 'claude' | 'codex'

// `claude setup-token` prints a long-lived OAuth token with this prefix.
const SETUP_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/
const STILL_CHECKING_MS = 10_000
const FREE_DOLLARS = BASE_GRANT_CENTS / 100

const Cmd = ({ children }: { children: ReactNode }) => (
  <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">
    {children}
  </code>
)

const FORMAT_ERROR = (
  <>
    That&apos;s not a setup token. It starts with <Cmd>sk-ant-oat01-</Cmd>.
  </>
)

const CUT_OFF_ERROR = <>That token looks cut off. Copy all of it again.</>

// The terminal wraps the long token, so a copy can carry the line break and
// indentation. A setup token has no whitespace of its own.
const cleanToken = (value: string) => value.replace(/\s+/g, '')

const SLACK_INSTRUCTION = (
  <>
    Connect from Slack: <Cmd>!claude connect</Cmd>
  </>
)

const UNREACHABLE =
  "Couldn't reach the server. This page re-reads your agent in a moment; try again if nothing changed."

/**
 * The server's code when it refused a write, or undefined when the write may
 * not have reached it (network drop, a 5xx, a body without a code): then
 * nothing is known about what was saved, and the page re-reads the truth.
 */
function refusalCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status >= 500) return undefined
  return error.type
}

/** The doc's copy for each refusal; anything else keeps the edge's message. */
function connectErrorCopy(error: unknown): ReactNode {
  switch (refusalCode(error)) {
    case undefined:
      return UNREACHABLE
    case 'computer_agent_token_format':
      return FORMAT_ERROR
    case 'computer_agent_token_rejected':
      return (
        <>
          That token didn&apos;t work. Run <Cmd>claude setup-token</Cmd> again
          and paste the new one.
        </>
      )
    case 'computer_agent_connect_in_slack':
      return SLACK_INSTRUCTION
    default:
      return (error as ApiError).message
  }
}

/**
 * How the agent writes meet the page's status query, which polls on its own.
 * `setAgent` keeps the agent the server answered with: a poll that started
 * before the write could answer after it and revert the result, so any poll
 * in flight is cancelled first. `reread` asks for the truth when the answer
 * was lost.
 */
function useAgentCache() {
  const queryClient = useQueryClient()
  return {
    setAgent: async (agent: ComputerAgent) => {
      await queryClient.cancelQueries({
        queryKey: computerQueryKey,
        exact: true,
      })
      queryClient.setQueryData<ComputerStatus>(computerQueryKey, (status) =>
        status ? { ...status, agent } : status,
      )
    },
    reread: () => {
      void queryClient.invalidateQueries({ queryKey: computerQueryKey })
    },
  }
}

/**
 * The three ways to go: the two cards, the selected card's panel (the paste
 * form, or Codex's coming line) and free credits. Step 1 of setup, and the
 * Change dialog of its done row, where `onDone` closes the dialog once the
 * server has the change. Free credits replace a connected subscription:
 * routing decides from the subscription row, so it is disconnected first.
 */
export function AgentSetup({
  agent,
  selected,
  onSelect,
  onDone,
}: {
  agent: ComputerAgent
  selected: AgentCardChoice
  onSelect: (choice: AgentCardChoice) => void
  onDone?: () => void
}) {
  const { setAgent, reread } = useAgentCache()
  useEffect(() => {
    trackAgentStepShown()
  }, [])

  const choose = useMutation({
    mutationFn: async (choice: AgentChoice) => {
      if (choice === 'credits' && agent.subscription)
        await disconnectClaudeSubscription()
      return setAgentChoice(choice)
    },
    onSuccess: async (next, choice) => {
      await setAgent(next)
      trackAgentChosen(choice)
      if (choice !== 'credits') return
      if (agent.subscription) notifySuccess('Threads run on free credits now.')
      onDone?.()
    },
    onError: (error, choice) => {
      // Two writes for credits: whatever landed, the page re-reads it.
      reread()
      notifyError(
        choice === 'credits'
          ? "Couldn't switch to free credits."
          : "Couldn't save your choice.",
        error,
      )
    },
  })
  const pick = (choice: AgentCardChoice) => {
    if (choice === selected) return
    onSelect(choice)
    // Codex is the interest list until it runs on the computer.
    if (choice === 'codex' && agent.choice !== 'codex') choose.mutate('codex')
  }
  const onCredits = !agent.subscription && agent.choice === 'credits'

  return (
    <>
      <p>Bring your own subscription.</p>
      <div
        role="radiogroup"
        aria-label="Coding agent"
        className="grid gap-3 sm:grid-cols-2"
      >
        <AgentOption
          checked={selected === 'claude'}
          onSelect={() => pick('claude')}
          name="Claude Code"
          plans="Pro or Max"
          mark={<span className="bg-[#d97757] text-white">✳</span>}
        />
        <AgentOption
          checked={selected === 'codex'}
          onSelect={() => pick('codex')}
          name="Codex"
          plans="ChatGPT Plus or Pro"
          mark={<span className="bg-foreground text-background">◎</span>}
        />
      </div>
      {selected === 'claude' ? (
        <ClaudeConnect
          replacing={Boolean(agent.subscription)}
          onDone={onDone}
        />
      ) : (
        <p className="bg-muted/60 text-foreground rounded-lg px-4 py-3">
          Codex is coming. We&apos;ll let you know.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-3">
        <div>
          <p className="text-foreground font-semibold">
            {agent.subscription
              ? 'Switch to free credits.'
              : `No subscription? Start with $${FREE_DOLLARS} free.`}
          </p>
          <p>
            {agent.subscription ? 'Disconnects Claude Code; runs' : 'Runs'}{' '}
            {agent.managedModel} on our credits.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => choose.mutate('credits')}
          disabled={choose.isPending || onCredits}
        >
          {choose.isPending && choose.variables === 'credits' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {onCredits ? 'Using free credits' : 'Use free credits'}
        </Button>
      </div>
    </>
  )
}

function AgentOption({
  checked,
  onSelect,
  name,
  plans,
  mark,
}: {
  checked: boolean
  onSelect: () => void
  name: string
  plans: string
  mark: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'bg-panel focus-visible:ring-ring/50 flex items-start gap-3 rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-3',
        checked
          ? 'border-foreground ring-foreground ring-1'
          : 'hover:bg-muted/40',
      )}
    >
      <span
        className="[&>span]:flex [&>span]:size-6 [&>span]:items-center [&>span]:justify-center [&>span]:rounded-md [&>span]:text-xs"
        aria-hidden
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block font-semibold">{name}</span>
        <span className="block">{plans}</span>
      </span>
      <span
        className={cn(
          'mt-0.5 size-4 shrink-0 rounded-full border',
          checked && 'border-foreground border-[5px]',
        )}
        aria-hidden
      />
    </button>
  )
}

/**
 * The paste form. The token lives in the field only until it is sent, and
 * then in a ref only until the server answers: the field is a password
 * field, never autocompleted, and emptied on submit; the ref is emptied and
 * the mutation reset the moment the call settles, so react-query's cache
 * never holds the token as the call's variables. The request is never
 * aborted (the server answers within about 9 s in every branch; an abort
 * could cancel the save and make "Saved" untrue).
 */
function ClaudeConnect({
  replacing = false,
  onDone,
  onCancel,
}: {
  replacing?: boolean
  /** The server has the token. */
  onDone?: () => void
  /** Shows a Cancel button that calls it. */
  onCancel?: () => void
}) {
  const { setAgent, reread } = useAgentCache()
  const fieldId = useId()
  const [token, setToken] = useState('')
  const [formatChecked, setFormatChecked] = useState(false)
  const [failure, setFailure] = useState<ReactNode>(null)
  const [slow, setSlow] = useState(false)
  const sending = useRef('')
  const connect = useMutation({
    mutationFn: () => connectClaudeSubscription(sending.current),
    onSuccess: async (result) => {
      await setAgent(result.agent)
      trackAgentChosen('claude')
      trackAgentConnected({ verified: result.verified, via: result.via })
      if (result.verified) notifySuccess('Claude Code is connected.')
      else notifySuccess("Saved. We'll check it when your computer starts.")
      onDone?.()
    },
    onError: (error) => {
      const code = refusalCode(error)
      trackAgentFailed(code ?? 'unknown')
      if (code === undefined) reread()
      setFailure(connectErrorCopy(error))
    },
    onSettled: () => {
      sending.current = ''
      connect.reset()
    },
  })
  const pending = connect.isPending
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setSlow(true), STILL_CHECKING_MS)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [pending])

  const cleaned = cleanToken(token)
  const badFormat =
    formatChecked && cleaned !== '' && !SETUP_TOKEN.test(cleaned)
  const error = badFormat
    ? cleaned.startsWith('sk-ant-oat01-')
      ? CUT_OFF_ERROR
      : FORMAT_ERROR
    : failure

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        setFormatChecked(true)
        if (pending) return
        if (!SETUP_TOKEN.test(cleaned)) {
          if (cleaned !== '') trackAgentFailed('computer_agent_token_format')
          return
        }
        sending.current = cleaned
        setToken('')
        setFormatChecked(false)
        setFailure(null)
        connect.mutate()
      }}
    >
      <ol className="bg-muted/60 text-foreground space-y-3 rounded-lg p-4">
        <li className="flex gap-3">
          <span className="text-muted-foreground w-3 shrink-0">1</span>
          <div className="min-w-0 flex-1 space-y-2">
            <p>Run</p>
            <CopyRow value="claude setup-token" />
          </div>
        </li>
        <li className="flex gap-3">
          <span className="text-muted-foreground w-3 shrink-0">2</span>
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor={fieldId} className="block">
              Paste the token
            </label>
            <Input
              id={fieldId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-oat01-…"
              className="bg-panel h-9 font-mono"
              value={token}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setToken(event.target.value)
                if (failure) setFailure(null)
              }}
              // The format check runs on paste, before anything is sent.
              onPaste={() => setFormatChecked(true)}
              onBlur={() => setFormatChecked(true)}
            />
          </div>
        </li>
      </ol>
      {error ? (
        <p
          id={`${fieldId}-error`}
          role="alert"
          className="text-destructive text-sm"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {pending
            ? slow
              ? 'Still checking…'
              : 'Checking…'
            : replacing
              ? 'Replace token'
              : 'Connect Claude Code'}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      <p className="text-xs">Stored sealed. Sessions never see it.</p>
    </form>
  )
}

const HEALTH: Record<
  NonNullable<ComputerAgent['subscription']>['health'],
  string
> = {
  ok: 'Connected',
  unchecked: "Saved. We'll check it when your computer starts.",
  paused: 'Paused. Threads run on free credits.',
  limited: 'At its limit. Threads run on free credits',
  invalid: 'This token stopped working. Replace it, or resume once fixed.',
}

function healthLine(
  subscription: NonNullable<ComputerAgent['subscription']>,
): string {
  if (subscription.health !== 'limited') return HEALTH[subscription.health]
  if (!subscription.limitedUntil) return `${HEALTH.limited}.`
  const until = new Date(subscription.limitedUntil)
  return Number.isNaN(until.getTime())
    ? `${HEALTH.limited}.`
    : `${HEALTH.limited} until ${until.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })}.`
}

/**
 * What runs the person's threads, and its housekeeping: health, Resume,
 * Replace, Disconnect; or how to connect one. The Your agent card after
 * setup.
 */
export function AgentManage({
  agent,
  slackInstalled,
}: {
  agent: ComputerAgent
  slackInstalled: boolean
}) {
  const { setAgent, reread } = useAgentCache()
  const [replacing, setReplacing] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const resume = useMutation({
    mutationFn: resumeClaudeSubscription,
    onSuccess: async (next) => {
      await setAgent(next)
      notifySuccess('Resumed.')
    },
    onError: (error) => {
      if (refusalCode(error) === undefined) reread()
      notifyError("Couldn't resume.", error)
    },
  })
  const disconnect = useMutation({
    mutationFn: disconnectClaudeSubscription,
    onSuccess: () => {
      setConfirmDisconnect(false)
      notifySuccess('Claude Code is disconnected.')
      reread()
    },
    onError: (error) => notifyError("Couldn't disconnect.", error),
  })
  const { subscription } = agent

  const linked = linkedSlackUserLine(agent, slackInstalled)
  const linkedLine = linked ? <p>{linked}</p> : null

  if (!subscription) {
    // After Slack, a person not linked to a Slack user connects there: the
    // token belongs to whoever asks in Slack.
    if (slackInstalled && !agent.linked) {
      return (
        <div className="text-muted-foreground space-y-2 text-sm">
          <p className="text-foreground font-medium">{agentSummary(agent)}</p>
          <p>{SLACK_INSTRUCTION}</p>
        </div>
      )
    }
    return (
      <div className="text-muted-foreground space-y-4 text-sm">
        <p className="text-foreground font-medium">{agentSummary(agent)}</p>
        {linkedLine}
        <ClaudeConnect />
      </div>
    )
  }

  const canResume =
    subscription.health === 'paused' || subscription.health === 'invalid'
  return (
    <div className="text-muted-foreground space-y-4 text-sm">
      <div className="space-y-1">
        <p className="text-foreground font-medium">{agentSummary(agent)}</p>
        <p
          className={cn(
            subscription.health === 'invalid' && 'text-destructive',
          )}
        >
          {healthLine(subscription)}
        </p>
        {linkedLine}
      </div>
      {replacing ? (
        <ClaudeConnect
          replacing
          onDone={() => setReplacing(false)}
          onCancel={() => setReplacing(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {canResume ? (
            <Button
              size="sm"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
            >
              {resume.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Resume
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReplacing(true)}
          >
            Replace
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => setConfirmDisconnect(true)}
          >
            Disconnect
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Claude Code?"
        description={`Threads run on free credits (${agent.managedModel}) until you connect it again.`}
        confirmLabel="Disconnect"
        destructive
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </div>
  )
}

/**
 * Step 1's done row action: the same three ways to go as step 1, in a
 * dialog that closes once the server has the change.
 */
export function AgentChangeAction({ agent }: { agent: ComputerAgent }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<AgentCardChoice>(
    agent.choice === 'codex' ? 'codex' : 'claude',
  )
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Change
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your coding agent</DialogTitle>
            <DialogDescription>Now on {agentSummary(agent)}.</DialogDescription>
          </DialogHeader>
          <div className="text-muted-foreground space-y-4 text-sm">
            <AgentSetup
              agent={agent}
              selected={selected}
              onSelect={setSelected}
              onDone={() => setOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** The Your agent card on the page once setup is done. */
export function AgentCard({ status }: { status: ComputerStatus }) {
  if (!status.agent) return null
  return (
    <section aria-labelledby="computer-agent">
      <h2 id="computer-agent" className="mb-3 text-sm font-semibold">
        Your agent
      </h2>
      <div className="bg-panel rounded-lg border px-5 py-4">
        <AgentManage
          agent={status.agent}
          slackInstalled={status.slack.installed}
        />
      </div>
    </section>
  )
}

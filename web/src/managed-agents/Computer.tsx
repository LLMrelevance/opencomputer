import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import {
  Check,
  Computer as ComputerIcon,
  ExternalLink,
  GitPullRequest,
  Hash,
  Lightbulb,
  Loader2,
  MessagesSquare,
  Moon,
  RotateCcw,
  Send,
  Sparkles,
  Terminal,
  Unplug,
  UsersRound,
  X,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import { CopyRow } from '@/components/copy-row'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { AuthContext } from '@/hooks/useAuth'
import { addManagedGitHubConnection } from './api'
import { launchAuthorizationWindow } from './authorization-window'
import {
  computerQueryKey,
  computerSessionsQueryKey,
  createComputer,
  getComputer,
  getComputerSessions,
  startComputerSlackInstall,
  unlinkComputerSlack,
  type ComputerSession,
  type ComputerStatus,
} from './computer-api'
import {
  EXAMPLE_ASKS,
  SLACK_RETURN_PARAMS,
  alreadyLinkedCopy,
  SESSION_STATUS,
  START_SESSION_COPY,
  compactStatusLine,
  computerChecklist,
  computerIsOnboarded,
  computerPollInterval,
  computerPresentation,
  heroCopy,
  relativeTime,
  sessionPollInterval,
  slackReturnFromSearch,
  splitSessions,
  type ChecklistStep,
} from './computer-state'

export default function ComputerPage() {
  // Behind the rollout flag (work 052): an organization without its computer
  // goes to its projects. Rendered outside an AuthProvider (tests), no gate.
  const auth = useContext(AuthContext)
  if (auth?.user && !auth.user.computerEnabled)
    return <Navigate to="/" replace />
  return <ComputerPageContent />
}

function ComputerPageContent() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
    refetchInterval: (query) => computerPollInterval(query.state.data),
  })
  const hasComputer = Boolean(status.data?.computer)
  const sessions = useQuery({
    queryKey: computerSessionsQueryKey,
    queryFn: getComputerSessions,
    // Sessions run on the computer; there are none to ask for before it exists.
    enabled: hasComputer,
    refetchInterval: (query) => sessionPollInterval(query.state.data),
  })

  // The first visit creates the organization's computer. The call is
  // idempotent, so a second tab or a reload racing this one is harmless.
  const create = useMutation({
    mutationFn: createComputer,
    onSuccess: (next) => queryClient.setQueryData(computerQueryKey, next),
  })
  const { mutate: createNow } = create
  const createStarted = useRef(false)
  useEffect(() => {
    if (status.data?.computer !== null || createStarted.current) return
    createStarted.current = true
    createNow()
  }, [status.data?.computer, createNow])

  // Slack's install redirect lands here with ?slack=connected|error. A
  // workspace that is another organization's gets a panel, not a toast: the
  // person is welcome, they just need an invite. The redirect is a full page
  // load, so the panel's state is read once, from the URL it arrived with;
  // the effect below then cleans the URL.
  const [alreadyLinked, setAlreadyLinked] = useState(() => {
    const slackReturn = slackReturnFromSearch(searchParams)
    return slackReturn?.kind === 'already_linked'
      ? { notified: slackReturn.notified }
      : null
  })
  const handledSlackReturn = useRef<string | null>(null)
  useEffect(() => {
    const slackReturn = slackReturnFromSearch(searchParams)
    if (!slackReturn) return
    const key = searchParams.toString()
    if (handledSlackReturn.current === key) return
    handledSlackReturn.current = key
    if (slackReturn.kind === 'connected') {
      notifySuccess('Slack is connected.', START_SESSION_COPY)
    } else if (slackReturn.kind === 'error') {
      notifyError("Couldn't connect Slack.", new Error(slackReturn.message))
    }
    void queryClient.invalidateQueries({ queryKey: computerQueryKey })
    const next = new URLSearchParams(searchParams)
    for (const param of SLACK_RETURN_PARAMS) next.delete(param)
    setSearchParams(next, { replace: true })
  }, [queryClient, searchParams, setSearchParams])

  if (status.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (status.isError || !status.data) {
    return (
      <Panel>
        <EmptyState
          icon={ComputerIcon}
          title="Your computer is temporarily unavailable"
          description="Try loading this page again."
          action={
            <Button variant="outline" onClick={() => void status.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  const { live, recent } = splitSessions(sessions.data ?? [])
  const sessionsLoading = hasComputer && sessions.isLoading
  const createError = create.isError ? create.error : null
  const alreadyLinkedPanel = alreadyLinked ? (
    <AlreadyLinked
      notified={alreadyLinked.notified}
      status={status.data}
      onDismiss={() => setAlreadyLinked(null)}
    />
  ) : null

  // Once it is in Slack and knows the code, the page is about the work.
  if (computerIsOnboarded(status.data)) {
    return (
      <div className="mx-auto max-w-5xl space-y-8">
        {alreadyLinkedPanel}
        <CompactHeader
          status={status.data}
          liveCount={live.length}
          createError={createError}
          creating={create.isPending}
          onRetry={() => create.mutate()}
        />
        <LiveNow
          sessions={live}
          readAt={sessions.dataUpdatedAt}
          loading={sessionsLoading}
          failed={sessions.isError}
        />
        <SessionsPanel
          title="Recent"
          description="Finished and waiting threads, newest first."
          emptyTitle="Nothing here yet"
          emptyDescription="Finished work lands here."
          hasComputer={hasComputer}
          sessions={recent}
          readAt={sessions.dataUpdatedAt}
          loading={sessionsLoading}
          failed={sessions.isError}
        />
        <IdeasToTry />
        <CliFooter />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {alreadyLinkedPanel}
      <Hero
        status={status.data}
        createError={createError}
        creating={create.isPending}
        onRetry={() => create.mutate()}
      />
      <Reasons />
      <Checklist status={status.data} sessions={sessions.data} />
      <TryAsking />
      <SessionsPanel
        title="Sessions"
        description="Work your computer is doing for your team, newest first."
        emptyTitle="No sessions yet"
        emptyDescription={START_SESSION_COPY}
        hasComputer={hasComputer}
        sessions={[...live, ...recent]}
        readAt={sessions.dataUpdatedAt}
        loading={sessionsLoading}
        failed={sessions.isError}
      />
      <CliFooter />
    </div>
  )
}

function CliFooter() {
  return (
    <Panel>
      <PanelContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Terminal className="text-muted-foreground size-4" aria-hidden />
          <p className="text-muted-foreground text-sm">
            Build and deploy agents of your own with the OpenComputer CLI.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/new">Create an agent</Link>
        </Button>
      </PanelContent>
    </Panel>
  )
}

/** Re-renders on an interval so relative times stay true between polls. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

type DotTone = 'alive' | 'busy' | 'failed' | 'quiet'

function PulseDot({ tone, className }: { tone: DotTone; className?: string }) {
  const pulsing = tone === 'alive' || tone === 'busy'
  return (
    <span className={cn('relative flex size-2', className)} aria-hidden>
      {pulsing ? (
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-75',
            tone === 'alive' ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
      ) : null}
      <span
        className={cn(
          'relative inline-flex size-full rounded-full',
          tone === 'alive'
            ? 'bg-emerald-500'
            : tone === 'busy'
              ? 'bg-amber-500'
              : tone === 'failed'
                ? 'bg-red-500'
                : 'bg-muted-foreground',
        )}
      />
    </span>
  )
}

/** The computer's state as a dot tone, shared by the hero and the header. */
function computerDot(status: ComputerStatus, failedToCreate: boolean): DotTone {
  const { computer } = status
  if (failedToCreate || computer?.state === 'failed') return 'failed'
  if (computer?.state === 'ready' && computer.connected) return 'alive'
  if (
    !computer ||
    computer.state === 'provisioning' ||
    computer.state === 'waking' ||
    computer.state === 'ready'
  ) {
    return 'busy'
  }
  return 'quiet'
}

function StatusPill({
  status,
  failedToCreate,
}: {
  status: ComputerStatus
  failedToCreate: boolean
}) {
  return (
    <div className="bg-background/70 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur">
      <PulseDot tone={computerDot(status, failedToCreate)} />
      {failedToCreate
        ? 'Failed'
        : computerPresentation(status.computer, status.plan).label}
    </div>
  )
}

function RetryButton({
  creating,
  onRetry,
  className,
}: {
  creating: boolean
  onRetry: () => void
  className?: string
}) {
  return (
    <Button className={className} disabled={creating} onClick={onRetry}>
      {creating ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <RotateCcw className="size-4" aria-hidden />
      )}
      Try again
    </Button>
  )
}

function CompactHeader({
  status,
  liveCount,
  createError,
  creating,
  onRetry,
}: {
  status: ComputerStatus
  liveCount: number
  createError: Error | null
  creating: boolean
  onRetry: () => void
}) {
  const { computer } = status
  const failedToCreate = !computer && createError !== null
  const line = failedToCreate
    ? { headline: 'Something went wrong.', detail: createError.message }
    : compactStatusLine(computer, status.plan, liveCount)
  const offerUpgrade = computer?.state === 'parked' && status.plan === 'free'
  const canRetry = failedToCreate || computer?.state === 'failed'
  const accounts = status.github.installations.map(
    (installation) => installation.accountLogin,
  )
  return (
    <section className="from-primary/10 via-panel to-panel relative overflow-hidden rounded-2xl border bg-linear-to-br px-6 py-6 sm:px-8">
      <div
        className="bg-primary/15 pointer-events-none absolute -top-20 -right-16 size-56 rounded-full blur-3xl"
        aria-hidden
      />
      <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="min-w-0">
          <StatusPill status={status} failedToCreate={failedToCreate} />
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {line.headline}
          </h1>
          {line.detail ? (
            <p className="text-muted-foreground mt-1.5 text-sm">
              {offerUpgrade ? (
                <Link
                  to="/billing"
                  className="text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4 transition-colors"
                >
                  {line.detail}
                </Link>
              ) : (
                line.detail
              )}
            </p>
          ) : null}
          {canRetry ? (
            <RetryButton
              className="mt-4"
              creating={creating}
              onRetry={onRetry}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="bg-background/70 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1 backdrop-blur">
            <Hash className="size-3.5" aria-hidden />
            <span className="sr-only">Slack: </span>
            {status.slack.teamName ?? 'Slack'}
          </span>
          <span
            className="bg-background/70 text-muted-foreground inline-flex max-w-64 items-center gap-1.5 rounded-full border px-3 py-1 backdrop-blur"
            title={accounts.join(', ')}
          >
            <GithubMark className="size-3.5 shrink-0" />
            <span className="sr-only">GitHub: </span>
            <span className="truncate">
              {accounts.length ? accounts.join(', ') : 'GitHub'}
            </span>
          </span>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/managed-agents/connections">Manage</Link>
          </Button>
          <SlackAction status={status} compact />
        </div>
      </div>
    </section>
  )
}

function LiveNow({
  sessions,
  readAt,
  loading,
  failed,
}: {
  sessions: ComputerSession[]
  /** When the sessions were read; relative times never predate it. */
  readAt: number
  loading: boolean
  failed: boolean
}) {
  const now = Math.max(useNow(30_000), readAt)
  return (
    <section aria-labelledby="live-now">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="live-now" className="text-lg font-semibold tracking-tight">
          Live now
        </h2>
        {sessions.length > 0 ? (
          <span className="text-muted-foreground text-sm">
            {sessions.length === 1
              ? '1 session in flight'
              : `${sessions.length} sessions in flight`}
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className="h-36 rounded-xl" />
      ) : sessions.length > 0 ? (
        <div
          className={cn('grid gap-4', sessions.length > 1 && 'sm:grid-cols-2')}
        >
          {sessions.map((session) => (
            <LiveCard key={session.key} session={session} now={now} />
          ))}
        </div>
      ) : failed ? (
        <div className="bg-panel text-muted-foreground rounded-xl border px-6 py-8 text-center text-sm">
          Sessions are temporarily unavailable. They reload by themselves.
        </div>
      ) : (
        <QuietNow />
      )}
    </section>
  )
}

function LiveCard({ session, now }: { session: ComputerSession; now: number }) {
  const busy = session.status === 'busy'
  return (
    <article
      className={cn(
        'bg-panel relative overflow-hidden rounded-xl border bg-linear-to-br to-transparent p-6 shadow-sm',
        busy ? 'from-emerald-500/[0.06]' : 'from-amber-500/[0.06]',
      )}
    >
      <div
        className={cn(
          'absolute inset-x-0 top-0 h-0.5 bg-linear-to-r from-transparent to-transparent',
          busy ? 'via-emerald-500' : 'via-amber-500',
        )}
        aria-hidden
      />
      <div className="flex items-center gap-2.5 text-sm">
        <PulseDot tone={busy ? 'alive' : 'busy'} className="size-2.5" />
        <span
          className={cn(
            'font-medium',
            busy
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-amber-600 dark:text-amber-400',
          )}
        >
          {busy ? 'Working…' : 'Starting…'}
        </span>
        <span className="text-muted-foreground">·</span>
        <time
          className="text-muted-foreground"
          dateTime={session.updatedAt}
          title={new Date(session.updatedAt).toLocaleString()}
        >
          {relativeTime(session.updatedAt, now)}
        </time>
      </div>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <h3 className="min-w-0 flex-1 text-xl font-semibold tracking-tight text-balance">
          {session.title || 'Untitled session'}
        </h3>
        {session.slackUrl ? (
          <Button variant="outline" asChild>
            <a href={session.slackUrl} target="_blank" rel="noreferrer">
              Open in Slack
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        ) : null}
      </div>
    </article>
  )
}

function QuietNow() {
  return (
    <div className="bg-panel rounded-xl border border-dashed px-6 py-10 text-center">
      <Sparkles className="text-primary mx-auto size-5" aria-hidden />
      <p className="mt-3 font-medium">Quiet right now.</p>
      <p className="text-muted-foreground mt-1 text-sm">
        Mention @OpenComputer in Slack to hand it something.
      </p>
      <CopyRow
        value={`@OpenComputer ${EXAMPLE_ASKS[0]}`}
        className="mx-auto mt-5 max-w-2xl text-left"
      />
    </div>
  )
}

function IdeasToTry() {
  return (
    <details className="group bg-panel rounded-xl border">
      <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Lightbulb className="size-4" aria-hidden />
        Ideas to try
        <span className="ml-auto text-xs transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="grid gap-2 px-5 pb-5">
        {EXAMPLE_ASKS.map((ask) => (
          <CopyRow key={ask} value={`@OpenComputer ${ask}`} />
        ))}
      </div>
    </details>
  )
}

function Hero({
  status,
  createError,
  creating,
  onRetry,
}: {
  status: ComputerStatus
  createError: Error | null
  creating: boolean
  onRetry: () => void
}) {
  const { computer } = status
  const failedToCreate = !computer && createError !== null
  const copy = failedToCreate
    ? { headline: 'Something went wrong.', subline: createError.message }
    : heroCopy(computer, status.plan)
  const canRetry = failedToCreate || computer?.state === 'failed'
  return (
    <section className="from-primary/10 via-panel to-panel relative overflow-hidden rounded-2xl border bg-linear-to-br px-8 py-12 sm:px-12 sm:py-16">
      <div
        className="bg-primary/15 pointer-events-none absolute -top-24 -right-24 size-72 rounded-full blur-3xl"
        aria-hidden
      />
      <div className="relative max-w-3xl">
        <StatusPill status={status} failedToCreate={failedToCreate} />
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          {copy.headline}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg text-balance">
          {copy.subline}
        </p>
        {canRetry ? (
          <RetryButton className="mt-8" creating={creating} onRetry={onRetry} />
        ) : null}
      </div>
    </section>
  )
}

/**
 * Someone tried to link a Slack workspace that already works with
 * OpenComputer in another organization. Not an error: their team is already
 * here, and the way in is an invite (the person who set it up may have been
 * asked in Slack already).
 */
function AlreadyLinked({
  notified,
  status,
  onDismiss,
}: {
  notified: boolean
  status: ComputerStatus
  onDismiss: () => void
}) {
  const copy = alreadyLinkedCopy(notified)
  return (
    <section
      aria-labelledby="already-linked-title"
      className="from-primary/10 via-panel to-panel relative overflow-hidden rounded-2xl border bg-linear-to-br px-8 py-8 sm:px-10"
    >
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-3 right-3"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" aria-hidden />
      </Button>
      <div className="flex gap-5">
        <div className="bg-primary/15 text-primary flex size-11 shrink-0 items-center justify-center rounded-full">
          <UsersRound className="size-5" aria-hidden />
        </div>
        <div className="max-w-2xl min-w-0 pr-8">
          <h2
            id="already-linked-title"
            className="text-2xl font-semibold tracking-tight text-balance"
          >
            {copy.headline}
          </h2>
          <p className="text-muted-foreground mt-2 text-balance">{copy.body}</p>
          {status.slack.installed ? null : (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <span className="text-muted-foreground text-sm">
                Or connect a different Slack workspace
              </span>
              <SlackInstallButton variant="outline" />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

const REASONS = [
  {
    icon: MessagesSquare,
    title: 'Lives in Slack',
    body: 'Mention it in any thread. It picks up the context, does the work and reports back, right there.',
  },
  {
    icon: GitPullRequest,
    title: 'Works in your real code',
    body: 'Your repositories, your stack. It reads, runs and fixes, then hands you a pull request to review.',
  },
  {
    icon: Moon,
    title: 'Never logs off',
    body: 'Hand it the slow stuff at 6pm. It is still on it at 3am, and it remembers where everything is.',
  },
] as const

function Reasons() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {REASONS.map(({ icon: Icon, title, body }) => (
        <div key={title} className="bg-panel rounded-xl border p-5">
          <Icon className="text-primary size-5" aria-hidden />
          <p className="mt-3 font-medium">{title}</p>
          <p className="text-muted-foreground mt-1 text-sm">{body}</p>
        </div>
      ))}
    </div>
  )
}

function TryAsking() {
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Not sure where to start?</PanelTitle>
          <PanelDescription className="mt-1">
            Paste one of these into Slack. Then give it the thing you have been
            putting off.
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent className="grid gap-2">
        {EXAMPLE_ASKS.map((ask) => (
          <CopyRow key={ask} value={`@OpenComputer ${ask}`} />
        ))}
      </PanelContent>
    </Panel>
  )
}

function Checklist({
  status,
  sessions,
}: {
  status: ComputerStatus
  sessions: ComputerSession[] | undefined
}) {
  // The computer itself is the hero; these are the three things a person does.
  const [, slackStep, githubStep, sessionStep] = computerChecklist(
    status,
    sessions,
  )
  const steps = [slackStep, githubStep, sessionStep]
  const done = steps.filter((step) => step.done).length
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>
            {done === steps.length
              ? 'You are all set.'
              : 'Three steps to your first hand-off'}
          </PanelTitle>
          <PanelDescription className="mt-1">
            {done === steps.length
              ? 'It is part of the team now. Keep it busy.'
              : `${done} of ${steps.length} done. Takes about two minutes.`}
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent className="p-0">
        <ol className="divide-y">
          <Step
            number={1}
            step={{ ...slackStep, title: 'Invite it to Slack' }}
            action={<SlackAction status={status} />}
          >
            {status.slack.installed
              ? `It is in ${status.slack.teamName ?? 'your Slack workspace'}.`
              : 'Where your team already talks. One click, no setup.'}
          </Step>
          <Step
            number={2}
            step={{ ...githubStep, title: 'Give it your code' }}
            action={<GitHubAction connected={status.github.connected} />}
          >
            {githubSummary(status.github)}
          </Step>
          <Step number={3} step={{ ...sessionStep, title: 'Say hello' }}>
            {START_SESSION_COPY}
          </Step>
        </ol>
      </PanelContent>
    </Panel>
  )
}

function githubSummary(github: ComputerStatus['github']) {
  if (!github.connected) {
    return 'Pick the repositories it should know. It never pushes to main unless you ask.'
  }
  const accounts = github.installations.map(
    (installation) => installation.accountLogin,
  )
  return accounts.length
    ? `It knows the code in ${accounts.join(', ')}.`
    : 'GitHub is connected.'
}

function Step({
  number,
  step,
  action,
  children,
}: {
  number: number
  step: ChecklistStep
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <li className="flex flex-wrap items-center gap-4 px-5 py-4">
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold',
          step.done && 'bg-primary text-primary-foreground border-primary',
        )}
        aria-hidden
      >
        {step.done ? <Check className="size-4" /> : number}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {step.title}
          <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
        </p>
        <p className="text-muted-foreground mt-0.5 text-sm">{children}</p>
      </div>
      {/* Reserve the action column so rows align with or without one. */}
      <div className="flex min-w-36 justify-end">{action}</div>
    </li>
  )
}

function SlackAction({
  status,
  compact = false,
}: {
  status: ComputerStatus
  compact?: boolean
}) {
  const queryClient = useQueryClient()
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const unlink = useMutation({
    mutationFn: unlinkComputerSlack,
    onSuccess: async () => {
      setConfirmUnlink(false)
      await queryClient.invalidateQueries({ queryKey: computerQueryKey })
      notifySuccess(
        'Slack workspace unlinked.',
        'Remove the app in Slack to uninstall it there too.',
      )
    },
    onError: (error) => notifyError("Couldn't unlink Slack.", error),
  })

  if (!status.slack.installed) return <SlackInstallButton />
  const teamName = status.slack.teamName ?? 'this Slack workspace'
  return (
    <>
      <Button
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'sm' : 'default'}
        className={cn(compact && 'text-muted-foreground')}
        onClick={() => setConfirmUnlink(true)}
      >
        <Unplug className={compact ? 'size-3.5' : 'size-4'} aria-hidden />
        {compact ? 'Unlink Slack' : 'Unlink'}
      </Button>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title={`Unlink ${teamName}?`}
        description="Your computer stops answering in this workspace. The app stays installed in Slack until you remove it there, and you can link a workspace again at any time."
        confirmLabel="Unlink Slack"
        destructive
        pending={unlink.isPending}
        onConfirm={() => unlink.mutate()}
      />
    </>
  )
}

function SlackInstallButton({
  variant = 'default',
}: {
  variant?: 'default' | 'outline'
}) {
  const install = useMutation({
    mutationFn: startComputerSlackInstall,
    onSuccess: (url) => window.location.assign(url),
    onError: (error) => notifyError("Couldn't start the Slack install.", error),
  })
  return (
    <Button
      variant={variant}
      // Stays pending through the navigation to Slack.
      disabled={install.isPending || install.isSuccess}
      onClick={() => install.mutate()}
    >
      {install.isPending || install.isSuccess ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Send className="size-4" aria-hidden />
      )}
      Install Slack app
    </Button>
  )
}

function GitHubAction({ connected }: { connected: boolean }) {
  const [starting, setStarting] = useState(false)
  if (connected) {
    return (
      <Button variant="outline" asChild>
        <Link to="/managed-agents/connections">Manage</Link>
      </Button>
    )
  }
  return (
    <Button
      disabled={starting}
      onClick={() => {
        setStarting(true)
        // The same managed GitHub App install as Connections; the page picks
        // the new installation up when it is next read (on focus or poll).
        void launchAuthorizationWindow(() =>
          addManagedGitHubConnection('install'),
        )
          .catch((error: unknown) =>
            notifyError("Couldn't start the GitHub installation.", error),
          )
          .finally(() => setStarting(false))
      }}
    >
      {starting ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <GithubMark className="size-4" />
      )}
      Connect GitHub
    </Button>
  )
}

function sessionColumns(now: number): Column<ComputerSession>[] {
  return [
    {
      key: 'title',
      header: 'Session',
      cell: (session) => (
        <span className="block max-w-md truncate font-medium">
          {session.title || 'Untitled session'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (session) => (
        <StatusBadge
          status={SESSION_STATUS[session.status].badge}
          label={SESSION_STATUS[session.status].label}
        />
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      cell: (session) => (
        <time
          className="text-muted-foreground whitespace-nowrap"
          dateTime={session.updatedAt}
          title={new Date(session.updatedAt).toLocaleString()}
        >
          {relativeTime(session.updatedAt, now)}
        </time>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Open</span>,
      align: 'right',
      cell: (session) =>
        session.slackUrl ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={session.slackUrl} target="_blank" rel="noreferrer">
              Open in Slack
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        ) : null,
    },
  ]
}

function SessionsPanel({
  title,
  description,
  emptyTitle,
  emptyDescription,
  hasComputer,
  sessions,
  readAt,
  loading,
  failed,
}: {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  hasComputer: boolean
  sessions: ComputerSession[]
  readAt: number
  loading: boolean
  failed: boolean
}) {
  const now = Math.max(useNow(30_000), readAt)
  const columns = useMemo(() => sessionColumns(now), [now])
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>{title}</PanelTitle>
          <PanelDescription className="mt-1">{description}</PanelDescription>
        </div>
      </PanelHeader>
      <ResourceTable
        columns={columns}
        rows={sessions}
        rowKey={(session) => session.key}
        loading={loading}
        skeletonRows={3}
        empty={
          <EmptyState
            icon={MessagesSquare}
            title={
              failed
                ? 'Sessions are temporarily unavailable'
                : hasComputer
                  ? emptyTitle
                  : 'Sessions appear once your computer is set up'
            }
            description={
              failed ? 'They reload by themselves.' : emptyDescription
            }
          />
        }
      />
    </Panel>
  )
}

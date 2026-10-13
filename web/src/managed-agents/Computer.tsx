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
  ArrowRight,
  Check,
  Computer as ComputerIcon,
  ExternalLink,
  Hash,
  Lightbulb,
  Loader2,
  MessagesSquare,
  RotateCcw,
  Send,
  TriangleAlert,
  Unplug,
  UsersRound,
  X,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import { CopyRow } from '@/components/copy-row'
import { Panel } from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
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
  SETUP_STEPS,
  SLACK_RETURN_PARAMS,
  alreadyLinkedCopy,
  SESSION_STATUS,
  START_SESSION_COPY,
  computerIsOnboarded,
  computerPollInterval,
  computerPresentation,
  relativeTime,
  sessionIsLive,
  sessionPollInterval,
  setupStep,
  slackReturnFromSearch,
  splitSessions,
  type SetupStep,
  type SlackReturn,
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

  // The computer comes alive when the organization installs the Slack app
  // (the install's callback claims or creates it; work 052, Mohamed
  // 2026-10-13), never on a visit: most organizations only look, and each
  // computer is a VM. A visit only creates one when Slack is already
  // installed and the computer is still missing (the install's claim
  // failed), and Try again retries a failed one. The call is idempotent.
  const create = useMutation({
    mutationFn: createComputer,
    onSuccess: (next) => queryClient.setQueryData(computerQueryKey, next),
  })
  const { mutate: createNow } = create
  const createStarted = useRef(false)
  const missingAfterInstall =
    status.data?.computer === null && status.data.slack.installed
  useEffect(() => {
    if (!missingAfterInstall || createStarted.current) return
    createStarted.current = true
    createNow()
  }, [missingAfterInstall, createNow])

  // Slack's install redirect lands here with ?slack=connected|error. A
  // failed install gets a panel that stays until dismissed, not a toast that
  // is gone before anyone reads it; a workspace that is another
  // organization's gets its own panel: the person is welcome, they just need
  // an invite. The redirect is a full page load, so the panel's state is read
  // once, from the URL it arrived with; the effect below then cleans the URL.
  const [slackProblem, setSlackProblem] = useState<Exclude<
    SlackReturn,
    { kind: 'connected' } | null
  > | null>(() => {
    const slackReturn = slackReturnFromSearch(searchParams)
    return slackReturn?.kind === 'connected' ? null : slackReturn
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
  const dismissSlackProblem = () => setSlackProblem(null)
  const slackProblemPanel =
    slackProblem?.kind === 'already_linked' ? (
      <AlreadyLinked
        notified={slackProblem.notified}
        status={status.data}
        onDismiss={dismissSlackProblem}
      />
    ) : slackProblem?.kind === 'error' ? (
      <SlackInstallFailed
        message={slackProblem.message}
        status={status.data}
        onDismiss={dismissSlackProblem}
      />
    ) : null

  // Whether the first mention is still to come decides between setup and the
  // work, so wait for the sessions rather than flash one and then the other.
  if (sessionsLoading && computerIsOnboarded(status.data)) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  // Once it is in Slack, knows the code and has had its first mention, the
  // page is about the work.
  const step = setupStep(status.data, sessions.data)
  if (step === null) {
    return (
      <div className="mx-auto max-w-4xl space-y-8 pt-2 sm:pt-8">
        {slackProblemPanel}
        <Overview
          status={status.data}
          createError={createError}
          creating={create.isPending}
          onRetry={() => create.mutate()}
        />
        <SessionsPanel
          live={live}
          recent={recent}
          readAt={sessions.dataUpdatedAt}
          loading={sessionsLoading}
          failed={sessions.isError}
        />
        <IdeasToTry />
        <CustomAgentLink />
      </div>
    )
  }

  return (
    <Setup
      status={status.data}
      step={step}
      notice={slackProblemPanel}
      createError={createError}
      creating={create.isPending}
      onRetry={() => create.mutate()}
    />
  )
}

/**
 * Projects are for building agents of your own: a side door, kept out of the
 * way of the computer.
 */
function CustomAgentLink() {
  return (
    <p className="text-muted-foreground pt-4 text-center text-xs">
      <Link
        to="/new"
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
      >
        Set up a custom agent on OpenComputer infrastructure
        <ArrowRight className="size-3" aria-hidden />
      </Link>
    </p>
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
  // Not set up yet: nothing is happening until Slack is installed.
  if (!computer && !status.slack.installed) return 'quiet'
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
        : computerPresentation(
            status.computer,
            status.plan,
            status.slack.installed,
          ).label}
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

function Overview({
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
  const offerUpgrade = computer?.state === 'parked' && status.plan === 'free'
  // Only what needs attention: the status speaks for itself otherwise.
  const problem = failedToCreate
    ? createError.message
    : computer?.state === 'failed'
      ? (computer.lastError ??
        'Your computer could not start. Try again, or tell us if it keeps happening.')
      : null
  const canRetry = failedToCreate || computer?.state === 'failed'
  const accounts = status.github.installations.map(
    (installation) => installation.accountLogin,
  )
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Computer</h1>
        <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-sm">
          <PulseDot tone={computerDot(status, failedToCreate)} />
          <span className="text-foreground font-medium">
            {failedToCreate
              ? 'Failed'
              : computerPresentation(computer, status.plan, true).label}
          </span>
          {offerUpgrade ? (
            <>
              <span aria-hidden>·</span>
              <Link
                to="/billing"
                className="decoration-muted-foreground/40 hover:text-foreground underline underline-offset-4 transition-colors"
              >
                Upgrade and it never sleeps
              </Link>
            </>
          ) : null}
          {problem ? (
            <>
              <span aria-hidden>·</span>
              <span>{problem}</span>
            </>
          ) : null}
        </p>
        {canRetry ? (
          <RetryButton className="mt-4" creating={creating} onRetry={onRetry} />
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Hash className="size-3.5" aria-hidden />
          <span className="sr-only">Slack: </span>
          {status.slack.teamName ?? 'Slack'}
        </span>
        <span
          className="inline-flex max-w-56 items-center gap-1.5"
          title={accounts.join(', ')}
        >
          <GithubMark className="size-3.5 shrink-0" />
          <span className="sr-only">GitHub: </span>
          <span className="truncate">
            {accounts.length ? accounts.join(', ') : 'GitHub'}
          </span>
        </span>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            asChild
          >
            <Link to="/managed-agents/connections">Manage</Link>
          </Button>
          <SlackAction status={status} compact />
        </div>
      </div>
    </header>
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

function SlackInstallFailed({
  message,
  status,
  onDismiss,
}: {
  message: string
  status: ComputerStatus
  onDismiss: () => void
}) {
  return (
    <section
      role="alert"
      aria-labelledby="slack-install-failed-title"
      className="border-destructive/40 bg-destructive/5 relative rounded-2xl border px-8 py-6 sm:px-10"
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
        <div className="bg-destructive/15 text-destructive flex size-11 shrink-0 items-center justify-center rounded-full">
          <TriangleAlert className="size-5" aria-hidden />
        </div>
        <div className="max-w-2xl min-w-0 pr-8">
          <h2
            id="slack-install-failed-title"
            className="text-lg font-semibold tracking-tight"
          >
            Slack is not connected
          </h2>
          <p className="text-muted-foreground mt-1 text-balance">{message}</p>
          {status.slack.installed ? null : (
            <div className="mt-4">
              <SlackInstallButton label="Try again" />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * Setup is the onboarding of every new organization: three steps, one call to
 * action at a time, and where the person is in them. No pitch; the page is not
 * a landing page (Igor, 2026-10-13).
 */
function Setup({
  status,
  step,
  notice,
  createError,
  creating,
  onRetry,
}: {
  status: ComputerStatus
  step: SetupStep
  notice: ReactNode
  createError: Error | null
  creating: boolean
  onRetry: () => void
}) {
  const { computer } = status
  const failedToCreate = !computer && createError !== null
  const failed = failedToCreate || computer?.state === 'failed'
  const position = SETUP_STEPS.indexOf(step) + 1
  const done: Record<SetupStep, boolean> = {
    slack: status.slack.installed,
    github: status.github.connected,
    hello: false,
  }
  const progress = (id: SetupStep): SetupItemState =>
    id === step ? 'current' : done[id] ? 'done' : 'upcoming'
  return (
    <div className="mx-auto max-w-2xl space-y-6 pt-2 sm:pt-8">
      {notice}
      <header>
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm font-medium">
            Step {position} of {SETUP_STEPS.length}
          </p>
          {/* Before Slack there is no computer to report on. */}
          {computer || status.slack.installed ? (
            <StatusPill status={status} failedToCreate={failedToCreate} />
          ) : null}
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Set up your computer
        </h1>
        <div className="mt-5 flex gap-1.5" aria-hidden>
          {SETUP_STEPS.map((id) => (
            <span
              key={id}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                done[id]
                  ? 'bg-primary'
                  : id === step
                    ? 'bg-primary/35'
                    : 'bg-muted',
              )}
            />
          ))}
        </div>
      </header>

      {failed ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 flex flex-wrap items-center gap-4 rounded-xl border px-5 py-4"
        >
          <TriangleAlert
            className="text-destructive size-4 shrink-0"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              Your computer could not start.
            </p>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {failedToCreate
                ? createError.message
                : (computer?.lastError ??
                  'Try again, or tell us if it keeps happening.')}
            </p>
          </div>
          <RetryButton creating={creating} onRetry={onRetry} />
        </div>
      ) : null}

      <ol className="bg-panel divide-y overflow-hidden rounded-xl border shadow-sm">
        <SetupItem
          number={1}
          title="Add OpenComputer to Slack"
          state={progress('slack')}
          summary={`In ${status.slack.teamName ?? 'your Slack workspace'}`}
          doneAction={<SlackAction status={status} compact />}
        >
          <p>
            Your team mentions it in a thread; it does the work and replies
            there.
          </p>
          <SlackInstallButton size="lg" label="Add to Slack" />
        </SetupItem>
        <SetupItem
          number={2}
          title="Connect GitHub"
          state={progress('github')}
          summary={githubSummary(status.github)}
          doneAction={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              asChild
            >
              <Link to="/managed-agents/connections">Manage</Link>
            </Button>
          }
        >
          <p>
            Pick the repositories it can work in. It opens pull requests for you
            to review and never pushes to main unless you ask.
          </p>
          <GitHubAction size="lg" />
        </SetupItem>
        <SetupItem
          number={3}
          title="Say hello in Slack"
          state={progress('hello')}
        >
          <p>{START_SESSION_COPY} For example:</p>
          <CopyRow value={`@OpenComputer ${EXAMPLE_ASKS[0]}`} />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            {status.slack.teamId ? (
              <Button size="lg" asChild>
                <a
                  href={`https://app.slack.com/client/${encodeURIComponent(status.slack.teamId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Slack
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              </Button>
            ) : null}
            <span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
              <PulseDot tone="busy" />
              Waiting for the first mention
            </span>
          </div>
        </SetupItem>
      </ol>

      <CustomAgentLink />
    </div>
  )
}

type SetupItemState = 'done' | 'current' | 'upcoming'

function SetupItem({
  number,
  title,
  state,
  summary,
  doneAction,
  children,
}: {
  number: number
  title: string
  state: SetupItemState
  summary?: string
  doneAction?: ReactNode
  children: ReactNode
}) {
  const current = state === 'current'
  return (
    <li
      aria-current={current ? 'step' : undefined}
      className={cn('px-5', current ? 'bg-primary/[0.03] py-5' : 'py-3.5')}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            state === 'done' && 'bg-primary/15 text-primary',
            current && 'bg-primary text-primary-foreground',
            state === 'upcoming' && 'text-muted-foreground border',
          )}
          aria-hidden
        >
          {state === 'done' ? <Check className="size-3.5" /> : number}
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-sm',
              current ? 'font-semibold' : 'font-medium',
              state === 'upcoming' && 'text-muted-foreground',
            )}
          >
            {title}
            <span className="sr-only">
              {state === 'done'
                ? ' (done)'
                : current
                  ? ' (current step)'
                  : ' (to do)'}
            </span>
          </p>
          {state === 'done' && summary ? (
            <p className="text-muted-foreground truncate text-sm">{summary}</p>
          ) : null}
        </div>
        {state === 'done' ? doneAction : null}
      </div>
      {current ? (
        <div className="text-muted-foreground mt-3 space-y-4 pl-10 text-sm">
          {children}
        </div>
      ) : null}
    </li>
  )
}

function githubSummary(github: ComputerStatus['github']) {
  const accounts = github.installations.map(
    (installation) => installation.accountLogin,
  )
  return accounts.length
    ? `Repositories in ${accounts.join(', ')}`
    : 'GitHub is connected'
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
  size = 'default',
  label = 'Install Slack app',
}: {
  variant?: 'default' | 'outline'
  size?: 'default' | 'lg'
  label?: string
}) {
  const install = useMutation({
    mutationFn: startComputerSlackInstall,
    onSuccess: (url) => window.location.assign(url),
    onError: (error) => notifyError("Couldn't start the Slack install.", error),
  })
  return (
    <Button
      variant={variant}
      size={size}
      // Stays pending through the navigation to Slack.
      disabled={install.isPending || install.isSuccess}
      onClick={() => install.mutate()}
    >
      {install.isPending || install.isSuccess ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Send className="size-4" aria-hidden />
      )}
      {label}
    </Button>
  )
}

function GitHubAction({ size = 'default' }: { size?: 'default' | 'lg' }) {
  const [starting, setStarting] = useState(false)
  return (
    <Button
      size={size}
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
        <span className="flex max-w-md items-center gap-2.5">
          {sessionIsLive(session) ? (
            <PulseDot tone={session.status === 'busy' ? 'alive' : 'busy'} />
          ) : (
            <span className="size-2 shrink-0" aria-hidden />
          )}
          <span className="truncate font-medium">
            {session.title || 'Untitled session'}
          </span>
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
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            asChild
          >
            <a href={session.slackUrl} target="_blank" rel="noreferrer">
              Open in Slack
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        ) : null,
    },
  ]
}

/** Every session in one list, the live ones first. */
function SessionsPanel({
  live,
  recent,
  readAt,
  loading,
  failed,
}: {
  live: ComputerSession[]
  recent: ComputerSession[]
  /** When the sessions were read; relative times never predate it. */
  readAt: number
  loading: boolean
  failed: boolean
}) {
  const now = Math.max(useNow(30_000), readAt)
  const columns = useMemo(() => sessionColumns(now), [now])
  return (
    <section aria-labelledby="computer-sessions">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="computer-sessions" className="text-base font-semibold">
          Sessions
        </h2>
        {live.length > 0 ? (
          <span className="text-muted-foreground text-sm">
            {live.length} working now
          </span>
        ) : null}
      </div>
      <Panel>
        <ResourceTable
          columns={columns}
          rows={[...live, ...recent]}
          rowKey={(session) => session.key}
          loading={loading}
          skeletonRows={3}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title={
                failed
                  ? 'Sessions are temporarily unavailable'
                  : 'No sessions yet'
              }
              description={
                failed ? 'They reload by themselves.' : START_SESSION_COPY
              }
            />
          }
        />
      </Panel>
    </section>
  )
}

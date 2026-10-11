import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Check,
  Computer as ComputerIcon,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessagesSquare,
  Moon,
  RotateCcw,
  Send,
  Terminal,
  Unplug,
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
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
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
  SESSION_STATUS,
  START_SESSION_COPY,
  computerChecklist,
  computerPollInterval,
  computerPresentation,
  heroCopy,
  slackReturnFromSearch,
  type ChecklistStep,
} from './computer-state'

const SESSION_POLL_MS = 15_000

export default function ComputerPage() {
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
    refetchInterval: SESSION_POLL_MS,
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

  // Slack's install redirect lands here with ?slack=connected|error.
  const handledSlackReturn = useRef<string | null>(null)
  useEffect(() => {
    const slackReturn = slackReturnFromSearch(searchParams)
    if (!slackReturn) return
    const key = searchParams.toString()
    if (handledSlackReturn.current === key) return
    handledSlackReturn.current = key
    if (slackReturn.kind === 'connected') {
      notifySuccess('Slack is connected.', START_SESSION_COPY)
    } else {
      notifyError("Couldn't connect Slack.", new Error(slackReturn.message))
    }
    void queryClient.invalidateQueries({ queryKey: computerQueryKey })
    const next = new URLSearchParams(searchParams)
    next.delete('slack')
    next.delete('reason')
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Hero
        status={status.data}
        createError={create.isError ? create.error : null}
        creating={create.isPending}
        onRetry={() => create.mutate()}
      />
      <Reasons />
      <Checklist status={status.data} sessions={sessions.data} />
      <TryAsking />
      <SessionsPanel
        hasComputer={hasComputer}
        sessions={newestFirst(sessions.data ?? [])}
        loading={hasComputer && sessions.isLoading}
        failed={sessions.isError}
      />
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
    </div>
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
  const presentation = computerPresentation(computer, status.plan)
  const failedToCreate = !computer && createError !== null
  const copy = failedToCreate
    ? { headline: 'Something went wrong.', subline: createError.message }
    : heroCopy(computer, status.plan)
  const alive = computer?.state === 'ready' && computer.connected
  const busy =
    !computer ||
    computer.state === 'provisioning' ||
    computer.state === 'waking' ||
    (computer.state === 'ready' && !computer.connected)
  const canRetry = failedToCreate || computer?.state === 'failed'
  return (
    <section className="from-primary/10 via-panel to-panel relative overflow-hidden rounded-2xl border bg-linear-to-br px-8 py-12 sm:px-12 sm:py-16">
      <div
        className="bg-primary/15 pointer-events-none absolute -top-24 -right-24 size-72 rounded-full blur-3xl"
        aria-hidden
      />
      <div className="relative max-w-3xl">
        <div className="bg-background/70 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur">
          <span className="relative flex size-2" aria-hidden>
            {alive || busy ? (
              <span
                className={cn(
                  'absolute inline-flex size-full animate-ping rounded-full opacity-75',
                  alive ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
            ) : null}
            <span
              className={cn(
                'relative inline-flex size-2 rounded-full',
                alive
                  ? 'bg-emerald-500'
                  : busy
                    ? 'bg-amber-500'
                    : failedToCreate || computer?.state === 'failed'
                      ? 'bg-red-500'
                      : 'bg-muted-foreground',
              )}
            />
          </span>
          {failedToCreate ? 'Failed' : presentation.label}
        </div>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          {copy.headline}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg text-balance">
          {copy.subline}
        </p>
        {canRetry ? (
          <Button className="mt-8" disabled={creating} onClick={onRetry}>
            {creating ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-4" aria-hidden />
            )}
            Try again
          </Button>
        ) : null}
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

function SlackAction({ status }: { status: ComputerStatus }) {
  const queryClient = useQueryClient()
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const install = useMutation({
    mutationFn: startComputerSlackInstall,
    onSuccess: (url) => window.location.assign(url),
    onError: (error) => notifyError("Couldn't start the Slack install.", error),
  })
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

  if (!status.slack.installed) {
    return (
      <Button
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
  const teamName = status.slack.teamName ?? 'this Slack workspace'
  return (
    <>
      <Button variant="outline" onClick={() => setConfirmUnlink(true)}>
        <Unplug className="size-4" aria-hidden />
        Unlink
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

function newestFirst(sessions: ComputerSession[]) {
  return [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )
}

const SESSION_COLUMNS: Column<ComputerSession>[] = [
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
      <span className="text-muted-foreground whitespace-nowrap">
        {new Date(session.updatedAt).toLocaleString()}
      </span>
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

function SessionsPanel({
  hasComputer,
  sessions,
  loading,
  failed,
}: {
  hasComputer: boolean
  sessions: ComputerSession[]
  loading: boolean
  failed: boolean
}) {
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Sessions</PanelTitle>
          <PanelDescription className="mt-1">
            Work your computer is doing for your team, newest first.
          </PanelDescription>
        </div>
      </PanelHeader>
      <ResourceTable
        columns={SESSION_COLUMNS}
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
                  ? 'No sessions yet'
                  : 'Sessions appear once your computer is set up'
            }
            description={
              failed ? 'They reload by themselves.' : START_SESSION_COPY
            }
          />
        }
      />
    </Panel>
  )
}

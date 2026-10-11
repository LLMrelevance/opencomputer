import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AtSign,
  Check,
  Computer as ComputerIcon,
  ExternalLink,
  Loader2,
  MessagesSquare,
  RotateCcw,
  Send,
  Terminal,
  Unplug,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import { PageHeader } from '@/components/page-header'
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
  SESSION_STATUS,
  START_SESSION_COPY,
  computerChecklist,
  computerPollInterval,
  computerPresentation,
  formatCapacity,
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
      <PageHeader
        title="Computer"
        description="Your organization's computer holds your repositories and works on them with you from Slack."
      />
      <StatusCard
        status={status.data}
        createError={create.isError ? create.error : null}
        creating={create.isPending}
        onRetry={() => create.mutate()}
      />
      <Checklist status={status.data} sessions={sessions.data} />
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

function StatusCard({
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
  const canRetry =
    (!computer && createError !== null) || computer?.state === 'failed'
  return (
    <Panel>
      <PanelHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
            <ComputerIcon className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <PanelTitle>Your computer</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              {!computer && createError
                ? createError.message
                : presentation.description}
            </PanelDescription>
          </div>
        </div>
        <StatusBadge
          status={!computer && createError ? 'failed' : presentation.badge}
          label={!computer && createError ? 'Failed' : presentation.label}
        />
      </PanelHeader>
      <PanelContent className="flex flex-wrap items-end justify-between gap-4">
        {computer ? (
          <dl className="grid grid-cols-3 gap-6">
            {formatCapacity(computer).map((item) => (
              <div key={item.label}>
                <dt className="text-muted-foreground text-xs">{item.label}</dt>
                <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">
            Capacity appears once your computer is set up.
          </p>
        )}
        {canRetry ? (
          <Button variant="outline" disabled={creating} onClick={onRetry}>
            {creating ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="size-4" aria-hidden />
            )}
            Try again
          </Button>
        ) : null}
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
  const steps = computerChecklist(status, sessions)
  const [computerStep, slackStep, githubStep, sessionStep] = steps
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Get started</PanelTitle>
          <PanelDescription className="mt-1">
            {steps.filter((step) => step.done).length} of {steps.length} done
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent className="p-0">
        <ol className="divide-y">
          <Step number={1} step={computerStep}>
            {computerStep.done
              ? 'Your computer is set up.'
              : 'Your computer is being set up. You can install the Slack app and connect GitHub in the meantime.'}
          </Step>
          <Step
            number={2}
            step={slackStep}
            action={<SlackAction status={status} />}
          >
            {status.slack.installed
              ? `Linked to the ${status.slack.teamName ?? 'Slack'} workspace.`
              : 'Add OpenComputer to your Slack workspace so your team can work with the computer.'}
          </Step>
          <Step
            number={3}
            step={githubStep}
            action={<GitHubAction connected={status.github.connected} />}
          >
            {githubSummary(status.github)}
          </Step>
          <Step number={4} step={sessionStep}>
            <span className="inline-flex items-center gap-1.5">
              <AtSign className="size-3.5 shrink-0" aria-hidden />
              {START_SESSION_COPY}
            </span>
          </Step>
        </ol>
      </PanelContent>
    </Panel>
  )
}

function githubSummary(github: ComputerStatus['github']) {
  if (!github.connected) {
    return 'Install the OpenComputer GitHub App on the repositories your computer should work in.'
  }
  const accounts = github.installations.map(
    (installation) => installation.accountLogin,
  )
  return accounts.length
    ? `Repositories from ${accounts.join(', ')} are available to your computer.`
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

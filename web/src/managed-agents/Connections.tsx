import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Ellipsis,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { GithubMark } from '@/components/github-mark'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { ServiceLogo } from '@/components/service-logo'
import { SlackMark } from '@/components/slack-mark'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { AuthContext } from '@/hooks/useAuth'
import { notifyError } from '@/lib/errors'
import {
  displayManagedAgentName,
  addManagedGitHubConnection,
  claimManagedAgentChannelIdentity,
  disconnectManagedAgentConnection,
  getManagedAgentConnections,
  getManagedGitHubConnections,
  getManagedAgents,
  linkManagedAgentConnection,
  refreshManagedAgentConnection,
  type ManagedAgentConnection,
} from './api'
import { launchAuthorizationWindow } from './authorization-window'
import { computerQueryKey, getComputer } from './computer-api'
import { SlackInstallButton, UnlinkSlackDialog } from './computer-slack'
import { slackLinks } from './computer-state'

// The organization's connections: the Slack app the computer answers in and
// the GitHub accounts it works in. Personal accounts (Google, Linear) are
// only listed when an agent already connected one; agents start new ones
// with a link to this page (`?connect=1&service=…`), so there is no picker.

function displayResourceName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

// A Google grant's scopes say which service it is; the provider does not.
// Sheets is checked before Drive because a Sheets grant carries drive scopes
// too, and Drive first would claim it.
const GOOGLE_SERVICES = [
  { id: 'calendar', name: 'Google Calendar', scope: '/auth/calendar' },
  { id: 'sheets', name: 'Google Sheets', scope: '/auth/spreadsheets' },
  { id: 'drive', name: 'Google Drive', scope: '/auth/drive' },
  { id: 'gmail', name: 'Gmail', scope: '/auth/gmail.' },
] as const

function googleServiceFor(scopes: string[]) {
  return GOOGLE_SERVICES.find((service) =>
    scopes.some((scope) => scope.toLowerCase().includes(service.scope)),
  )
}

function connectionService(connection: { provider: string; scopes: string[] }) {
  return (
    googleServiceFor(connection.scopes)?.name ??
    displayResourceName(connection.provider)
  )
}

function connectionServiceId(
  connection: ManagedAgentConnection,
): 'gmail' | 'calendar' | 'drive' | 'sheets' | 'github' | 'linear' | undefined {
  if (connection.provider === 'github') return 'github'
  if (connection.provider === 'linear') return 'linear'
  if (connection.provider !== 'google') return undefined
  // Returning undefined here strands the connection: the page skips it when
  // reconciling and cannot disconnect it either.
  return googleServiceFor(connection.scopes)?.id
}

function connectionTitle(connection: ManagedAgentConnection) {
  return displayResourceName(connection.label || connection.provider)
}

/** Service, account and agent, leaving out whatever just repeats the title. */
function connectionDetail(
  connection: ManagedAgentConnection,
  agentName: string | undefined,
) {
  const seen = new Set([connectionTitle(connection).toLowerCase()])
  return [connectionService(connection), connection.displayName, agentName]
    .filter((part): part is string => {
      if (!part || seen.has(part.toLowerCase())) return false
      seen.add(part.toLowerCase())
      return true
    })
    .join(' · ')
}

async function loadManagedAgentConnections() {
  const current = await getManagedAgentConnections()
  const pending = current.filter(
    (connection) => connection.status === 'pending',
  )
  if (!pending.length) return current
  await Promise.allSettled(
    pending.map((connection) => {
      const service = connectionServiceId(connection)
      if (!service) return Promise.resolve()
      return refreshManagedAgentConnection(
        service === 'github' || service === 'linear' ? service : 'google',
        service,
        connection.id,
      )
    }),
  )
  return getManagedAgentConnections()
}

/** GitHub's settings page for one installation, where repositories are chosen. */
function githubInstallationSettingsUrl(installation: {
  githubInstallationId: number
  accountLogin: string
  accountType: string
}) {
  return installation.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.githubInstallationId}`
    : `https://github.com/settings/installations/${installation.githubInstallationId}`
}

export default function ManagedAgentConnections() {
  const computerEnabled =
    useContext(AuthContext)?.user?.computerEnabled ?? false
  const [searchParams, setSearchParams] = useSearchParams()
  const channelLinkStarted = useRef(false)
  const connectionStarted = useRef(false)
  const [channelLinkState, setChannelLinkState] = useState<
    'idle' | 'linking' | 'linked' | 'failed'
  >('idle')
  const [connectionRequestState, setConnectionRequestState] = useState<
    'idle' | 'connecting' | 'connected' | 'failed'
  >('idle')
  const requestedService = searchParams.get('service')
  const requestedAlias = searchParams.get('alias') || 'default'
  const connections = useQuery({
    queryKey: ['managed-agent-connections'],
    queryFn: loadManagedAgentConnections,
  })

  useEffect(() => {
    const token = searchParams.get('channel_link')
    if (!token || channelLinkStarted.current) return
    channelLinkStarted.current = true
    setChannelLinkState('linking')
    void claimManagedAgentChannelIdentity(token)
      .then(() => {
        setChannelLinkState('linked')
        const next = new URLSearchParams(searchParams)
        next.delete('channel_link')
        setSearchParams(next, { replace: true })
      })
      .catch(() => setChannelLinkState('failed'))
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (
      searchParams.get('connect') !== '1' ||
      !requestedService ||
      connectionStarted.current ||
      channelLinkState === 'linking'
    ) {
      return
    }
    connectionStarted.current = true
    setConnectionRequestState('connecting')
    void (
      requestedService === 'github'
        ? addManagedGitHubConnection('existing').then((authorizationUrl) => ({
            authorizationUrl,
          }))
        : linkManagedAgentConnection(requestedService, requestedAlias)
    )
      .then((result) => {
        if (result.authorizationUrl) {
          window.location.assign(result.authorizationUrl)
          return
        }
        setConnectionRequestState('connected')
        void connections.refetch()
      })
      .catch(() => setConnectionRequestState('failed'))
  }, [
    channelLinkState,
    connections,
    requestedAlias,
    requestedService,
    searchParams,
  ])

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Connections"
        description="Where OpenComputer works for your organization."
      />

      <div className="space-y-4">
        {channelLinkState !== 'idle' && (
          <Notice>
            {channelLinkState === 'linking' && 'Linking your channel identity…'}
            {channelLinkState === 'linked' &&
              'Channel identity linked. This agent can now use your connections when you message it.'}
            {channelLinkState === 'failed' &&
              'This channel link is invalid or expired. Ask the agent for a new link.'}
          </Notice>
        )}

        {requestedService && (
          <Notice>
            <p className="font-medium">
              Connect {displayResourceName(requestedService)} as “
              {requestedAlias}”
            </p>
            <p className="text-muted-foreground mt-0.5">
              {connectionRequestState === 'connecting'
                ? 'Opening secure authorization…'
                : connectionRequestState === 'connected'
                  ? 'This connection is ready for your sessions.'
                  : connectionRequestState === 'failed'
                    ? 'The connection could not be started. Reload this link to try again.'
                    : 'Continue to securely authorize this account.'}
            </p>
          </Notice>
        )}

        {computerEnabled ? <SlackConnection /> : null}
        <GitHubConnection />
        <PersonalAccounts query={connections} />
      </div>
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted/50 rounded-lg border px-4 py-3 text-sm">
      {children}
    </div>
  )
}

/** One service: its mark, what it does here, and its actions; rows below. */
function ServiceCard({
  icon,
  title,
  summary,
  actions,
  children,
}: {
  icon: ReactNode
  title: string
  summary: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <Panel>
      <section aria-label={title}>
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            <div className="text-muted-foreground mt-0.5 truncate text-sm">
              {summary}
            </div>
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          ) : null}
        </div>
        {children ? <div className="border-t">{children}</div> : null}
      </section>
    </Panel>
  )
}

function ServiceRow({
  title,
  detail,
  trailing,
}: {
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 py-2.5 pr-3 pl-[4.25rem]">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {detail ? (
          <p className="text-muted-foreground truncate text-xs">{detail}</p>
        ) : null}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-1">{trailing}</div>
      ) : null}
    </div>
  )
}

function OverflowMenu({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={label}
        >
          <Ellipsis className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SlackConnection() {
  const status = useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
  })
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const slack = status.data?.slack

  return (
    <ServiceCard
      icon={<SlackMark className="size-4" />}
      title="Slack"
      summary={
        status.isLoading ? (
          <Skeleton className="mt-1 h-3.5 w-40" />
        ) : status.isError ? (
          'Slack status is temporarily unavailable.'
        ) : slack?.installed ? (
          <>
            Installed in{' '}
            <span className="text-foreground">
              {slack.teamName ?? 'your workspace'}
            </span>
          </>
        ) : (
          'Add OpenComputer to your workspace to work with it in Slack.'
        )
      }
      actions={
        status.isError ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void status.refetch()}
          >
            Try again
          </Button>
        ) : slack?.installed ? (
          <>
            {slackLinks(slack).web ? (
              <Button variant="ghost" size="sm" asChild>
                <a
                  href={slackLinks(slack).web ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Slack
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </Button>
            ) : null}
            <OverflowMenu label="Slack options">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirmUnlink(true)}
              >
                <Unplug aria-hidden />
                Unlink Slack workspace
              </DropdownMenuItem>
            </OverflowMenu>
            <UnlinkSlackDialog
              teamName={slack.teamName}
              open={confirmUnlink}
              onOpenChange={setConfirmUnlink}
            />
          </>
        ) : status.isSuccess ? (
          <SlackInstallButton
            variant="outline"
            size="sm"
            label="Add to Slack"
          />
        ) : null
      }
    />
  )
}

function GitHubConnection() {
  const installations = useQuery({
    queryKey: ['managed-github-connections'],
    queryFn: getManagedGitHubConnections,
  })
  const [starting, setStarting] = useState<'install' | 'existing'>()
  const start = (mode: 'install' | 'existing') => {
    setStarting(mode)
    void launchAuthorizationWindow(() => addManagedGitHubConnection(mode))
      .catch((error: unknown) =>
        notifyError(
          mode === 'install'
            ? "Couldn't start the GitHub installation."
            : "Couldn't start the GitHub sync.",
          error,
        ),
      )
      .finally(() => setStarting(undefined))
  }
  const accounts = installations.data?.connections ?? []

  return (
    <ServiceCard
      icon={<GithubMark className="size-4" />}
      title="GitHub"
      summary={
        installations.isError
          ? 'GitHub installations are temporarily unavailable.'
          : 'Accounts and repositories OpenComputer can work in.'
      }
      actions={
        installations.isError ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void installations.refetch()}
          >
            Try again
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(starting)}
              onClick={() => start('install')}
            >
              {starting === 'install' ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-3.5" aria-hidden />
              )}
              Add account
            </Button>
            <OverflowMenu label="GitHub options">
              <DropdownMenuItem
                disabled={Boolean(starting)}
                onSelect={() => start('existing')}
              >
                <RefreshCw aria-hidden />
                Sync existing installations
              </DropdownMenuItem>
            </OverflowMenu>
          </>
        )
      }
    >
      {installations.isLoading ? (
        <div className="divide-y">
          <ServiceRow title={<Skeleton className="h-4 w-28" />} />
        </div>
      ) : accounts.length ? (
        <div className="divide-y">
          {accounts.map((installation) => (
            <ServiceRow
              key={installation.id}
              title={installation.accountLogin}
              detail={
                installation.repositorySelection === 'all'
                  ? 'All repositories'
                  : 'Selected repositories'
              }
              trailing={
                <>
                  {installation.state === 'active' ? null : (
                    <StatusBadge
                      status="stopped"
                      label={
                        installation.state === 'suspended'
                          ? 'Suspended'
                          : 'Removed'
                      }
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    asChild
                  >
                    <a
                      href={githubInstallationSettingsUrl(installation)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Configure
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  </Button>
                </>
              }
            />
          ))}
        </div>
      ) : installations.isSuccess ? (
        <p className="text-muted-foreground py-3 pr-5 pl-[4.25rem] text-sm">
          No accounts yet. Add a GitHub organization or user, then choose its
          repositories.
        </p>
      ) : null}
    </ServiceCard>
  )
}

/**
 * Accounts an agent connected on someone's behalf (serverless agents). Shown
 * only while there are some, so they can still be removed.
 */
function PersonalAccounts({
  query,
}: {
  query: {
    data?: ManagedAgentConnection[]
    refetch: () => Promise<unknown>
  }
}) {
  const accounts = query.data ?? []
  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
    enabled: accounts.length > 0,
  })
  const agentNames = new Map(
    (agents.data ?? []).map((agent) => [
      agent.id,
      displayManagedAgentName(agent),
    ]),
  )
  const [toRemove, setToRemove] = useState<ManagedAgentConnection>()
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string>()

  if (!accounts.length) return null

  return (
    <section aria-label="Personal accounts" className="pt-4">
      <h2 className="text-sm font-semibold">Personal accounts</h2>
      <p className="text-muted-foreground mt-0.5 text-sm">
        Accounts your agents connected on your behalf.
      </p>
      <Panel className="mt-3 divide-y">
        {accounts.map((connection) => {
          const service = connectionServiceId(connection)
          const agentName = agentNames.get(connection.agentId)
          return (
            <div
              key={connection.id}
              className="flex min-h-12 items-center gap-3 px-5 py-2.5"
            >
              {service === 'github' ? (
                <GithubMark className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <ServiceLogo service={service} className="size-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {connectionTitle(connection)}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {connectionDetail(connection, agentName)}
                </p>
              </div>
              {connection.status === 'connected' ? null : (
                <StatusBadge status={connection.status} />
              )}
              {service ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={`Remove ${connection.label} connection`}
                  onClick={() => {
                    setRemoveError(undefined)
                    setToRemove(connection)
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          )
        })}
      </Panel>
      <ConfirmDialog
        open={Boolean(toRemove)}
        onOpenChange={(open) => {
          if (!open) setToRemove(undefined)
        }}
        title="Remove connection?"
        description={
          toRemove
            ? removeError
              ? `The connection could not be removed: ${removeError}`
              : `Agents will no longer be able to use the “${toRemove.label}” account. You can reconnect it later.`
            : undefined
        }
        confirmLabel="Remove connection"
        destructive
        pending={removing}
        onConfirm={() => {
          if (!toRemove) return
          const service = connectionServiceId(toRemove)
          if (!service) return
          setRemoving(true)
          setRemoveError(undefined)
          void disconnectManagedAgentConnection(
            service === 'github' || service === 'linear' ? service : 'google',
            service,
            toRemove.id,
          )
            .then(() => query.refetch())
            .then(() => setToRemove(undefined))
            .catch((error: unknown) => {
              setRemoveError(
                error instanceof Error
                  ? error.message
                  : 'The connection could not be removed.',
              )
            })
            .finally(() => setRemoving(false))
        }}
      />
    </section>
  )
}

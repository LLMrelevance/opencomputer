import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cpu, ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { GithubMark } from '@/components/github-mark'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { ServiceLogo } from '@/components/service-logo'
import { SlackMark } from '@/components/slack-mark'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AuthContext } from '@/hooks/useAuth'
import { notifyError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  addManagedGitHubConnection,
  claimManagedAgentChannelIdentity,
  disconnectManagedAgentConnection,
  displayManagedAgentName,
  getManagedAgentConnections,
  getManagedAgents,
  getManagedGitHubConnections,
  linkManagedAgentConnection,
  type ManagedAgentConnection,
} from './api'
import {
  launchAuthorizationWindow,
  navigateAuthorizationWindow,
  openAuthorizationWindow,
} from './authorization-window'
import { AgentManage, LinkSlack } from './AgentStep'
import { computerQueryKey, getComputer } from './computer-api'
import { SlackInstallButton, UnlinkSlackDialog } from './computer-slack'
import { slackLinks } from './computer-state'

// The organization's connections: the Slack app the computer answers in and
// the GitHub accounts it works in, each person's model subscriptions (and
// the Slack user they belong to, work 083), then, less prominently, the Google and
// Linear accounts agents call through callService(). Serverless agents also
// send people here to link a channel identity or connect an account
// (`?channel_link=…`, `?connect=1&service=…`).

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

const OTHER_SERVICES = [
  { id: 'gmail', name: 'Gmail' },
  { id: 'calendar', name: 'Google Calendar' },
  { id: 'drive', name: 'Google Drive' },
  { id: 'sheets', name: 'Google Sheets' },
  { id: 'linear', name: 'Linear' },
] as const

function googleServiceFor(scopes: string[]) {
  return GOOGLE_SERVICES.find((service) =>
    scopes.some((scope) => scope.toLowerCase().includes(service.scope)),
  )
}

function connectionService(connection: ManagedAgentConnection) {
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
  // Returning undefined here strands the connection: it cannot be removed.
  return googleServiceFor(connection.scopes)?.id
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
      })
      .catch(() => setConnectionRequestState('failed'))
  }, [channelLinkState, requestedAlias, requestedService, searchParams])

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
        {computerEnabled ? <ModelConnection /> : null}
        <GitHubConnection />
        <OtherConnections />
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
    <div className="flex min-h-12 items-center gap-3 py-2.5 pr-3 pl-18">
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

function SlackConnection() {
  const status = useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
  })
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const slack = status.data?.slack
  const web = slack ? slackLinks(slack).web : null

  return (
    <ServiceCard
      icon={<SlackMark className="size-4" />}
      title="Slack"
      summary={
        status.isError
          ? 'Slack status is temporarily unavailable.'
          : slack?.installed || status.isLoading
            ? 'The workspace where your team works with OpenComputer.'
            : 'Add OpenComputer to your workspace to work with it in Slack.'
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
        ) : status.isSuccess && !slack?.installed ? (
          <SlackInstallButton
            variant="outline"
            size="sm"
            label="Add to Slack"
          />
        ) : null
      }
    >
      {status.isLoading ? (
        <ServiceRow title={<Skeleton className="h-4 w-28" />} />
      ) : slack?.installed ? (
        <>
          <ServiceRow
            title={slack.teamName ?? 'Slack workspace'}
            detail="Workspace"
            trailing={
              <>
                {web ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    asChild
                  >
                    <a href={web} target="_blank" rel="noreferrer">
                      Open
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmUnlink(true)}
                >
                  Unlink
                </Button>
              </>
            }
          />
          <SlackYou />
          <UnlinkSlackDialog
            teamName={slack.teamName}
            open={confirmUnlink}
            onOpenChange={setConfirmUnlink}
          />
        </>
      ) : null}
    </ServiceCard>
  )
}

/**
 * Who you are in Slack: subscriptions belong to Slack users, so a person not
 * linked to one links here, by sending a code to the app (work 083).
 */
function SlackYou() {
  const status = useQuery({ queryKey: computerQueryKey, queryFn: getComputer })
  const agent = status.data?.agent
  if (!agent) return null
  const user = agent.linkedSlackUser
  if (agent.linked)
    return (
      <ServiceRow
        title={user?.name ? `@${user.name}` : 'Linked'}
        detail="You, in Slack"
      />
    )
  return (
    <div className="text-muted-foreground border-t py-3 pr-5 pl-18 text-sm">
      <LinkSlack />
    </div>
  )
}

/**
 * Your model subscription: what runs your threads, its health, Replace and
 * Disconnect, or how to connect one. Per person, unlike the rest of the page.
 */
function ModelConnection() {
  const status = useQuery({ queryKey: computerQueryKey, queryFn: getComputer })
  const agent = status.data?.agent
  if (!agent) return null
  return (
    <ServiceCard
      icon={<Cpu className="size-4" aria-hidden />}
      title="Models"
      summary="Your Claude or ChatGPT subscription runs your threads."
    >
      <div className="py-4 pr-5 pl-18">
        <AgentManage
          agent={agent}
          slackInstalled={status.data?.slack.installed ?? false}
        />
      </div>
    </ServiceCard>
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
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              title="Pick up installations made on GitHub"
              disabled={Boolean(starting)}
              onClick={() => start('existing')}
            >
              {starting === 'existing' ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden />
              )}
              Sync
            </Button>
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
        <p className="text-muted-foreground py-3 pr-5 pl-18 text-sm">
          No accounts yet. Add a GitHub organization or user, then choose its
          repositories.
        </p>
      ) : null}
    </ServiceCard>
  )
}

/**
 * Google and Linear accounts agents use; secondary to Slack and GitHub. Every
 * service gets a row whether or not it is connected, with its accounts below.
 */
function OtherConnections() {
  const connections = useQuery({
    queryKey: ['managed-agent-connections'],
    queryFn: getManagedAgentConnections,
    // Authorization finishes in another window; pick it up on return.
    refetchOnWindowFocus: 'always',
  })
  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
  })
  const agentNames = new Map(
    (agents.data ?? []).map((agent) => [
      agent.id,
      displayManagedAgentName(agent),
    ]),
  )
  const [connecting, setConnecting] = useState<string>()
  const [toRemove, setToRemove] = useState<ManagedAgentConnection>()
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string>()
  const accounts = connections.data ?? []
  const listed = new Set<string>(OTHER_SERVICES.map((service) => service.id))
  const unlisted = accounts.filter(
    (connection) => !listed.has(connectionServiceId(connection) ?? ''),
  )

  const connect = (service: (typeof OTHER_SERVICES)[number]) => {
    // The alias is how agents pick an account in callService(); the first
    // account of a service is named after it, later ones are numbered.
    const taken = new Set(accounts.map((connection) => connection.label))
    let alias: string = service.id
    for (let n = 2; taken.has(alias); n++) alias = `${service.id}-${n}`
    setConnecting(service.id)
    let authorizationWindow: Window
    try {
      authorizationWindow = openAuthorizationWindow()
    } catch (error) {
      setConnecting(undefined)
      notifyError(`Couldn't connect ${service.name}.`, error)
      return
    }
    void linkManagedAgentConnection(service.id, alias)
      .then((result) => {
        if (result.authorizationUrl) {
          navigateAuthorizationWindow(
            authorizationWindow,
            result.authorizationUrl,
          )
          return
        }
        authorizationWindow.close()
        void connections.refetch()
      })
      .catch((error: unknown) => {
        authorizationWindow.close()
        notifyError(`Couldn't connect ${service.name}.`, error)
      })
      .finally(() => setConnecting(undefined))
  }

  // An account is named by who it is; its alias is how agents select it.
  const accountRow = (connection: ManagedAgentConnection, nested: boolean) => {
    const service = connectionServiceId(connection)
    return (
      <OtherRow
        key={connection.id}
        nested={nested}
        icon={
          nested ? undefined : (
            <ServiceLogo
              service={service === 'github' ? undefined : service}
              className="size-4"
            />
          )
        }
        title={
          connection.displayName ||
          displayResourceName(connection.label || connection.provider)
        }
        detail={[
          nested ? undefined : connectionService(connection),
          `Alias ${connection.label}`,
          agentNames.get(connection.agentId),
        ]
          .filter(Boolean)
          .join(' · ')}
        trailing={
          <>
            {connection.status === 'connected' ? null : (
              <StatusBadge status={connection.status} />
            )}
            {service ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  setRemoveError(undefined)
                  setToRemove(connection)
                }}
              >
                Remove
              </Button>
            ) : null}
          </>
        }
      />
    )
  }

  return (
    <section aria-label="Other accounts" className="pt-4">
      <div className="mb-2">
        <h2 className="text-muted-foreground text-sm font-medium">
          Other accounts
        </h2>
        <p className="text-muted-foreground text-xs">
          Google and Linear accounts your agents use.
        </p>
      </div>
      <Panel>
        {connections.isError ? (
          <div className="flex items-center justify-between gap-4 px-5 py-3">
            <p className="text-muted-foreground text-sm">
              Accounts are temporarily unavailable.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void connections.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="divide-y">
            {OTHER_SERVICES.map((service) => {
              const serviceAccounts = accounts.filter(
                (connection) => connectionServiceId(connection) === service.id,
              )
              return (
                <div key={service.id} className="pb-1 last:pb-0">
                  <OtherRow
                    icon={
                      <ServiceLogo service={service.id} className="size-4" />
                    }
                    title={service.name}
                    detail={
                      connections.isLoading ? (
                        <Skeleton className="mt-1 h-3 w-20" />
                      ) : serviceAccounts.length ? undefined : (
                        'Not connected'
                      )
                    }
                    trailing={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        disabled={connections.isLoading || Boolean(connecting)}
                        onClick={() => connect(service)}
                      >
                        {connecting === service.id ? (
                          <Loader2
                            className="size-3.5 animate-spin"
                            aria-hidden
                          />
                        ) : (
                          <Plus className="size-3.5" aria-hidden />
                        )}
                        {serviceAccounts.length ? 'Add account' : 'Connect'}
                      </Button>
                    }
                  />
                  {serviceAccounts.map((connection) =>
                    accountRow(connection, true),
                  )}
                </div>
              )
            })}
            {unlisted.map((connection) => accountRow(connection, false))}
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={Boolean(toRemove)}
        onOpenChange={(open) => {
          if (!open) setToRemove(undefined)
        }}
        title="Remove account?"
        description={
          toRemove
            ? removeError
              ? `The account could not be removed: ${removeError}`
              : `Agents will no longer be able to use ${toRemove.displayName || `the “${toRemove.label}” account`}. You can reconnect it later.`
            : undefined
        }
        confirmLabel="Remove account"
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
            .then(() => connections.refetch())
            .then(() => setToRemove(undefined))
            .catch((error: unknown) =>
              setRemoveError(
                error instanceof Error
                  ? error.message
                  : 'The account could not be removed.',
              ),
            )
            .finally(() => setRemoving(false))
        }}
      />
    </section>
  )
}

/**
 * A row on the card grid: icon in the 2.25rem column, text at 4.5rem like the
 * Slack and GitHub rows. Nested rows are a service's accounts: no icon, no
 * divider above, tighter.
 */
function OtherRow({
  icon,
  nested,
  title,
  detail,
  trailing,
}: {
  icon?: ReactNode
  nested?: boolean
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center pr-3',
        nested ? 'min-h-10 gap-3 py-1.5 pl-18' : 'min-h-12 gap-4 py-2.5 pl-5',
      )}
    >
      {nested ? null : (
        <div className="flex size-9 shrink-0 items-center justify-center">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {detail ? (
          <div className="text-muted-foreground truncate text-xs">{detail}</div>
        ) : null}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-1">{trailing}</div>
      ) : null}
    </div>
  )
}

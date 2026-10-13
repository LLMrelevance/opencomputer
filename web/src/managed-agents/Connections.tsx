import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { GithubMark } from '@/components/github-mark'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { SlackMark } from '@/components/slack-mark'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AuthContext } from '@/hooks/useAuth'
import { notifyError } from '@/lib/errors'
import {
  addManagedGitHubConnection,
  claimManagedAgentChannelIdentity,
  getManagedGitHubConnections,
  linkManagedAgentConnection,
} from './api'
import { launchAuthorizationWindow } from './authorization-window'
import { computerQueryKey, getComputer } from './computer-api'
import { SlackInstallButton, UnlinkSlackDialog } from './computer-slack'
import { slackLinks } from './computer-state'

// The organization's connections: the Slack app the computer answers in and
// the GitHub accounts it works in. Serverless agents still send people here
// to link a channel identity or connect an account (`?channel_link=…`,
// `?connect=1&service=…`); those links are handled, nothing else is listed.

function displayResourceName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
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
        <GitHubConnection />
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
        <p className="text-muted-foreground py-3 pr-5 pl-[4.25rem] text-sm">
          No accounts yet. Add a GitHub organization or user, then choose its
          repositories.
        </p>
      ) : null}
    </ServiceCard>
  )
}

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  startComputerSlackInstall: vi.fn(),
  unlinkComputerSlack: vi.fn(),
}))
vi.mock('./computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-api')>()),
  ...computerApi,
}))
const api = vi.hoisted(() => ({
  displayManagedAgentName: (agent: { id: string }) => agent.id,
  addManagedGitHubConnection: vi.fn(),
  claimManagedAgentChannelIdentity: vi.fn(),
  disconnectManagedAgentConnection: vi.fn(),
  getManagedAgentConnections: vi.fn(),
  getManagedGitHubConnections: vi.fn(),
  getManagedAgents: vi.fn(),
  linkManagedAgentConnection: vi.fn(),
  refreshManagedAgentConnection: vi.fn(),
}))
vi.mock('./api', () => api)

const { default: ConnectionsPage } = await import('./Connections')
const { AuthContext } = await import('@/hooks/useAuth')
const auth = {
  user: {
    id: 'u1',
    email: 'a@b.c',
    orgId: 'org_1',
    durableSessionsEnabled: false,
    infrastructureEnabled: false,
    computerEnabled: true,
  },
  loading: false,
  error: null,
  switchOrg: async () => {},
  refreshUser: async () => {},
} as const

const installation = {
  id: 'ghc_1',
  githubInstallationId: 7,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all' as const,
  state: 'active' as const,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
}

let root: Root | undefined
let container: HTMLDivElement

async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/managed-agents/connections']}>
            <ConnectionsPage />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
  })
  // Queries resolve, then the ones they enable (agent names) do.
  for (let tick = 0; tick < 3; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  computerApi.getComputer.mockResolvedValue({
    computer: null,
    slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    github: { connected: true, installations: [] },
    plan: 'free',
  })
  api.getManagedGitHubConnections.mockResolvedValue({
    connections: [installation],
    app: { slug: 'opencomputerdev' },
  })
  api.getManagedAgentConnections.mockResolvedValue([])
  api.getManagedAgents.mockResolvedValue([])
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('Connections', () => {
  it('shows the organization Slack app and GitHub accounts, with nothing to add beyond them', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('Installed in Acme')
    expect(text).toContain('acme')
    expect(text).toContain('All repositories')
    expect(text).not.toContain('Add connection')
    expect(text).not.toContain('Personal accounts')
    const configure = container.querySelector<HTMLAnchorElement>(
      'a[href*="/settings/installations/"]',
    )
    expect(configure?.href).toBe(
      'https://github.com/organizations/acme/settings/installations/7',
    )
  })

  it('lists personal accounts agents already connected, without repeating the name', async () => {
    api.getManagedAgentConnections.mockResolvedValue([
      {
        id: 'conn_1',
        kind: 'tool',
        provider: 'google',
        label: 'gmail',
        agentId: '',
        alias: 'gmail',
        displayName: 'Gmail',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        status: 'connected',
        createdAt: '2026-10-11T10:00:00.000Z',
      },
    ])
    await render()
    expect(container.textContent).toContain('Personal accounts')
    expect(container.textContent).not.toContain('Gmail · Gmail')
    expect(
      container.querySelector('[aria-label="Remove gmail connection"]'),
    ).not.toBeNull()
  })
})

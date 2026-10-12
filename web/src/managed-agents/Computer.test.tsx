// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  createComputer: vi.fn(),
  getComputerSessions: vi.fn(),
  startComputerSlackInstall: vi.fn(),
  unlinkComputerSlack: vi.fn(),
}))
vi.mock('./computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-api')>()),
  ...computerApi,
}))
const projectsApi = vi.hoisted(() => ({
  getManagedProjects: vi.fn(),
  archiveManagedProject: vi.fn(),
  restoreManagedProject: vi.fn(),
  addManagedGitHubConnection: vi.fn(),
}))
vi.mock('./api', () => projectsApi)

const { default: ComputerPage } = await import('./Computer')
const { AuthContext } = await import('@/hooks/useAuth')
const authWith = (computerEnabled: boolean) =>
  ({
    user: {
      id: 'u1',
      email: 'a@b.c',
      orgId: 'org_1',
      durableSessionsEnabled: false,
      infrastructureEnabled: false,
      computerEnabled,
    },
    loading: false,
    error: null,
    switchOrg: async () => {},
    refreshUser: async () => {},
  }) as const
const { default: ProjectsHome } = await import('./Home')

const empty = {
  computer: null,
  slack: { installed: false },
  github: { connected: false, installations: [] },
  plan: 'free' as const,
}
const provisioning = {
  ...empty,
  computer: {
    state: 'provisioning' as const,
    connected: false,
    vcpus: 2,
    memoryGiB: 8,
    diskGiB: 128,
    lastError: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
  },
}

const onboarded = {
  ...provisioning,
  computer: {
    ...provisioning.computer,
    state: 'ready' as const,
    connected: true,
  },
  slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
  github: {
    connected: true,
    installations: [{ id: '42', accountLogin: 'acme' }],
  },
}
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString()
const liveSession = {
  key: 'C1:1.1',
  title: 'Fix the flaky checkout test',
  channelId: 'C1',
  threadTs: '1.1',
  ownerSlackUserId: 'U1',
  status: 'busy' as const,
  updatedAt: minutesAgo(2),
  slackUrl: 'https://acme.slack.com/archives/C1/p11',
}
const doneSession = {
  ...liveSession,
  key: 'C1:1.0',
  title: 'Explain the billing flow',
  threadTs: '1.0',
  status: 'idle' as const,
  updatedAt: minutesAgo(90),
}

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function Location() {
  const location = useLocation()
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  )
}

describe('Computer page', () => {
  let container: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    for (const fn of [
      ...Object.values(computerApi),
      ...Object.values(projectsApi),
    ]) {
      fn.mockReset()
    }
    computerApi.getComputerSessions.mockResolvedValue([])
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  function render(url: string) {
    act(() => {
      root.render(
        <AuthContext.Provider value={authWith(true)}>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[url]}>
              <Routes>
                <Route index element={<ProjectsHome />} />
                <Route path="computer" element={<ComputerPage />} />
              </Routes>
              <Location />
            </MemoryRouter>
          </QueryClientProvider>
        </AuthContext.Provider>,
      )
    })
  }

  const location = () =>
    container.querySelector('[data-testid="location"]')?.textContent

  it('creates the computer on the first visit and shows it setting up', async () => {
    computerApi.getComputer.mockResolvedValue(empty)
    computerApi.createComputer.mockResolvedValue(provisioning)

    render('/computer')
    await settle(
      () => container.textContent?.includes('coming to life') === true,
      'provisioning computer',
    )

    expect(computerApi.createComputer).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Setting up')
    expect(container.textContent).toContain('Install Slack app')
    expect(container.textContent).not.toMatch(/vCPU|GiB/)
    expect(container.textContent).toContain('Connect GitHub')
    expect(container.textContent).toContain(
      'Mention @OpenComputer in any channel, or DM it.',
    )
    expect(container.textContent).not.toMatch(/azure|region|instance/i)
  })

  it('does not create a computer the organization already has', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer')
    await settle(
      () => container.textContent?.includes('Setting up') === true,
      'computer status',
    )
    expect(computerApi.createComputer).not.toHaveBeenCalled()
  })

  it('cleans the Slack return query once handled', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...provisioning,
      slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
    })

    render('/computer?slack=connected')
    await settle(() => location() === '/computer', 'clean URL')
    await settle(
      () => container.textContent?.includes('Acme') === true,
      'linked workspace',
    )
    expect(container.textContent).toContain('Unlink')
  })

  it('welcomes someone whose Slack workspace is already another organization', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer?slack=error&reason=team_already_linked&notified=1')
    await settle(() => location() === '/computer', 'clean URL')
    await settle(
      () =>
        container.textContent?.includes('Your team is already here.') === true,
      'already-linked panel',
    )
    const panel = container.querySelector(
      'section[aria-labelledby="already-linked-title"]',
    )!
    expect(panel.textContent).toContain(
      "We've messaged the person who set it up in Slack to invite you.",
    )
    expect(panel.textContent).toContain('menu at the top left')
    expect(panel.textContent).toContain(
      'Or connect a different Slack workspace',
    )
    expect(panel.textContent).toContain('Install Slack app')
    expect(container.textContent).not.toContain("Couldn't connect Slack")

    act(() =>
      (
        panel.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
      ).click(),
    )
    expect(container.textContent).not.toContain('Your team is already here.')
    expect(location()).toBe('/computer')
  })

  it('asks for a teammate when nobody could be messaged', async () => {
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/computer?slack=error&reason=team_already_linked&notified=0')
    await settle(
      () =>
        container.textContent?.includes('Ask a teammate who uses it') === true,
      'already-linked panel without a notified owner',
    )
    expect(container.textContent).not.toContain("We've messaged")
    await settle(() => location() === '/computer', 'clean URL')
  })

  it('sends an organization without projects to its computer', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([])
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/')
    await settle(() => location() === '/computer', 'redirect to /computer')
  })

  it('shows live work instead of setup once onboarded', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([
      doneSession,
      liveSession,
    ])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Fix the flaky') === true,
      'live session card',
    )

    const live = container.querySelector('section[aria-labelledby="live-now"]')
    expect(live?.textContent).toContain('Live now')
    expect(live?.textContent).toContain('Fix the flaky checkout test')
    expect(live?.textContent).toContain('Working…')
    expect(live?.textContent).toContain('2 min ago')
    expect(live?.textContent).not.toContain('Explain the billing flow')
    expect(
      live?.querySelector('a[href="https://acme.slack.com/archives/C1/p11"]')
        ?.textContent,
    ).toContain('Open in Slack')
    expect(container.textContent).toContain('Recent')
    expect(container.textContent).toContain('Explain the billing flow')
    expect(container.textContent).toContain('1 hr ago')
    expect(container.textContent).toContain('One thing in flight')
    expect(container.textContent).toContain('Acme')
    expect(container.textContent).toContain('acme')

    // Setup and selling are gone; specs never appear.
    expect(container.textContent).not.toContain('Three steps')
    expect(container.textContent).not.toContain('Install Slack app')
    expect(container.textContent).not.toContain('Lives in Slack')
    expect(container.textContent).not.toContain('never logs off')
    expect(container.textContent).not.toMatch(/vCPU|GiB/)
  })

  it('invites a hand-off when nothing is live', async () => {
    computerApi.getComputer.mockResolvedValue(onboarded)
    computerApi.getComputerSessions.mockResolvedValue([doneSession])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Quiet right now.') === true,
      'quiet live state',
    )
    expect(container.textContent).toContain('Ready when you are.')
    expect(container.textContent).toContain('@OpenComputer why is the')
  })

  it('keeps a resting computer and the upgrade visible once onboarded', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      computer: { ...onboarded.computer, state: 'parked', connected: false },
    })

    render('/computer')
    await settle(
      () => container.textContent?.includes('Resting') === true,
      'resting header',
    )
    expect(container.textContent).toContain('Sleeping')
    expect(container.textContent).toContain('Upgrade and it never sleeps.')
  })

  it('keeps the setup page until GitHub is connected too', async () => {
    computerApi.getComputer.mockResolvedValue({
      ...onboarded,
      github: { connected: false, installations: [] },
    })
    computerApi.getComputerSessions.mockResolvedValue([liveSession])

    render('/computer')
    await settle(
      () => container.textContent?.includes('Three steps') === true,
      'setup checklist',
    )
    expect(container.textContent).toContain('never logs off')
    expect(container.textContent).toContain('Connect GitHub')
    expect(container.textContent).not.toContain('Live now')
  })
})

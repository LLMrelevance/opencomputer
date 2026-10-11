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
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route index element={<ProjectsHome />} />
              <Route path="computer" element={<ComputerPage />} />
            </Routes>
            <Location />
          </MemoryRouter>
        </QueryClientProvider>,
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
      () => container.textContent?.includes('8 GiB') === true,
      'provisioning computer',
    )

    expect(computerApi.createComputer).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Setting up')
    expect(container.textContent).toContain('Install Slack app')
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

  it('sends an organization without projects to its computer', async () => {
    projectsApi.getManagedProjects.mockResolvedValue([])
    computerApi.getComputer.mockResolvedValue(provisioning)

    render('/')
    await settle(() => location() === '/computer', 'redirect to /computer')
  })
})

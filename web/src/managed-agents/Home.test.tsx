import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectsHome from './Home'
import { INSTALL_CLI_COMMAND } from './ProjectOnboarding'

import { AuthContext } from '@/hooks/useAuth'

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

function renderProjects(
  projects: unknown[],
  archived: unknown[] = [],
  computerEnabled = true,
) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['managed-projects'], projects)
  queryClient.setQueryData(['managed-projects', 'archived'], archived)

  return renderToStaticMarkup(
    <AuthContext.Provider value={authWith(computerEnabled)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProjectsHome />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

function stubSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('projects home onboarding', () => {
  it('sends the first landing without projects to the computer, not CLI onboarding', () => {
    // An organization's first screen is its computer (work 052).
    stubSessionStorage()
    const markup = renderProjects([])

    expect(markup).not.toContain(INSTALL_CLI_COMMAND)
    expect(markup).not.toContain('Create project')
  })

  it('keeps CLI onboarding for an organization without the computer (rollout flag)', () => {
    stubSessionStorage()
    const markup = renderProjects([], [], false)

    expect(markup).toContain(INSTALL_CLI_COMMAND)
  })

  it('shows CLI onboarding when Projects is opened after the first landing', () => {
    stubSessionStorage({ 'oc.computerLanding': '1' })
    const markup = renderProjects([])

    expect(markup).toContain(INSTALL_CLI_COMMAND)
  })

  it('sends New project to the same CLI onboarding route', () => {
    const now = new Date().toISOString()
    const markup = renderProjects([
      {
        id: 'project_1',
        slug: 'support',
        name: 'Support',
        environments: [{ name: 'development', updatedAt: now }],
        agents: [{ id: 'agent_1', name: 'Support agent' }],
        createdAt: now,
        updatedAt: now,
      },
    ])

    expect(markup).toContain('New project')
    expect(markup).toContain('href="/new"')
    expect(markup).not.toContain('Start from a template')
  })

  it('offers each project its own archive control, named after the project', () => {
    const now = new Date().toISOString()
    const markup = renderProjects([
      {
        id: 'project_1',
        slug: 'support',
        name: 'Support',
        environments: [{ name: 'development', updatedAt: now }],
        agents: [{ id: 'agent_1', name: 'Support agent' }],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'project_2',
        slug: 'billing',
        name: 'Billing',
        environments: [{ name: 'development', updatedAt: now }],
        agents: [],
        createdAt: now,
        updatedAt: now,
      },
    ])

    expect(markup).toContain('aria-label="Archive Support"')
    expect(markup).toContain('aria-label="Archive Billing"')
    expect(markup).not.toContain('Archive project')
  })

  it('hides archived projects behind a collapsed restore section', () => {
    const now = new Date().toISOString()
    const markup = renderProjects(
      [],
      [
        {
          id: 'project_1',
          slug: 'support',
          name: 'Support',
          environments: [],
          agents: [{ id: 'agent_1', name: 'Support agent' }],
          archivedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    )

    expect(markup).toContain('<details class="group space-y-3">')
    expect(markup).not.toContain('<details open=""')
    expect(markup).toContain('Archived (1)')
    expect(markup).toContain('Support')
    expect(markup).toContain('Restore')
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { APIKey } from '@/api/client'
import APIKeys from './APIKeys'

function key(name: string, expiresAt?: string): APIKey {
  return {
    id: `key_${name}`,
    orgId: 'org_0123456789abcdef01234567',
    keyPrefix: 'osb_example',
    name,
    scopes: [],
    createdAt: '2026-07-17T00:00:00.000Z',
    ...(expiresAt ? { expiresAt } : {}),
  }
}

function renderAPIKeys(keys: APIKey[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['api-keys'], keys)
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <APIKeys />
    </QueryClientProvider>,
  )
}

describe('API keys', () => {
  it('shows when each key expires', () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const past = new Date(Date.now() - 60_000).toISOString()
    const markup = renderAPIKeys([
      key('Forever'),
      key('Weekly', future),
      key('Stale', past),
    ])

    expect(markup).toContain('Expires')
    expect(markup).toContain('Never')
    expect(markup).toContain(new Date(future).toLocaleString())
    expect(markup).toContain('Expired')
  })
})

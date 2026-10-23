// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { ComputerAgent } from './computer-api'

const computerApi = vi.hoisted(() => ({
  getComputer: vi.fn(),
  createComputer: vi.fn(),
  getComputerSessions: vi.fn(),
  startComputerSlackInstall: vi.fn(),
  unlinkComputerSlack: vi.fn(),
  connectClaudeSubscription: vi.fn(),
  disconnectClaudeSubscription: vi.fn(),
  resumeClaudeSubscription: vi.fn(),
  setAgentChoice: vi.fn(),
  createConnectCode: vi.fn(),
  disconnectCodexSubscription: vi.fn(),
}))
vi.mock('./computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-api')>()),
  ...computerApi,
}))
vi.mock('./api', () => ({ addManagedGitHubConnection: vi.fn() }))
const capture = vi.hoisted(() => vi.fn())
vi.mock('posthog-js', () => ({ default: { capture } }))
const notify = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))
vi.mock('@/lib/errors', () => notify)

const { default: ComputerPage } = await import('./Computer')

const TOKEN = `sk-ant-oat01-${'a'.repeat(40)}`
const CODE = 'occ_b3JnX3Rlc3Q.0123456789abcdefghijkl'
const CODE_2 = 'occ_b3JnX3Rlc3Q.mnopqrstuvwxyz012345'
const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString()
const fresh: ComputerAgent = {
  choice: null,
  linked: false,
  subscription: null,
  managedModel: 'Claude Opus 5.5',
}
const subscription = (
  health: NonNullable<ComputerAgent['subscription']>['health'],
) => ({ provider: 'claude' as const, health, setAt: '2026-10-22T10:00:00Z' })
const empty = {
  computer: null,
  slack: { installed: false },
  github: { connected: false, installations: [] },
  plan: 'free' as const,
}
const onboarded = {
  computer: {
    state: 'ready' as const,
    connected: true,
    vcpus: 2,
    memoryGiB: 8,
    diskGiB: 128,
    lastError: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
  },
  slack: { installed: true, teamId: 'T1', teamName: 'Acme' },
  github: { connected: true, installations: [{ id: '1', accountLogin: 'a' }] },
  plan: 'free' as const,
}
const session = {
  key: 'C1:1.1',
  title: 'A task',
  channelId: 'C1',
  threadTs: '1.1',
  ownerSlackUserId: 'U1',
  status: 'idle' as const,
  updatedAt: new Date().toISOString(),
  slackUrl: 'https://acme.slack.com/archives/C1/p11',
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

describe('choosing the coding agent', () => {
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
    for (const fn of Object.values(computerApi)) fn.mockReset()
    capture.mockReset()
    notify.notifySuccess.mockReset()
    computerApi.getComputerSessions.mockResolvedValue([])
    computerApi.createConnectCode.mockResolvedValue({
      code: CODE,
      expiresAt: inTenMinutes(),
    })
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    client.clear()
    container.remove()
    document.body.replaceChildren()
  })

  const text = () => document.body.textContent ?? ''
  const field = () =>
    container.querySelector<HTMLInputElement>('input[type="password"]')!
  const button = (label: string) =>
    [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label,
    )

  async function show(status: object, until: string) {
    computerApi.getComputer.mockResolvedValue(status)
    if ('slack' in status && (status.slack as { installed: boolean }).installed)
      computerApi.getComputerSessions.mockResolvedValue([session])
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/computer']}>
            <Routes>
              <Route path="computer" element={<ComputerPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
    await settle(() => text().includes(until), until)
  }

  function openPaste() {
    act(() => button('Or paste a token')!.click())
  }

  const command = () =>
    [...document.body.querySelectorAll('code')]
      .map((code) => code.textContent ?? '')
      .find((value) => value.startsWith('npx '))

  function paste(value: string) {
    const input = field()
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('paste', { bubbles: true }))
    })
  }

  function submit() {
    act(() => {
      field().form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
  }

  it('comes first, with a paste form that never keeps the token', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    expect(text()).toContain('Step 1 of 4')
    expect(text()).toContain('Bring your own subscription.')
    expect(text()).toContain('No subscription? Start with $10 free.')
    expect(text()).toContain('Runs Claude Opus 5.5 on our credits.')
    expect(text()).toContain('Claude Code on its own machine')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_shown')
    openPaste()
    const input = field()
    expect(input.getAttribute('autocomplete')).toBe('off')

    // Once sent, the token is nowhere the page could show or keep it: not
    // the field, not the mutation's state, not react-query's cache (which
    // would hold a mutation's variables for minutes).
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      verified: true,
      via: 'pool',
    })
    paste(TOKEN)
    submit()
    expect(field().value).toBe('')
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(computerApi.connectClaudeSubscription).toHaveBeenCalledWith(TOKEN)
    const mutations = client.getMutationCache().getAll()
    expect(mutations.length).toBeGreaterThan(0)
    for (const mutation of mutations) {
      expect(JSON.stringify(mutation.state)).not.toContain(TOKEN)
      expect(mutation.state.variables).toBeUndefined()
    }
    expect(JSON.stringify(capture.mock.calls)).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)
  })

  it('refuses a token of the wrong shape on paste, before sending it', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    openPaste()
    paste('sk-ant-api03-nope')
    expect(text()).toContain("That's not a setup token. It starts with")
    submit()
    expect(computerApi.connectClaudeSubscription).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_failed', {
      code: 'computer_agent_token_format',
    })
  })

  it('joins a token the terminal wrapped, and says when one is cut off', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    openPaste()
    paste('sk-ant-oat01-short')
    expect(text()).toContain('That token looks cut off.')
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      verified: true,
      via: 'pool',
    })
    paste(`  ${TOKEN.slice(0, 25)}\n    ${TOKEN.slice(25)}  `)
    expect(text()).not.toContain('cut off')
    submit()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(computerApi.connectClaudeSubscription).toHaveBeenCalledWith(TOKEN)
  })

  it('says a rejected token did not work, and empties the field', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockRejectedValue(
      new ApiError('x', 422, 'computer_agent_token_rejected'),
    )
    openPaste()
    paste(TOKEN)
    submit()
    expect(field().value).toBe('')
    await settle(() => text().includes("That token didn't work"), 'rejected')
    expect(computerApi.connectClaudeSubscription).toHaveBeenCalledWith(TOKEN)
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_failed', {
      code: 'computer_agent_token_rejected',
    })
    expect(capture).not.toHaveBeenCalledWith(
      'computer.setup.agent_chosen',
      expect.anything(),
    )
  })

  it('re-reads the page when the server could not be reached', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    const reads = computerApi.getComputer.mock.calls.length
    computerApi.connectClaudeSubscription.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    )
    openPaste()
    paste(TOKEN)
    submit()
    await settle(() => text().includes("Couldn't reach the server"), 'neutral')
    expect(text()).not.toContain('Failed to fetch')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_failed', {
      code: 'unknown',
    })
    // The status is read again: the write may have landed.
    await settle(
      () => computerApi.getComputer.mock.calls.length > reads,
      're-read',
    )
    expect(text()).toContain('Step 1 of 4')
  })

  it("shows the edge's copy when someone else connected one", async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockRejectedValue(
      new ApiError(
        'Someone else already connected a subscription for this organization.',
        409,
        'computer_agent_already_connected',
      ),
    )
    openPaste()
    paste(TOKEN)
    submit()
    await settle(
      () => text().includes('Someone else already connected'),
      'already connected',
    )
  })

  it('moves on to Slack once a token is verified', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      verified: true,
      via: 'pool',
    })
    openPaste()
    paste(TOKEN)
    submit()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(text()).toContain('Claude Code · your subscription')
    expect(notify.notifySuccess).toHaveBeenCalledWith(
      'Claude Code is connected.',
    )
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_chosen', {
      choice: 'claude',
    })
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_connected', {
      provider: 'claude',
      verified: true,
      via: 'pool',
    })
  })

  it('says an unchecked token is saved', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockResolvedValue({
      agent: {
        ...fresh,
        choice: 'claude',
        subscription: subscription('unchecked'),
      },
      verified: false,
      via: 'none',
    })
    openPaste()
    paste(TOKEN)
    submit()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(notify.notifySuccess).toHaveBeenCalledWith(
      "Saved. We'll check it when your computer starts.",
    )
  })

  it('waits for the check rather than giving up on it', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.connectClaudeSubscription.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    openPaste()
    paste(TOKEN)
    submit()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(text()).toContain('Checking…')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(text()).toContain('Still checking…')
  })

  const codexCard = () =>
    [...container.querySelectorAll('[role="radio"]')].find((radio) =>
      radio.textContent?.includes('Codex'),
    ) as HTMLButtonElement

  // The person comes back to the tab from the terminal or the browser.
  function refocus() {
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
  }

  it('shows one command for Claude Code first, the paste form second', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command')
    expect(command()).toBe(
      `npx -y @opencomputer/cli model connect claude --code ${CODE}`,
    )
    expect(text()).toContain(
      'Run this in a terminal; it opens Claude to sign in.',
    )
    expect(text()).toContain('Waiting for you to sign in…')
    expect(container.querySelector('input[type="password"]')).toBeNull()
    expect(button('Or paste a token')).toBeDefined()
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
  })

  it('connects Codex with one command and moves on once signed in', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.setAgentChoice.mockResolvedValue({ ...fresh, choice: 'codex' })
    act(() => codexCard().click())
    await settle(() => command()?.includes(' codex ') === true, 'codex command')
    expect(command()).toBe(
      `npx -y @opencomputer/cli model connect codex --code ${CODE}`,
    )
    expect(text()).toContain(
      'Run this in a terminal; it opens ChatGPT to sign in.',
    )
    expect(text()).toContain('Codex on its own machine')
    expect(button('Or paste a token')).toBeUndefined()
    expect(computerApi.setAgentChoice).toHaveBeenCalledWith('codex')
    // One code for both cards: switching does not mint another.
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
    await settle(
      () =>
        capture.mock.calls.some(
          ([event, props]) =>
            event === 'computer.setup.agent_chosen' &&
            (props as { choice: string }).choice === 'codex',
        ),
      'codex chosen',
    )

    computerApi.getComputer.mockResolvedValue({
      ...empty,
      agent: {
        ...fresh,
        choice: 'codex',
        subscription: {
          provider: 'codex',
          health: 'unchecked',
          setAt: '2026-10-22T10:00:00Z',
          plan: 'plus',
        },
      },
    })
    refocus()
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(text()).toContain('Codex · your ChatGPT plan')
    expect(notify.notifySuccess).toHaveBeenCalledWith('Codex is connected.')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_connected', {
      provider: 'codex',
      verified: false,
      via: 'command',
    })
    // A used code is never offered again.
    expect(window.localStorage.length).toBe(0)
  })

  it('waits quickly for the sign-in while the tab is in view', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    computerApi.getComputer.mockResolvedValue({ ...empty, agent: fresh })
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/computer']}>
            <Routes>
              <Route path="computer" element={<ComputerPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(command()).toBeDefined()
    const reads = computerApi.getComputer.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(computerApi.getComputer.mock.calls.length).toBeGreaterThan(reads)
  })

  it('stops renewing and waiting in a tab left open, until asked again', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    })
    let minted = 0
    computerApi.createConnectCode.mockImplementation(() =>
      Promise.resolve({
        code: `${CODE}${minted++}`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    )
    computerApi.getComputer.mockResolvedValue({ ...empty, agent: fresh })
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/computer']}>
            <Routes>
              <Route path="computer" element={<ComputerPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(command()).toBeDefined()
    // An hour with nobody acting: renewed for half an hour, then left.
    for (let i = 0; i < 60; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
    expect(computerApi.createConnectCode.mock.calls.length).toBeLessThanOrEqual(
      4,
    )
    expect(text()).toContain('This command expired.')
    expect(text()).not.toContain('Waiting for you to sign in')
    const reads = computerApi.getComputer.mock.calls.length
    const mints = computerApi.createConnectCode.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000)
    })
    // Only the page's own slow poll (every 30 s) is left.
    expect(
      computerApi.getComputer.mock.calls.length - reads,
    ).toBeLessThanOrEqual(61)
    expect(computerApi.createConnectCode.mock.calls.length).toBe(mints)
    // Asked again: a fresh command, and the wait is back.
    act(() => button('Get a new command')!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(computerApi.createConnectCode.mock.calls.length).toBe(mints + 1)
    expect(text()).toContain('Waiting for you to sign in')
  })

  it('keeps the command across a reload, and gives a new one on request', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command')
    // A reload: a new page, the same tab.
    act(() => root.unmount())
    client.clear()
    root = createRoot(container)
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command again')
    expect(command()).toContain(CODE)
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)

    computerApi.createConnectCode.mockResolvedValue({
      code: CODE_2,
      expiresAt: inTenMinutes(),
    })
    act(() => button('Get a new command')!.click())
    await settle(() => command()?.includes(CODE_2) === true, 'new command')
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(2)
  })

  it('drops a stored code a sign-in already used while no tab watched', async () => {
    window.localStorage.setItem(
      'opencomputer.computer.connect-code::',
      JSON.stringify({
        code: 'occ_c3BlbnQ.spent-code-0000000000',
        expiresAt: inTenMinutes(),
        mintedAt: Date.parse('2026-10-22T09:59:00Z'),
      }),
    )
    await show(
      {
        ...empty,
        agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      },
      'Add OpenComputer to Slack',
    )
    act(() => button('Change')!.click())
    await settle(() => command() !== undefined, 'command')
    expect(command()).toContain(CODE)
    expect(command()).not.toContain('spent')
    expect(computerApi.createConnectCode).toHaveBeenCalledTimes(1)
  })

  it('mints a new command once the code expires', async () => {
    computerApi.createConnectCode
      .mockResolvedValueOnce({
        code: CODE,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      })
      .mockResolvedValue({ code: CODE_2, expiresAt: inTenMinutes() })
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(() => command() !== undefined, 'command')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await settle(() => command()?.includes(CODE_2) === true, 'renewed')
  })

  it('says why no command could be had, and tries again', async () => {
    computerApi.createConnectCode.mockRejectedValueOnce(
      new ApiError(
        "Connecting a subscription isn't available yet. Try again shortly.",
        404,
        'not_found',
      ),
    )
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    await settle(
      () => text().includes("Connecting a subscription isn't available yet."),
      'mint error',
    )
    // The paste form still works.
    expect(button('Or paste a token')).toBeDefined()
    act(() => button('Try again')!.click())
    await settle(() => command() !== undefined, 'command')
  })

  it('lands on the step again with Codex chosen, Codex selected', async () => {
    await show(
      { ...empty, agent: { ...fresh, choice: 'codex' } },
      'Choose your coding agent',
    )
    expect(text()).toContain('Step 1 of 4')
    await settle(() => command()?.includes(' codex ') === true, 'codex command')
    expect(computerApi.setAgentChoice).not.toHaveBeenCalled()
  })

  it('starts on free credits', async () => {
    await show({ ...empty, agent: fresh }, 'Choose your coding agent')
    computerApi.setAgentChoice.mockResolvedValue({
      ...fresh,
      choice: 'credits',
    })
    act(() => button('Use free credits')!.click())
    await settle(() => text().includes('Step 2 of 4'), 'Slack step')
    expect(computerApi.setAgentChoice).toHaveBeenCalledWith('credits')
    expect(computerApi.disconnectClaudeSubscription).not.toHaveBeenCalled()
    expect(text()).toContain('Claude Opus 5.5 · free credits')
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_chosen', {
      choice: 'credits',
    })
  })

  it('offers all three ways in the Change dialog, and switches to credits', async () => {
    await show(
      {
        ...empty,
        agent: { ...fresh, choice: 'claude', subscription: subscription('ok') },
      },
      'Add OpenComputer to Slack',
    )
    expect(text()).toContain('Claude Code · your subscription')
    act(() => button('Change')!.click())
    await settle(() => text().includes('Your coding agent'), 'dialog')
    expect(text()).toContain('Now on Claude Code · your subscription.')
    expect(document.body.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(text()).toContain('Codex')
    await settle(() => command() !== undefined, 'command')
    openPaste()
    expect(button('Replace token')).toBeDefined()
    expect(text()).toContain('Switch to free credits.')
    expect(text()).toContain('Disconnects Claude Code')
    // Free credits behind a subscription: disconnect, then record the choice.
    computerApi.disconnectClaudeSubscription.mockResolvedValue(undefined)
    computerApi.setAgentChoice.mockResolvedValue({
      ...fresh,
      choice: 'credits',
    })
    act(() => button('Use free credits')!.click())
    await settle(
      () => computerApi.setAgentChoice.mock.calls.length === 1,
      'credits choice',
    )
    expect(computerApi.disconnectClaudeSubscription).toHaveBeenCalledTimes(1)
    await settle(() => !text().includes('Your coding agent'), 'dialog closed')
    await settle(
      () => text().includes('Claude Opus 5.5 · free credits'),
      'credits row',
    )
    expect(capture).toHaveBeenCalledWith('computer.setup.agent_chosen', {
      choice: 'credits',
    })
  })

  it('shows the health of a token that stopped working, with Resume', async () => {
    await show(
      {
        ...onboarded,
        agent: {
          ...fresh,
          choice: 'claude',
          linked: true,
          linkedSlackUser: { id: 'U1', name: 'maya', teamName: 'Acme' },
          subscription: subscription('invalid'),
        },
      },
      'Your agent',
    )
    expect(text()).toContain('This token stopped working.')
    expect(text()).toContain('Runs threads from @maya in Acme.')
    expect(text()).not.toContain('@U1')
    expect(button('Replace')).toBeDefined()
    expect(button('Disconnect')).toBeDefined()
    computerApi.resumeClaudeSubscription.mockResolvedValue({
      ...fresh,
      choice: 'claude',
      linked: true,
      subscription: subscription('ok'),
    })
    act(() => button('Resume')!.click())
    await settle(() => text().includes('Connected'), 'resumed')
  })

  it('says an unchecked token is saved on the card', async () => {
    await show(
      {
        ...onboarded,
        agent: {
          ...fresh,
          choice: 'claude',
          linked: true,
          subscription: subscription('unchecked'),
        },
      },
      'Your agent',
    )
    expect(text()).toContain("Saved. We'll check it when your computer starts.")
    expect(button('Resume')).toBeUndefined()
  })

  it('sends someone not linked to Slack there to connect', async () => {
    await show(
      { ...onboarded, agent: { ...fresh, choice: 'credits' } },
      'Your agent',
    )
    expect(text()).toContain('Connect from Slack: !claude connect')
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('is not there for an older backend', async () => {
    await show(empty, 'Add OpenComputer to Slack')
    expect(text()).toContain('Step 1 of 3')
    expect(text()).not.toContain('Choose your coding agent')
  })
})

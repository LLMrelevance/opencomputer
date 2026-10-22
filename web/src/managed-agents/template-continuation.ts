function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`
}

export function projectCloneCommand(projectId: string): string {
  return [
    'npx --package @opencomputer/cli opencomputer project clone',
    shellQuote(projectId),
  ].join(' ')
}

export function templatePlaygroundPath(input: {
  projectId: string
  projectAgentId: string
}): string {
  return `/projects/${encodeURIComponent(input.projectId)}/playground/${encodeURIComponent(input.projectAgentId)}`
}

export function installedTemplateAgentId(input: {
  projectAgentId: string
  localAgentId?: string
  primaryLocalAgentId?: string
}): string {
  return !input.localAgentId || input.localAgentId === input.primaryLocalAgentId
    ? input.projectAgentId
    : `${input.projectAgentId}--${input.localAgentId}`
}

export function templateFirstRunPrompt(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined
  const prompt = (state as Record<string, unknown>).templateFirstRunPrompt
  return typeof prompt === 'string' && prompt.trim() ? prompt : undefined
}

type MemoryBinding = {
  scope: 'document' | 'collection'
  id?: string
  access?: 'read' | 'read-write'
}

/**
 * Memory bindings a template launch asks the first playground session to be
 * created with (navigation state, keyed by resource id). The CVE swarm launch
 * binds its findings document here so the run can persist its verdicts; without
 * a binding the agent's `useMemory` hook fails admission.
 */
export function templateFirstRunMemory(
  state: unknown,
): Record<string, MemoryBinding> | undefined {
  if (!state || typeof state !== 'object') return undefined
  const memory = (state as Record<string, unknown>).templateFirstRunMemory
  if (!memory || typeof memory !== 'object') return undefined
  const entries: Array<[string, MemoryBinding]> = []
  for (const [resource, binding] of Object.entries(
    memory as Record<string, unknown>,
  )) {
    if (!binding || typeof binding !== 'object') continue
    const { scope, id, access } = binding as Record<string, unknown>
    if (scope !== 'document' && scope !== 'collection') continue
    const entry: MemoryBinding = { scope }
    if (typeof id === 'string') entry.id = id
    if (access === 'read' || access === 'read-write') entry.access = access
    entries.push([resource, entry])
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

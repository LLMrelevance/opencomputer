import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createManagedMemoryDocument,
  getManagedAgentSession,
  getManagedMemoryDocument,
} from '../api'
import {
  buildRunReport,
  cellDocumentId,
  parseCellFinding,
  runReportDocumentId,
  SECURITY_FINDINGS_RESOURCE,
  serializeRunReport,
  type CellFinding,
  type LaunchedCell,
  type ReportCell,
  type ReportDisposition,
  type SwarmCell,
  type SwarmRunReport,
} from './catalog'

// A cell can fail two ways: the whole session stops (status failed/cancelled),
// or — the common one — the session stays `idle` while its last turn is
// `failed` (a single-turn cell whose final generation errored). So we read the
// last turn's status, not just the session's.
export type SessionProgress = {
  status: string
  lastTurnStatus?: string
}

export type CellState = {
  cell: SwarmCell
  sessionId: string
  progress?: SessionProgress
  finding: CellFinding | null
}

export type CellPhase = 'done' | 'failed' | 'running' | 'queued'

export type SwarmCounts = {
  exposed: number
  'not-exposed': number
  'needs-review': number
  failed: number
  pending: number
}

function sessionFailed(progress: SessionProgress | undefined): boolean {
  if (!progress) return false
  if (progress.status === 'failed' || progress.status === 'cancelled')
    return true
  const turn = progress.lastTurnStatus
  return turn === 'failed' || turn === 'errored' || turn === 'cancelled'
}

// A cell is settled — we will never poll it again — when its verdict is saved
// or it failed, i.e. its phase is 'done' or 'failed'.
export function cellPhase(state: CellState): CellPhase {
  if (state.finding) return 'done'
  if (sessionFailed(state.progress)) return 'failed'
  const status = state.progress?.status
  if (status === 'running' || status === 'idle') return 'running'
  return 'queued'
}

export type SwarmRunData = {
  states: CellState[]
  counts: SwarmCounts
  settled: boolean
  report: SwarmRunReport | null
}

// Poll one run's sessions (for liveness) and each cell's findings document (for
// the verdict) until every cell settles, then roll the verdicts into the run
// report and persist it once. Both the grid and the map view consume this, so
// the run is polled once no matter which view is on screen.
export function useSwarmRun({
  projectId,
  runId,
  cells,
  target = '',
  model = '',
}: {
  projectId: string
  runId: string
  cells: readonly LaunchedCell[]
  target?: string
  model?: string
}): SwarmRunData {
  // Both polls stop the moment every cell has settled. We recompute that each
  // render and park it in a ref the two refetchInterval closures read, so
  // neither needs the other's query data.
  const allSettledRef = useRef(false)

  const sessions = useQuery({
    queryKey: ['swarm-sessions', projectId, runId],
    queryFn: async () => {
      const entries = await Promise.all(
        cells.map(async ({ sessionId }) => {
          const session = await getManagedAgentSession(sessionId)
          const turns = session.turns
          const lastTurnStatus =
            turns.length > 0 ? turns[turns.length - 1].status : undefined
          return [sessionId, { status: session.status, lastTurnStatus }] as const
        }),
      )
      return Object.fromEntries(entries)
    },
    refetchInterval: () => (allSettledRef.current ? false : 3_000),
  })

  const findings = useQuery({
    queryKey: ['swarm-findings', projectId, runId],
    queryFn: async () => {
      const entries = await Promise.all(
        cells.map(async ({ cell }) => {
          const read = await getManagedMemoryDocument({
            projectId,
            resource: SECURITY_FINDINGS_RESOURCE,
            environment: 'default',
            id: cellDocumentId(runId, cell),
          })
          return [
            cellDocumentId(runId, cell),
            parseCellFinding(read.document.text),
          ] as const
        }),
      )
      return Object.fromEntries(entries)
    },
    refetchInterval: () => (allSettledRef.current ? false : 4_000),
  })

  const progressBySession = useMemo(
    () => sessions.data ?? {},
    [sessions.data],
  )

  const states: CellState[] = cells.map(({ cell, sessionId }) => ({
    cell,
    sessionId,
    progress: progressBySession[sessionId],
    finding: findings.data?.[cellDocumentId(runId, cell)] ?? null,
  }))

  const counts: SwarmCounts = states.reduce(
    (acc, state) => {
      const phase = cellPhase(state)
      if (phase === 'done' && state.finding)
        acc[state.finding.disposition] += 1
      else if (phase === 'failed') acc.failed += 1
      else acc.pending += 1
      return acc
    },
    { exposed: 0, 'not-exposed': 0, 'needs-review': 0, failed: 0, pending: 0 },
  )
  const settled = counts.pending === 0

  useEffect(() => {
    allSettledRef.current = settled
  }, [settled])

  // Once every cell has settled, roll the verdicts into the run report — the
  // swarm's artifact — and persist it once (create-once, so a reload that
  // re-settles the same run is a no-op).
  const report: SwarmRunReport | null = settled
    ? buildRunReport(
        { runId, target, model, generatedAt: new Date().toISOString() },
        states.map((s): ReportCell => {
          const disposition: ReportDisposition = s.finding
            ? s.finding.disposition
            : 'failed'
          return {
            repository: s.cell.repository,
            cveId: s.cell.cveId,
            disposition,
            ...(s.finding?.reasoning ? { reasoning: s.finding.reasoning } : {}),
            ...(s.finding?.pullRequest
              ? { pullRequest: s.finding.pullRequest }
              : {}),
          }
        }),
      )
    : null

  const reportWrittenRef = useRef(false)
  useEffect(() => {
    if (!report || reportWrittenRef.current) return
    reportWrittenRef.current = true
    void createManagedMemoryDocument({
      projectId,
      resource: SECURITY_FINDINGS_RESOURCE,
      environment: 'default',
      id: runReportDocumentId(runId),
      title: `Swarm report ${runId}`,
      text: serializeRunReport(report),
      agentWrites: 'disabled',
    }).catch(() => {
      // Already written by an earlier view of this run — leave it be.
    })
  }, [report, projectId, runId])

  return { states, counts, settled, report }
}

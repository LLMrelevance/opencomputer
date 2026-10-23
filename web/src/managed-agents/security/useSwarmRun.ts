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
  phase: CellPhase
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

// A single-turn cell's turn is `completed` the moment the agent finishes, even
// when it wrote no verdict. The session then sits `idle`, so without this the
// cell would read as "running" forever and the run would never settle.
function turnCompleted(progress: SessionProgress | undefined): boolean {
  return progress?.lastTurnStatus === 'completed'
}

// A cell's session is terminal when it will do no more work: it failed, or its
// turn completed (whether or not it left a finding).
function cellTerminal(
  progress: SessionProgress | undefined,
  finding: CellFinding | null,
): boolean {
  return finding != null || sessionFailed(progress) || turnCompleted(progress)
}

// `confirmed` means we have re-read findings after the whole run went terminal,
// so a completed cell with no finding really produced no verdict rather than us
// racing the write. Until then we keep such a cell "running".
function computeCellPhase(
  progress: SessionProgress | undefined,
  finding: CellFinding | null,
  confirmed: boolean,
): CellPhase {
  if (finding) return 'done'
  if (sessionFailed(progress)) return 'failed'
  if (turnCompleted(progress)) return confirmed ? 'failed' : 'running'
  const status = progress?.status
  if (status === 'running' || status === 'idle') return 'running'
  return 'queued'
}

// A cell is settled — we will never poll it again — when its phase is 'done' or
// 'failed'. The phase is computed in the hook (it needs the run-wide confirm) and
// carried on the state, so views just read it.
export function cellPhase(state: CellState): CellPhase {
  return state.phase
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
  // The sessions poll stops once every cell is terminal (sessions won't change
  // after that); the findings poll runs one cycle longer, until the run is
  // settled, so a verdict written just as a turn completed isn't lost to poll
  // lag. Both flags are recomputed each render and parked in refs the
  // refetchInterval closures read.
  const sessionsDoneRef = useRef(false)
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
    refetchInterval: () => (sessionsDoneRef.current ? false : 3_000),
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

  const base = cells.map(({ cell, sessionId }) => ({
    cell,
    sessionId,
    progress: progressBySession[sessionId],
    finding: findings.data?.[cellDocumentId(runId, cell)] ?? null,
  }))

  // When every cell's session is terminal we freeze the sessions poll (below),
  // so `sessions.dataUpdatedAt` stops advancing at that observation. The run is
  // only `confirmed` once a findings fetch lands at/after that frozen snapshot —
  // i.e. we re-read findings after the last turn completed. That guards against
  // reading a finding-less cell as a failure when its verdict was written just
  // before its turn completed. Both timestamps are plain query values, read in
  // render; the stop flags are the only refs, written in effects.
  const allTerminal =
    base.length > 0 && base.every((s) => cellTerminal(s.progress, s.finding))
  const confirmed =
    allTerminal && findings.dataUpdatedAt >= sessions.dataUpdatedAt

  const states: CellState[] = base.map((s) => ({
    ...s,
    phase: computeCellPhase(s.progress, s.finding, confirmed),
  }))

  const counts: SwarmCounts = states.reduce(
    (acc, state) => {
      if (state.phase === 'done' && state.finding)
        acc[state.finding.disposition] += 1
      else if (state.phase === 'failed') acc.failed += 1
      else acc.pending += 1
      return acc
    },
    { exposed: 0, 'not-exposed': 0, 'needs-review': 0, failed: 0, pending: 0 },
  )
  const settled = confirmed

  useEffect(() => {
    sessionsDoneRef.current = allTerminal
  }, [allTerminal])
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

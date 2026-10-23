import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Grid3x3, Loader2, Network, Radar } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getManagedMemoryDocument,
  getManagedMemoryDocuments,
} from '../api'
import {
  latestManifestId,
  parseRunManifest,
  parseRunReport,
  runManifestDocumentId,
  runReportDocumentId,
  SECURITY_FINDINGS_RESOURCE,
  type SwarmRunManifest,
  type SwarmRunReport,
} from './catalog'
import { RunReportCard, SwarmGrid } from './SwarmGrid'
import { SwarmMap } from './SwarmMap'
import {
  statesFromReport,
  useSwarmRun,
  type CellState,
  type SwarmCounts,
} from './useSwarmRun'

// One swarm run. The route carries the run id; without one we fall back to the
// latest manifest in the project so older `/swarm` links still land somewhere.
export default function ProjectSwarm() {
  const { projectId = '', runId } = useParams()

  const manifest = useQuery({
    queryKey: ['swarm-manifest', projectId, runId ?? 'latest'],
    enabled: Boolean(projectId),
    queryFn: async () => {
      let id: string | null
      if (runId) {
        id = runManifestDocumentId(runId)
      } else {
        const page = await getManagedMemoryDocuments({
          projectId,
          resource: SECURITY_FINDINGS_RESOURCE,
          environment: 'default',
        })
        id = latestManifestId(page.documents)
      }
      if (!id) return null
      const read = await getManagedMemoryDocument({
        projectId,
        resource: SECURITY_FINDINGS_RESOURCE,
        environment: 'default',
        id,
      })
      return parseRunManifest(read.document.text)
    },
  })

  return (
    <div className="bg-background min-h-screen">
      {/* This view runs outside the app shell, so it carries its own slim bar
          back to the project's swarms list. */}
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-4">
          <Link
            to={`/projects/${encodeURIComponent(projectId)}/swarms`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
          >
            <ArrowLeft className="size-3.5" /> Back to swarms
          </Link>
          {manifest.data ? (
            <span className="text-muted-foreground truncate font-mono text-xs">
              {manifest.data.runId}
            </span>
          ) : null}
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {manifest.isPending ? (
          <div className="text-muted-foreground inline-flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading the run…
          </div>
        ) : manifest.data ? (
          <RunView projectId={projectId} manifest={manifest.data} />
        ) : (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <Radar className="text-muted-foreground mx-auto size-6" />
            <p className="text-muted-foreground mt-3 text-sm">
              This swarm run could not be found.
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link to="/security">Launch a swarm</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// A settled run leaves a persisted report. Reading it back lets us render the
// whole run from one document — no per-cell session polling, each of which would
// wake a durable object. We only fall through to the live poll when no report
// exists yet, i.e. the run is still going.
function RunView({
  projectId,
  manifest,
}: {
  projectId: string
  manifest: SwarmRunManifest
}) {
  const report = useQuery({
    queryKey: ['swarm-report', projectId, manifest.runId],
    queryFn: async (): Promise<SwarmRunReport | null> => {
      try {
        const read = await getManagedMemoryDocument({
          projectId,
          resource: SECURITY_FINDINGS_RESOURCE,
          environment: 'default',
          id: runReportDocumentId(manifest.runId),
        })
        return parseRunReport(read.document.text)
      } catch {
        // No report document yet — the run is still in flight.
        return null
      }
    },
  })

  if (report.isPending) {
    return (
      <div className="text-muted-foreground inline-flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Loading the run…
      </div>
    )
  }

  if (report.data) {
    const { states, counts } = statesFromReport(report.data)
    return (
      <RunBody
        projectId={projectId}
        manifest={manifest}
        states={states}
        counts={counts}
        settled
        report={report.data}
      />
    )
  }

  return <LiveRun projectId={projectId} manifest={manifest} />
}

// The run is still going: poll it live. Splitting this out keeps the hook off the
// settled path entirely, so a finished run never starts an interval.
function LiveRun({
  projectId,
  manifest,
}: {
  projectId: string
  manifest: SwarmRunManifest
}) {
  const run = useSwarmRun({
    projectId,
    runId: manifest.runId,
    cells: manifest.cells,
    target: manifest.target,
    model: manifest.model,
  })
  return (
    <RunBody
      projectId={projectId}
      manifest={manifest}
      states={run.states}
      counts={run.counts}
      settled={run.settled}
      report={run.report}
    />
  )
}

function RunBody({
  projectId,
  manifest,
  states,
  counts,
  settled,
  report,
}: {
  projectId: string
  manifest: SwarmRunManifest
  states: CellState[]
  counts: SwarmCounts
  settled: boolean
  report: SwarmRunReport | null
}) {
  // While the run is live the map tells the story; once it settles the grid is
  // the artifact, so we default there. An explicit toggle overrides either.
  const [override, setOverride] = useState<'map' | 'grid' | null>(null)
  const view = override ?? (settled ? 'grid' : 'map')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="CVE Swarm"
          description={`${manifest.target || 'target'} · ${manifest.model || 'model'} · ${manifest.cells.length} cells`}
        />
        <div className="bg-muted inline-flex items-center rounded-md p-0.5">
          <ToggleButton
            active={view === 'map'}
            onClick={() => setOverride('map')}
            icon={Network}
            label="Map"
          />
          <ToggleButton
            active={view === 'grid'}
            onClick={() => setOverride('grid')}
            icon={Grid3x3}
            label="Grid"
          />
        </div>
      </div>

      {view === 'map' ? (
        <div className="space-y-4">
          <SwarmMap states={states} counts={counts} settled={settled} />
          {report ? (
            <RunReportCard report={report} projectId={projectId} />
          ) : null}
        </div>
      ) : (
        <SwarmGrid
          projectId={projectId}
          runId={manifest.runId}
          states={states}
          counts={counts}
          settled={settled}
          report={report}
        />
      )}
    </div>
  )
}

function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Network
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

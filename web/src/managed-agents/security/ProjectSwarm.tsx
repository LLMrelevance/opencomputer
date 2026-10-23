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
  runManifestDocumentId,
  SECURITY_FINDINGS_RESOURCE,
  type SwarmRunManifest,
} from './catalog'
import { RunReportCard, SwarmGrid } from './SwarmGrid'
import { SwarmMap } from './SwarmMap'
import { useSwarmRun } from './useSwarmRun'

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
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link
        to={`/projects/${encodeURIComponent(projectId)}/swarms`}
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="size-3.5" /> All swarms
      </Link>
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
  )
}

function RunView({
  projectId,
  manifest,
}: {
  projectId: string
  manifest: SwarmRunManifest
}) {
  const [view, setView] = useState<'map' | 'grid'>('map')
  const run = useSwarmRun({
    projectId,
    runId: manifest.runId,
    cells: manifest.cells,
    target: manifest.target,
    model: manifest.model,
  })

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
            onClick={() => setView('map')}
            icon={Network}
            label="Map"
          />
          <ToggleButton
            active={view === 'grid'}
            onClick={() => setView('grid')}
            icon={Grid3x3}
            label="Grid"
          />
        </div>
      </div>

      {view === 'map' ? (
        <div className="space-y-4">
          <SwarmMap
            states={run.states}
            counts={run.counts}
            settled={run.settled}
          />
          {run.report ? <RunReportCard report={run.report} /> : null}
        </div>
      ) : (
        <SwarmGrid
          projectId={projectId}
          runId={manifest.runId}
          states={run.states}
          counts={run.counts}
          settled={run.settled}
          report={run.report}
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

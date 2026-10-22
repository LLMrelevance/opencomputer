// Static catalog for the CVE Swarm security onboarding (?security=1). These are
// UI defaults only — the real authorization boundary is the GitHub App install
// the user connects, and the code-owned safety rails live in the deployed
// cve-swarm template. Nothing here widens scope; it only prefills the payload.

// The deployable template the security flow installs. Must be a public repo the
// template-installation backend can inspect.
export const SECURITY_SWARM_TEMPLATE_REPOSITORY =
  'https://github.com/diggerhq/opencomputer-example-cve-swarm'

// Default model for the swarm. GLM via the org's model-access connection.
export const DEFAULT_SWARM_MODEL = 'GLM-5.3'

// The attestation the operator must accept before a scan can launch. Recorded
// with the run; the scan stays passive in code regardless.
export const SCAN_DECLARATION =
  'I declare that I own this web application and I am authorized to perform this penetration test.'

export type SeedCve = {
  readonly id: string
  readonly product: string
  readonly severity: 'critical' | 'high' | 'medium' | 'low'
  readonly cvss: number
}

// This week's feed, mirroring the launch page and the template's feed.ts. The
// payload builder opens with all of these pre-selected so a first swarm runs
// with zero typing.
export const SEED_CVES: readonly SeedCve[] = [
  {
    id: 'CVE-2026-109618',
    product: 'PHP2Shell',
    severity: 'critical',
    cvss: 9.8,
  },
  {
    id: 'CVE-2026-110264',
    product: 'GitLab CE/EE',
    severity: 'critical',
    cvss: 9.6,
  },
  {
    id: 'CVE-2026-96951',
    product: 'Windows Shell',
    severity: 'high',
    cvss: 8.1,
  },
  {
    id: 'CVE-2026-21445',
    product: 'Oracle Access Manager',
    severity: 'critical',
    cvss: 10.0,
  },
  {
    id: 'CVE-2026-21446',
    product: 'Oracle SOA Suite',
    severity: 'critical',
    cvss: 10.0,
  },
  {
    id: 'CVE-2026-21447',
    product: 'Oracle E-Business Suite',
    severity: 'critical',
    cvss: 10.0,
  },
]

export type SwarmPayload = {
  readonly target: string
  readonly declarationAccepted: boolean
  readonly repositories: readonly string[]
  readonly cveIds: readonly string[]
  readonly model: string
}

// Compose the controller's first-run input from the payload. This is exactly
// what the swarm agent receives as its opening instruction when the session
// starts — the scan → prove → report pipeline, with fixes gated by the
// template's PUBLISH_ENABLED (dry run by default).
export function composeLaunchPrompt(payload: SwarmPayload): string {
  const repos =
    payload.repositories.length > 0
      ? payload.repositories.join(', ')
      : 'all connected repositories'
  const cves =
    payload.cveIds.length > 0
      ? payload.cveIds.join(', ')
      : "this week's full feed"
  const lines = [
    'Launch a CVE swarm against my own assets.',
    '',
    `Declaration: ${SCAN_DECLARATION}`,
    payload.target
      ? `Target endpoint (passive scan only): ${payload.target}`
      : null,
    `Repositories: ${repos}`,
    `CVEs: ${cves}`,
    `Model: ${payload.model}`,
    '',
    payload.target
      ? 'Run scan_surface on the target to fingerprint it passively, then prove_reachability across the repository × CVE matrix, then report_findings once.'
      : 'Run prove_reachability across the repository × CVE matrix, then report_findings once.',
    'For any EXPOSED verdict, open_fix_pull_request (dependency-only, single pin). Honor PUBLISH_ENABLED — dry run unless it is enabled.',
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

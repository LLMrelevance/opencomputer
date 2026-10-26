// A route family is one backend surface the edge proxies as a unit: which
// routes it allows, who may reach them and how their replies are shaped.
// `proxyManagedAgents` looks a request's family up once and dispatches to it,
// instead of branching per route at each of those four points.
//
// Only the organization's computer is a family so far: its dashboard surface
// (./computer.ts) and its session API (./computer_api.ts, work 084). The
// Slack-setup, deployment-source, Linear and workspace-export routes still
// take the hand-written branches in managed_agents.ts; each can be ported to
// this interface on its own, without changing the others' behaviour.

import type { ManagedAgentsEnv } from "./managed_agents";

export interface RouteFamily {
  /** Whether the suffix is this family's, whatever the method. */
  owns(suffix: string): boolean;
  /** Whether the method and suffix are a route in the family's contract. */
  allows(method: string, suffix: string): boolean;
  /** Only the dashboard mount reaches the family; API keys get a 404. */
  dashboardOnly: boolean;
  /** Only the API mount (`/api/managed-agents`) reaches the family. */
  apiOnly?: boolean;
  /** Whether the organization has the family (rollouts); true when absent. */
  enabledFor?(env: ManagedAgentsEnv, orgID: string | null | undefined): boolean;
  /**
   * The public response for a successful upstream reply. Throws on a body
   * that cannot honour the contract; the proxy turns that into its 502.
   */
  shapeSuccess(
    method: string,
    suffix: string,
    upstream: Response,
  ): Promise<Response>;
  /**
   * Copy for an upstream refusal: fixed copy, unless the family vouches for
   * a code whose backend message is written for people (`backendMessage`).
   */
  errorMessage(
    code: string,
    status: number,
    suffix: string,
    backendMessage: string,
  ): string;
  /**
   * Takes over the upstream exchange once the edge has allowed the route and
   * built `target` and `headers` (assertion included): for a family whose
   * backend already speaks the public contract, so bodies, statuses and
   * errors stream through instead of being rebuilt by shapeSuccess and
   * errorMessage.
   */
  forward?(args: {
    request: Request;
    method: string;
    suffix: string;
    target: URL;
    headers: Headers;
  }): Promise<Response>;
}

import { WorkerEntrypoint } from "cloudflare:workers";

import { selfHealHalt, type AutumnEnv } from "./autumn_webhook";
import {
  getManagedAgentBillingAdmission,
  type ManagedAgentBillingAdmission,
} from "./managed_agent_credit_gate";

/** Private RPC surface consumed through a Cloudflare service binding. */
export class ManagedAgentBillingService extends WorkerEntrypoint<AutumnEnv> {
  async checkAdmission(orgID: string): Promise<ManagedAgentBillingAdmission> {
    return getManagedAgentBillingAdmission(this.env, orgID, (id) =>
      selfHealHalt(this.env, id),
    );
  }
}

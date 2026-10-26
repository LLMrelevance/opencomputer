// API key lifecycle → the computer (work 084). Blue keeps its own record of
// the organization's keys (by hash, never the key) so it can name the key
// that acted and refuse a revoked one at once rather than after the edge's
// auth cache ages out. The edge tells it when a key is created or revoked.
//
// Best-effort: callers hand the promise to ctx.waitUntil, failures are
// logged and never reach the person creating or revoking the key. Without
// MANAGED_AGENTS_API_URL or OC_MANAGED_AGENTS_SECRET it does nothing.

import {
  mintManagedAgentsAssertion,
  type ManagedAgentsEnv,
} from "./managed_agents";

export interface SyncedComputerKey {
  id: string;
  /** SHA-256 hex of the key. */
  hash: string;
  name: string;
  kind: "user" | "project";
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  userId: string | null;
}

type SyncEnv = Pick<
  ManagedAgentsEnv,
  "MANAGED_AGENTS_API_URL" | "OC_MANAGED_AGENTS_SECRET"
>;

async function post(
  env: SyncEnv,
  orgID: string,
  userID: string | null,
  op: "sync" | "revoke",
  body: unknown,
): Promise<void> {
  const base = env.MANAGED_AGENTS_API_URL?.replace(/\/+$/, "");
  if (!base || !env.OC_MANAGED_AGENTS_SECRET) return;
  try {
    const assertion = await mintManagedAgentsAssertion(
      env.OC_MANAGED_AGENTS_SECRET,
      { orgID, userID },
    );
    const response = await fetch(`${base}/v1/computer/keys/${op}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencomputer-agent-token": assertion,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error(
        JSON.stringify({
          level: "error",
          event: `computer_keys.${op}_failed`,
          status: response.status,
        }),
      );
    }
    await response.body?.cancel();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: `computer_keys.${op}_failed`,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** A key was created: asserted as its organization and creator. */
export function syncComputerKey(
  env: SyncEnv,
  orgID: string,
  key: SyncedComputerKey,
): Promise<void> {
  return post(env, orgID, key.userId, "sync", { key });
}

/** A key was revoked: asserted as its organization and the person revoking. */
export function revokeComputerKey(
  env: SyncEnv,
  orgID: string,
  actingUserID: string | null,
  keyID: string,
): Promise<void> {
  return post(env, orgID, actingUserID, "revoke", { keyId: keyID });
}

/** The sync shape of a key just created, from what createAPIKey returned. */
export function createdKeyForSync(
  created: {
    id: string;
    name: string;
    scopes?: string[] | string;
    expiresAt?: string | null;
    createdAt?: string;
  },
  hash: string,
  userID: string | null,
): SyncedComputerKey {
  const scopes = Array.isArray(created.scopes)
    ? created.scopes
    : (created.scopes ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
  return {
    id: created.id,
    hash,
    name: created.name,
    kind: "user",
    scopes,
    expiresAt: created.expiresAt ?? null,
    createdAt: created.createdAt ?? new Date().toISOString(),
    userId: userID,
  };
}

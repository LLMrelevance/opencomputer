import { spawnSync } from "node:child_process";

/** A one-hour push credential for the organization's automations repository (work 067). */
export interface AutomationsRepositoryCredential {
  remoteUrl: string;
  username: string;
  password: string;
  expiresAt: string;
}

/**
 * Git configuration that authenticates one push to the repository, passed in
 * the environment so the credential never appears in argv, a remote, or a
 * config file.
 */
export function gitPushEnvironment(
  credential: AutomationsRepositoryCredential,
): Record<string, string> {
  const authorization = Buffer.from(
    `${credential.username}:${credential.password}`,
  ).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${new URL(credential.remoteUrl).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Pushes `ref` (HEAD by default) of the git repository at `directory` to the
 * automations repository's `main`. Git refuses a push that would drop commits
 * already there, so a person and the computer cannot overwrite each other.
 */
export function pushToAutomationsRepository(input: {
  credential: AutomationsRepositoryCredential;
  directory: string;
  ref?: string;
}): void {
  const result = spawnSync(
    "git",
    [
      "push",
      input.credential.remoteUrl,
      `${input.ref ?? "HEAD"}:refs/heads/main`,
    ],
    {
      cwd: input.directory,
      stdio: "inherit",
      env: { ...process.env, ...gitPushEnvironment(input.credential) },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "git push failed. If the repository has commits you do not, fetch and merge them first.",
    );
  }
}

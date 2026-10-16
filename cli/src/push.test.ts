import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitPushEnvironment, pushToProjectRepository } from "./push.js";

const credential = {
  remoteUrl: "https://acme.code.storage/automation-prj_1.git",
  username: "t",
  password: "jwt",
  expiresAt: "2026-10-16T02:00:00.000Z",
};

test("authenticates git for the repository's origin only, outside argv", () => {
  assert.deepEqual(gitPushEnvironment(credential), {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://acme.code.storage/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("t:jwt").toString("base64")}`,
    GIT_TERMINAL_PROMPT: "0",
  });
});

test("pushes HEAD to main and refuses to drop commits already there", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  const root = mkdtempSync(join(tmpdir(), "oc-push-"));
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  const local = { ...credential, remoteUrl: `file://${remote}` };
  const work = (name: string) => {
    const directory = join(root, name);
    git(root, "init", "-q", directory);
    writeFileSync(join(directory, "agent.ts"), name);
    git(directory, "add", ".");
    git(directory, "commit", "-qm", name);
    return directory;
  };
  const computer = work("computer");
  pushToProjectRepository({ credential: local, directory: computer });
  assert.equal(
    git(remote, "rev-parse", "main"),
    git(computer, "rev-parse", "HEAD"),
  );
  assert.throws(
    () =>
      pushToProjectRepository({ credential: local, directory: work("laptop") }),
    /fetch and merge/,
  );
});

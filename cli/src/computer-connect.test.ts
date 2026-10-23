import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { APIError, OpenComputerClient } from "./api.js";
import { runCommand } from "./commands.js";
import {
  claudeTokenFromScreen,
  claudeTokenFromTerminalOutput,
  codexAuthJson,
  connectError,
  findExecutable,
  runClaudeSetupToken,
  sendComputerConnect,
  setupTokenCommand,
  takeModelConnectArgs,
} from "./computer-connect.js";
import { CLIError, structuredError } from "./errors.js";
import { renderTerminalScreen } from "./terminal-screen.js";

const TOKEN =
  "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-ZyXwVu-QAA";
const CODE = "occ_YWNjdF8xMjM.Zm9vYmFyYmF6cXV4cXV1eA";

function parse(provider: "claude" | "codex", args: string[]) {
  return takeModelConnectArgs(provider, args, {
    option(name) {
      const index = args.indexOf(name);
      if (index < 0) return undefined;
      const value = args[index + 1];
      args.splice(index, 2);
      return value;
    },
    flag(name) {
      const index = args.indexOf(name);
      if (index < 0) return false;
      args.splice(index, 1);
      return true;
    },
  });
}

test("model connect parses --code and --token-stdin", () => {
  assert.deepEqual(parse("claude", ["--code", CODE]), { code: CODE, tokenStdin: false });
  assert.deepEqual(parse("claude", ["--token-stdin", "--code", CODE]), {
    code: CODE,
    tokenStdin: true,
  });
  assert.deepEqual(parse("codex", ["--code", CODE]), { code: CODE, tokenStdin: false });
  // codex without a code is left to the serverless-agent connect.
  const rest = ["--project", "demo"];
  assert.deepEqual(parse("codex", rest), { code: undefined, tokenStdin: false });
  assert.deepEqual(rest, ["--project", "demo"]);
});

test("model connect rejects a missing or malformed code and stray arguments", () => {
  assert.throws(
    () => parse("claude", []),
    (error: unknown) =>
      error instanceof CLIError &&
      error.code === "connect_code_required" &&
      error.hint === "Get a connect command from the dashboard (Computer → Agent).",
  );
  assert.throws(
    () => parse("claude", ["--code", "not-a-code"]),
    (error: unknown) => error instanceof CLIError && error.code === "connect_code_invalid",
  );
  assert.throws(() => parse("codex", ["--code", CODE, "--token-stdin"]), /only for/);
  assert.throws(() => parse("claude", ["--code", CODE, "--project", "x"]), /Unexpected argument: --project/);
});

async function withIsolatedConfig(fn: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oc-connect-"));
  const previous = {
    config: process.env.OPENCOMPUTER_CONFIG,
    key: process.env.OPENCOMPUTER_API_KEY,
    url: process.env.OPENCOMPUTER_API_URL,
  };
  process.env.OPENCOMPUTER_CONFIG = join(directory, "config.json");
  delete process.env.OPENCOMPUTER_API_KEY;
  delete process.env.OPENCOMPUTER_API_URL;
  try {
    await fn();
  } finally {
    for (const [name, value] of [
      ["OPENCOMPUTER_CONFIG", previous.config],
      ["OPENCOMPUTER_API_KEY", previous.key],
      ["OPENCOMPUTER_API_URL", previous.url],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("model, models and model-access are the same command", async (context) => {
  await withIsolatedConfig(async () => {
    const requests: Request[] = [];
    context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ data: [] });
    });
    const writes: string[] = [];
    context.mock.method(process.stdout, "write", (chunk: string) => {
      writes.push(String(chunk));
      return true;
    });
    for (const noun of ["model", "models", "model-access"]) {
      await assert.rejects(
        runCommand(noun, ["connect", "claude"], { json: false }),
        (error: unknown) => error instanceof CLIError && error.code === "connect_code_required",
      );
      await assert.rejects(
        runCommand(noun, ["bogus"], { json: false }),
        /Use `opencomputer model-access connect\|list\|disconnect`/,
      );
      await runCommand(noun, ["list"], { json: false, apiKey: "osb_test" });
    }
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(
        request.url,
        "https://app.opencomputer.dev/api/managed-agents/model-access/connections",
      );
      assert.equal(request.headers.get("x-api-key"), "osb_test");
    }
    assert.deepEqual(writes, Array(3).fill("No model access connections.\n"));
  });
});

test("--code needs a named provider", async () => {
  await withIsolatedConfig(async () => {
    await assert.rejects(
      runCommand("model", ["connect", "--code", CODE], { json: false }),
      /Usage: opencomputer model connect claude\|codex --code <code>/,
    );
  });
});

test("Codex auth.json is the Codex CLI shape and needs every token", () => {
  assert.deepEqual(
    codexAuthJson({ idToken: "id.jwt", accessToken: "access", refreshToken: "refresh" }),
    {
      auth_mode: "chatgpt",
      tokens: { id_token: "id.jwt", access_token: "access", refresh_token: "refresh" },
    },
  );
  assert.throws(
    () => codexAuthJson({ accessToken: "access", refreshToken: "refresh" }),
    (error: unknown) => error instanceof CLIError && error.code === "codex_login_incomplete",
  );
  assert.throws(() => codexAuthJson({ idToken: "id", accessToken: "access" }), CLIError);
});

test("connect posts the code and credential without any API key", async (context) => {
  const requests: Request[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ provider: "claude", connected: true });
  });
  // Even with a key configured, the connect request must not carry it.
  const client = new OpenComputerClient({ apiUrl: "http://localhost:8787", apiKey: "osb_secret" });
  const response = await sendComputerConnect(client, { code: CODE, provider: "claude", token: TOKEN });
  assert.deepEqual(response, { provider: "claude", connected: true });
  const request = requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "http://localhost:8787/api/managed-agents/computer/agent/connect");
  assert.equal(request.headers.get("x-api-key"), null);
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.deepEqual(await request.json(), { code: CODE, provider: "claude", token: TOKEN });

  await sendComputerConnect(client, {
    code: CODE,
    provider: "codex",
    authJson: codexAuthJson({ idToken: "i", accessToken: "a", refreshToken: "r" }),
  });
  assert.deepEqual(await requests[1]!.json(), {
    code: CODE,
    provider: "codex",
    authJson: { auth_mode: "chatgpt", tokens: { id_token: "i", access_token: "a", refresh_token: "r" } },
  });
});

test("connect errors read well and never carry the credential", async (context) => {
  const answers = [
    Response.json(
      {
        error: {
          code: "computer_connect_code_invalid",
          message: "That connect code is not valid. Get a new one from the dashboard.",
        },
      },
      { status: 401 },
    ),
    Response.json(
      { error: { code: "computer_agent_claude_token", message: `Claude refused ${TOKEN}` } },
      { status: 422 },
    ),
    new Response(JSON.stringify({ title: "Bad", detail: "The token was not accepted." }), {
      status: 422,
      headers: { "content-type": "application/problem+json" },
    }),
    new Response("not found", { status: 404 }),
    Response.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
  ];
  context.mock.method(globalThis, "fetch", async () => answers.shift()!);
  const client = new OpenComputerClient({ apiUrl: "https://app.opencomputer.dev" });
  const attempt = async () => {
    try {
      await sendComputerConnect(client, { code: CODE, provider: "claude", token: TOKEN });
    } catch (error) {
      return structuredError(error);
    }
    assert.fail("expected a failure");
  };

  const invalid = await attempt();
  assert.equal(invalid.code, "connect_code_invalid");
  assert.equal(invalid.message, "That connect code is not valid. Get a new one from the dashboard.");
  assert.match(invalid.hint, /Computer → Agent/);

  const refused = await attempt();
  assert.equal(refused.code, "computer_agent_claude_token");
  assert.equal(refused.message, "Claude refused [redacted]");
  assert.match(refused.hint, /code is still good/);

  const problem = await attempt();
  assert.equal(problem.message, "The token was not accepted.");
  assert.equal(problem.code, "connect_rejected");

  assert.equal((await attempt()).code, "connect_unavailable");
  assert.equal((await attempt()).code, "internal");

  for (const failure of [invalid, refused, problem])
    assert.doesNotMatch(JSON.stringify(failure), /sk-ant-oat/);
});

test("connectError redacts secrets from non-API errors too", () => {
  const error = connectError(new Error(`odd failure for ${TOKEN}`), "claude", [TOKEN]);
  assert.equal((error as Error).message, "odd failure for [redacted]");
  const unreachable = connectError(new TypeError("fetch failed"), "claude", [TOKEN]);
  assert.ok(unreachable instanceof CLIError && unreachable.code === "connect_unreachable");
  assert.equal(unreachable.message, "Could not reach OpenComputer: fetch failed");
  const api = connectError(new APIError("x", 413, "payload_too_large"), "codex");
  assert.ok(api instanceof CLIError && api.code === "payload_too_large");
});

// ---------------------------------------------------------------------------
// Reading the token from `claude setup-token` output.

const ESC = "\x1b";

test("token is read from plain output", () => {
  const output = `✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely. You won't be able to see it again.\n`;
  assert.equal(claudeTokenFromTerminalOutput(output), TOKEN);
});

test("token is read through colours, cursor jumps and OSC sequences", () => {
  const output =
    `${ESC}7${ESC}[r${ESC}8${ESC}[?25l${ESC}[?2004h` +
    `${ESC}[2GYour${ESC}[7GOAuth${ESC}[13Gtoken${ESC}[19G(valid${ESC}[26Gfor${ESC}[30G1${ESC}[32Gyear):\r\n\r\n` +
    `${ESC}]8;;https://example.com${ESC}\\${ESC}[2G${ESC}[33m${TOKEN}${ESC}[39m${ESC}]8;;\x07\r\n\r\n` +
    `${ESC}[2G${ESC}[2mStore${ESC}[8Gthis${ESC}[13Gtoken${ESC}[22m\r\n${ESC}[>0q${ESC}[?u`;
  assert.equal(claudeTokenFromTerminalOutput(output), TOKEN);
});

test("a token wrapped across lines is joined, and stops at the blank line", () => {
  const width = 40;
  const pieces: string[] = [];
  for (let i = 0; i < TOKEN.length; i += width) pieces.push(TOKEN.slice(i, i + width));
  const output =
    `Your OAuth token (valid for 1 year):\r\n\r\n` +
    pieces.map((piece) => ` ${ESC}[33m${piece}${ESC}[39m`).join("\r\n") +
    `\r\n\r\n ${ESC}[2mStore this token securely.${ESC}[22m\r\n`;
  assert.equal(claudeTokenFromTerminalOutput(output), TOKEN);

  // Without the blank line, a following word that is not token-shaped ends it.
  assert.equal(
    claudeTokenFromScreen([...pieces, "Store this token securely."]),
    TOKEN,
  );
});

test("a token repainted over an earlier frame is read from the screen, not the stream", () => {
  // Frame 1 draws a line; frame 2 moves back up and writes the token over it,
  // skipping the cells that already show the right character (as diffing
  // renderers do). The raw stream then lacks those characters.
  const first = TOKEN.slice(0, 20) + "x".repeat(TOKEN.length - 20);
  const output =
    `${first}\r\nPaste code here >\r\n` +
    `${ESC}[2A\r${ESC}[21G${TOKEN.slice(20)}\r\n${ESC}[2K\r\n`;
  assert.equal(claudeTokenFromTerminalOutput(output), TOKEN);
  assert.doesNotMatch(output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""), new RegExp(TOKEN));
});

test("the last token on screen wins and partial tokens are ignored", () => {
  assert.equal(claudeTokenFromScreen(["sk-ant-oat01-short"]), undefined);
  const other = TOKEN.replace("AbCd", "WxYz");
  assert.equal(claudeTokenFromScreen([other, "", TOKEN, ""]), TOKEN);
  assert.equal(claudeTokenFromTerminalOutput("Paste code here if prompted >"), undefined);
});

test("screen model handles erase, save/restore and absolute positions", () => {
  assert.deepEqual(renderTerminalScreen("hello world\r\x1b[6G\x1b[K!"), ["hello!"]);
  assert.deepEqual(renderTerminalScreen("ab\x1b7cd\x1b8XY"), ["abXY"]);
  assert.deepEqual(renderTerminalScreen("1\r\n2\r\n3\x1b[1;1HA", 24), ["A", "2", "3"]);
  assert.deepEqual(renderTerminalScreen("abc\r\ndef\x1b[1A\x1b[2K\r\x1b[J"), [""]);
});

test("setup-token runs under script on macOS/Linux, falls back to npx, and runs directly on Windows", () => {
  const all = (name: string) => `/usr/bin/${name}`;
  assert.deepEqual(setupTokenCommand({}, "linux", all), {
    command: "script",
    args: ["-q", "-c", "claude setup-token", "/dev/null"],
    shell: false,
    pty: true,
  });
  assert.deepEqual(setupTokenCommand({}, "darwin", all), {
    command: "script",
    args: ["-q", "/dev/null", "claude", "setup-token"],
    shell: false,
    pty: true,
  });
  assert.deepEqual(
    setupTokenCommand({}, "linux", (name) => (name === "script" ? "/usr/bin/script" : undefined)).args,
    ["-q", "-c", "npx -y @anthropic-ai/claude-code setup-token", "/dev/null"],
  );
  assert.deepEqual(setupTokenCommand({}, "win32", all), {
    command: "claude",
    args: ["setup-token"],
    shell: true,
    pty: false,
  });
  assert.deepEqual(setupTokenCommand({}, "linux", () => undefined), {
    command: "npx",
    args: ["-y", "@anthropic-ai/claude-code", "setup-token"],
    shell: false,
    pty: false,
  });
});

test(
  "a TUI under script is shown and its wrapped token is read",
  { skip: process.platform !== "linux" || !findExecutable("script") },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oc-setup-token-"));
    try {
      const fake = join(directory, "fake-setup-token.mjs");
      // Prints like the TUI: only when stdout is a terminal, wrapped, coloured.
      await writeFile(
        fake,
        `if (!process.stdout.isTTY) process.exit(3);
const t = ${JSON.stringify(TOKEN)};
process.stdout.write("\\x1b[2GYour\\x1b[7GOAuth\\x1b[13Gtoken:\\r\\n\\r\\n");
for (let i = 0; i < t.length; i += 50) process.stdout.write(" \\x1b[33m" + t.slice(i, i + 50) + "\\x1b[39m\\r\\n");
process.stdout.write("\\r\\n \\x1b[2mStore this token securely.\\x1b[22m\\r\\n");
`,
      );
      const display = new PassThrough();
      const shown: Buffer[] = [];
      display.on("data", (chunk: Buffer) => shown.push(chunk));
      const result = await runClaudeSetupToken(display, {
        command: "script",
        args: ["-q", "-c", `${process.execPath} ${fake}`, "/dev/null"],
        shell: false,
        pty: true,
      });
      assert.equal(result.token, TOKEN);
      assert.match(Buffer.concat(shown).toString("utf8"), /Store this token securely/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("findExecutable searches PATH", () => {
  assert.equal(findExecutable("definitely-not-a-binary-oc", { PATH: "/usr/bin" }, "linux"), undefined);
  assert.equal(findExecutable("node", { PATH: process.execPath.replace(/\/node$/, "") }, "linux"), process.execPath);
});

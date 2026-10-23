import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { APIError, type ComputerConnectRequest } from "./api.js";
import { CLIError } from "./errors.js";
import { renderTerminalScreen } from "./terminal-screen.js";

// `opencomputer model connect claude|codex --code <code>` (work 082): connect
// a Claude or ChatGPT subscription to the organization's computer with the
// one-time connect code the dashboard minted. No OpenComputer login: the code
// is the only credential sent. The subscription credential goes straight from
// this process to the connect endpoint; it is never printed or written here.

export type ComputerConnectProvider = "claude" | "codex";

export const DASHBOARD_CONNECT_HINT =
  "Get a connect command from the dashboard (Computer → Agent).";

export interface ModelConnectArgs {
  code?: string;
  tokenStdin: boolean;
}

/** Takes `--code` and `--token-stdin` out of `args`; leaves the rest. */
export function takeModelConnectArgs(
  provider: ComputerConnectProvider,
  args: string[],
  take: { option(name: string): string | undefined; flag(name: string): boolean },
): ModelConnectArgs {
  const code = take.option("--code");
  const tokenStdin = take.flag("--token-stdin");
  if (tokenStdin && provider !== "claude")
    throw new Error("--token-stdin is only for `model connect claude`");
  if (code !== undefined && !/^occ_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(code))
    throw new CLIError(
      "connect_code_invalid",
      "That is not a connect code (it starts with occ_).",
      `Copy the whole command again. ${DASHBOARD_CONNECT_HINT}`,
    );
  if (provider === "claude" && code === undefined)
    throw new CLIError(
      "connect_code_required",
      "`model connect claude` needs a connect code (--code).",
      DASHBOARD_CONNECT_HINT,
    );
  if (code !== undefined && args.length)
    throw new Error(`Unexpected argument: ${args[0]}`);
  return { code, tokenStdin };
}

// ---------------------------------------------------------------------------
// Codex: the Codex CLI's auth.json shape, built from a fresh browser login.

export function codexAuthJson(token: {
  idToken?: string;
  accessToken: string;
  refreshToken?: string;
}): { auth_mode: "chatgpt"; tokens: { id_token: string; access_token: string; refresh_token: string } } {
  if (!token.idToken || !token.refreshToken)
    throw new CLIError(
      "codex_login_incomplete",
      "ChatGPT sign-in did not return the tokens a computer needs.",
      "Run the command again and finish the ChatGPT sign-in in the browser.",
    );
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: token.idToken,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
    },
  };
}

// ---------------------------------------------------------------------------
// Claude: `claude setup-token` and reading its token.

const TOKEN_PREFIX = /sk-ant-oat\d{2}-/;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;
/** A setup token: the prefix and a body far longer than any word wrap leaves. */
const SETUP_TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{32,}$/;

export function isClaudeSetupToken(value: string): boolean {
  return SETUP_TOKEN.test(value);
}

/**
 * The token `claude setup-token` printed, from the lines on screen. The TUI
 * wraps a token longer than the terminal onto following lines, so a token
 * that runs to the end of its line continues with each next line made only of
 * token characters; the blank line the TUI leaves after it ends it. The last
 * token on screen wins.
 */
export function claudeTokenFromScreen(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    const text = lines[index]!.replace(/\s+$/, "");
    const match = TOKEN_PREFIX.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index);
    const run = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]*/.exec(rest)![0];
    let token = run;
    if (run.length === rest.length) {
      for (let next = index + 1; next < lines.length; next++) {
        const continuation = lines[next]!.trim();
        if (!continuation || !TOKEN_CHARS.test(continuation)) break;
        token += continuation;
      }
    }
    if (isClaudeSetupToken(token)) return token;
  }
  return undefined;
}

/** The token in a captured terminal stream (ANSI codes, cursor moves, wraps). */
export function claudeTokenFromTerminalOutput(
  output: string,
  rows?: number,
): string | undefined {
  return (
    claudeTokenFromScreen(renderTerminalScreen(output, rows)) ??
    // A stream the screen model misreads: escape codes stripped as a fallback.
    claudeTokenFromScreen(
      output
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
        .split(/\r?\n|\r/),
    )
  );
}

export interface CommandSpec {
  command: string;
  args: string[];
  /** Run through the shell (Windows `.cmd` shims). */
  shell: boolean;
  /** Runs the program behind a pseudo-terminal recorder whose output we read. */
  pty: boolean;
}

export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const extensions =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const directory of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      try {
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * How to run `claude setup-token` so the person can use its TUI and we can
 * read what it prints. Its TUI draws nothing useful when stdout is a pipe, so
 * on macOS/Linux it runs under `script`, which gives it a real pseudo-terminal
 * (sized like the person's terminal, with their keystrokes passed through)
 * and copies everything it draws to our pipe. Without `script` (Windows) it
 * runs on the person's terminal directly and they paste the token afterwards.
 */
export function setupTokenCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: (name: string) => string | undefined = (name) => findExecutable(name, env, platform),
): CommandSpec {
  const program = find("claude")
    ? ["claude", "setup-token"]
    : ["npx", "-y", "@anthropic-ai/claude-code", "setup-token"];
  if (platform !== "win32" && find("script")) {
    const args =
      platform === "linux"
        ? ["-q", "-c", program.map(shellQuote).join(" "), "/dev/null"]
        : ["-q", "/dev/null", ...program];
    return { command: "script", args, shell: false, pty: true };
  }
  return {
    command: program[0]!,
    args: program.slice(1),
    shell: platform === "win32",
    pty: false,
  };
}

export interface SetupTokenResult {
  /** The token read from the TUI's output, when it was captured. */
  token?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pty: boolean;
}

const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

/** Runs `claude setup-token` interactively and reads the token it prints. */
export function runClaudeSetupToken(
  display: NodeJS.WritableStream,
  spec: CommandSpec = setupTokenCommand(),
): Promise<SetupTokenResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: spec.pty ? ["inherit", "pipe", "inherit"] : "inherit",
      shell: spec.shell,
      env: process.env,
    });
    const decoder = new StringDecoder("utf8");
    let captured = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      display.write(chunk);
      if (captured.length < MAX_CAPTURE_CHARS) captured += decoder.write(chunk);
    });
    // Ctrl-C normally reaches the TUI as a keystroke (the PTY is raw); a
    // signal to this process (kill, terminal closed) must not orphan it.
    // `script` ignores SIGHUP, so it gets SIGTERM, then SIGKILL; either way
    // its PTY closes and the TUI behind it is hung up.
    let interrupted: NodeJS.Signals | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      interrupted ??= signal;
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      escalation.unref();
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) process.on(signal, forward);
    const cleanup = (): void => {
      for (const signal of signals) process.off(signal, forward);
      if (escalation) clearTimeout(escalation);
    };
    child.once("error", (error) => {
      cleanup();
      reject(
        new CLIError(
          "claude_setup_token_unavailable",
          `Could not run \`${[spec.command, ...spec.args].join(" ")}\`: ${error.message}`,
          "Install Claude Code (https://claude.com/claude-code) or Node.js with npx, or pipe a token from `claude setup-token` into this command with --token-stdin.",
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      cleanup();
      captured += decoder.end();
      const token = spec.pty
        ? claudeTokenFromTerminalOutput(captured, process.stdout.rows)
        : undefined;
      captured = "";
      if (interrupted) {
        reject(
          new CLIError(
            "cancelled",
            "Cancelled; nothing was connected.",
            "Run the command again when ready; the connect code still works until it expires.",
          ),
        );
        return;
      }
      resolve({ token, exitCode, signal, pty: spec.pty });
    });
  });
}

// ---------------------------------------------------------------------------
// Request and errors.

/** Removes any secret the request carried from text shown to the person. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  return result.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
}

/** A failed connect as a readable CLI error, without any secret in it. */
export function connectError(
  error: unknown,
  provider: ComputerConnectProvider,
  secrets: readonly string[] = [],
): unknown {
  if (!(error instanceof APIError)) {
    if (error instanceof CLIError || !(error instanceof Error)) return error;
    const reason = redactSecrets(error.message, secrets);
    // fetch rejects with a TypeError when the API cannot be reached, and with
    // a TimeoutError/AbortError when it does not answer in time.
    if (error.name === "TypeError" || error.name === "TimeoutError" || error.name === "AbortError")
      return new CLIError(
        "connect_unreachable",
        `Could not reach OpenComputer: ${reason}`,
        "Check your connection (and --api-url), then run the command again; the code still works until it is used or expires.",
      );
    error.message = reason;
    return error;
  }
  const message = redactSecrets(error.message, secrets);
  const details = { status: error.status, ...(error.code ? { apiCode: error.code } : {}) };
  const plan = provider === "claude" ? "Claude" : "ChatGPT";
  if (error.code === "computer_connect_code_invalid" || error.status === 401)
    return new CLIError(
      "connect_code_invalid",
      "That connect code is not valid. Get a new one from the dashboard.",
      `Codes work once and last 10 minutes. ${DASHBOARD_CONNECT_HINT}`,
      details,
    );
  if (error.status === 404 || error.status === 405)
    return new CLIError(
      "connect_unavailable",
      "This OpenComputer API does not accept connect codes.",
      "Check --api-url / OPENCOMPUTER_API_URL, or use the command the dashboard shows.",
      details,
    );
  if (error.status === 400 || error.status === 413 || error.status === 422)
    return new CLIError(
      error.code ?? "connect_rejected",
      message,
      provider === "claude"
        ? `The code is still good: run the command again to make a new token with the account that has your ${plan} plan.`
        : `The code is still good: run the command again and sign in with the account that has your ${plan} plan.`,
      details,
    );
  return new CLIError(
    error.code ?? "connect_failed",
    message,
    "Retry the command; if the code has expired, get a new one from the dashboard.",
    details,
  );
}

export function connectSuccessMessage(provider: ComputerConnectProvider): string {
  return provider === "claude"
    ? "Connected your Claude plan to your computer. You can close this.\n"
    : "Connected your ChatGPT plan to your computer. You can close this.\n";
}

export async function sendComputerConnect(
  client: { connectComputerAgent(body: ComputerConnectRequest): Promise<unknown> },
  body: ComputerConnectRequest,
): Promise<unknown> {
  const secrets = [body.token ?? "", ...codexSecrets(body.authJson)];
  try {
    return await client.connectComputerAgent(body);
  } catch (error) {
    throw connectError(error, body.provider, secrets);
  }
}

function codexSecrets(authJson: ComputerConnectRequest["authJson"]): string[] {
  if (!authJson || typeof authJson !== "object") return [];
  return Object.values(authJson.tokens).filter((value): value is string => typeof value === "string");
}

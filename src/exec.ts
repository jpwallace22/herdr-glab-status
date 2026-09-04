// Minimal subprocess wrapper. Never throws: spawn failures (e.g. a missing
// binary) are reported in `spawnError`, and a timeout kills the child.

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

export async function runCommand(cmd: string[], opts: RunOptions = {}): Promise<CommandResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, spawnError: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

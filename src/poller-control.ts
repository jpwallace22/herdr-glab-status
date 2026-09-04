import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrSocketPath, pluginRoot, stateDir } from "./env";
import type { Logger } from "./log";

// The poller is a detached `bun bin/poller.ts` process. Its identity lives in
// `<state dir>/poller.json`; a `poller.stop` marker asks it to exit and blocks
// event hooks from restarting it until the next server start or manual refresh.

export interface PollerRecord {
  pid: number;
  socketPath: string | null;
  startedUnixMs: number;
  intervalMs: number | null;
}

export function pollerRecordPath(): string {
  return join(stateDir(), "poller.json");
}

export function pollerLogPath(): string {
  return join(stateDir(), "poller.log");
}

export function stopFilePath(): string {
  return join(stateDir(), "poller.stop");
}

export function readRecord(): PollerRecord | null {
  try {
    const raw = JSON.parse(readFileSync(pollerRecordPath(), "utf8")) as Partial<PollerRecord>;
    if (typeof raw.pid !== "number") return null;
    return {
      pid: raw.pid,
      socketPath: typeof raw.socketPath === "string" ? raw.socketPath : null,
      startedUnixMs: typeof raw.startedUnixMs === "number" ? raw.startedUnixMs : 0,
      intervalMs: typeof raw.intervalMs === "number" ? raw.intervalMs : null,
    };
  } catch {
    return null;
  }
}

export function writeRecord(record: PollerRecord): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pollerRecordPath(), JSON.stringify(record));
}

export function removeRecord(): void {
  try {
    rmSync(pollerRecordPath(), { force: true });
  } catch {
    // nothing to remove
  }
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours; treat as alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function stopRequested(): boolean {
  return existsSync(stopFilePath());
}

export function requestStop(): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stopFilePath(), String(Date.now()));
}

export function clearStopRequest(): void {
  try {
    rmSync(stopFilePath(), { force: true });
  } catch {
    // nothing to remove
  }
}

export type EnsureResult = "running" | "started" | "restarted" | "stopped" | "failed";

// Make sure exactly one poller is running for the current herdr server. A
// live poller bound to a different socket (stale server) is replaced.
export function ensurePoller(log: Logger): EnsureResult {
  if (stopRequested()) {
    log.debug("poller stop marker present; not starting");
    return "stopped";
  }
  const record = readRecord();
  const socket = herdrSocketPath();
  let restarted = false;
  if (record && isAlive(record.pid)) {
    if (record.socketPath === socket || socket === null) return "running";
    log.info(`poller pid ${record.pid} bound to a stale socket; restarting`);
    terminate(record.pid);
    restarted = true;
  }
  const pid = spawnPoller(log);
  if (pid === null) return "failed";
  return restarted ? "restarted" : "started";
}

function spawnPoller(log: Logger): number | null {
  try {
    mkdirSync(stateDir(), { recursive: true });
    const fd = openSync(pollerLogPath(), "a");
    const child = spawn(process.execPath, [join(pluginRoot(), "bin", "poller.ts")], {
      cwd: pluginRoot(),
      env: process.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.unref();
    if (typeof child.pid !== "number") {
      log.error("failed to spawn poller: no pid");
      return null;
    }
    // Claim the record immediately so a second hook racing us sees a live pid.
    writeRecord({ pid: child.pid, socketPath: herdrSocketPath(), startedUnixMs: Date.now(), intervalMs: null });
    log.info(`started poller (pid ${child.pid}, log: ${pollerLogPath()})`);
    return child.pid;
  } catch (err) {
    log.error(`failed to spawn poller: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function terminate(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

// Ask the poller to exit and leave the stop marker in place.
export function stopPoller(log: Logger): boolean {
  requestStop();
  const record = readRecord();
  if (!record || !isAlive(record.pid)) {
    removeRecord();
    log.info("poller was not running");
    return false;
  }
  terminate(record.pid);
  log.info(`sent SIGTERM to poller pid ${record.pid}`);
  return true;
}

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  /** See computeSourceVersion(). Null for records written before this field existed. */
  sourceVersion: number | null;
}

// Bun loads a poller's modules once at process start and never hot-reloads
// them, so an already-running poller keeps executing whatever `src/*.ts` and
// `bin/*.ts` looked like at that moment — a `git pull`, a `herdr plugin link`
// to a different checkout, or any other on-disk edit has zero effect on it
// until it is killed and respawned. This is the signal ensurePoller() uses to
// notice that: the newest mtime across the plugin's own source files, cheap
// to recompute on every call (a couple of dozen small stats, no file reads).
//
// A content hash would also catch an edit that doesn't bump mtime (e.g. a
// `touch`-preserving copy), but that is not how git or an editor behaves in
// practice, and hashing every source file on every focus/create/open event is
// needless work for a case this rare; mtime is the cheaper signal that covers
// the real incident (a stale process outliving a `git pull` or relink).
const SOURCE_DIRS = ["src", "bin"];

export function computeSourceVersion(root: string): number | null {
  try {
    let latest = 0;
    for (const dir of SOURCE_DIRS) {
      const dirPath = join(root, dir);
      for (const name of readdirSync(dirPath)) {
        if (!name.endsWith(".ts")) continue;
        const mtime = statSync(join(dirPath, name)).mtimeMs;
        if (mtime > latest) latest = mtime;
      }
    }
    return latest || null;
  } catch {
    return null;
  }
}

// Pure: does a live poller's record predate the code on disk right now?
// `currentSourceVersion === null` means it could not be computed (e.g. the
// source directories are unreadable) — treat that as "unknown", not stale,
// rather than restarting on every call. A record with no sourceVersion at all
// (written before this field existed) is treated as stale so upgrading the
// plugin itself self-heals on the first ensurePoller() call.
export function isRecordStale(record: PollerRecord, currentSourceVersion: number | null): boolean {
  if (currentSourceVersion === null) return false;
  return record.sourceVersion !== currentSourceVersion;
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
      sourceVersion: typeof raw.sourceVersion === "number" ? raw.sourceVersion : null,
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
// live poller bound to a different socket (stale server) or running code
// that predates what is on disk now (stale checkout) is replaced.
export function ensurePoller(log: Logger): EnsureResult {
  if (stopRequested()) {
    log.debug("poller stop marker present; not starting");
    return "stopped";
  }
  const record = readRecord();
  const socket = herdrSocketPath();
  const sourceVersion = computeSourceVersion(pluginRoot());
  let restarted = false;
  if (record && isAlive(record.pid)) {
    const socketStale = record.socketPath !== socket && socket !== null;
    const codeStale = isRecordStale(record, sourceVersion);
    if (!socketStale && !codeStale) return "running";
    log.info(
      socketStale
        ? `poller pid ${record.pid} bound to a stale socket; restarting`
        : `poller pid ${record.pid} predates the code on disk; restarting`,
    );
    terminate(record.pid);
    restarted = true;
  }
  const pid = spawnPoller(log, sourceVersion);
  if (pid === null) return "failed";
  return restarted ? "restarted" : "started";
}

function spawnPoller(log: Logger, sourceVersion: number | null): number | null {
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
    writeRecord({ pid: child.pid, socketPath: herdrSocketPath(), startedUnixMs: Date.now(), intervalMs: null, sourceVersion });
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

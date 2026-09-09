#!/usr/bin/env bun
// Long-lived background poller. Spawned detached by bin/startup.ts (and by any
// hook that finds it dead). Refreshes every workspace's $mr token on a period,
// and exits when herdr goes away, when a stop is requested, or when another
// poller has taken over the state record.
//
// Output is not captured by herdr; it goes to <state dir>/poller.log.

import { existsSync } from "node:fs";
import { refreshBoard } from "../src/board";
import { loadConfig } from "../src/config";
import { configDir, herdrSocketPath, stateDir } from "../src/env";
import { createGlabClient } from "../src/glab";
import { listWorkspaces } from "../src/herdr";
import { fileLogger } from "../src/log";
import {
  isAlive,
  pollerLogPath,
  readRecord,
  removeRecord,
  stopRequested,
  writeRecord,
} from "../src/poller-control";
import { refreshAll, shouldRetrySoon } from "../src/refresh";

const HERDR_FAILURE_LIMIT = 3;
const SLEEP_SLICE_MS = 10_000;
// After a cycle that kept any tokens (transient glab trouble) or couldn't
// reach herdr at all, retry soon instead of waiting a full poll interval, so
// a laptop that wakes mid-outage recovers within seconds, not minutes.
const RETRY_INTERVAL_MS = 30_000;

const log = fileLogger(pollerLogPath(), loadConfig(configDir()).debug);

function shutdown(reason: string, code = 0): never {
  log.info(`stopping: ${reason}`);
  const record = readRecord();
  if (record && record.pid === process.pid) removeRecord();
  process.exit(code);
}

// Interruptible sleep: wake early if a stop is requested or herdr's socket
// disappears, so the poller does not linger for a full interval.
async function sleepWatching(totalMs: number): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await Bun.sleep(Math.min(SLEEP_SLICE_MS, remaining));
    checkExitConditions();
  }
}

function checkExitConditions(): void {
  if (stopRequested()) shutdown("stop requested");
  const socket = herdrSocketPath();
  if (socket && !existsSync(socket)) shutdown("herdr socket is gone");
  const record = readRecord();
  if (!record || record.pid !== process.pid) shutdown("superseded by another poller");
}

async function main(): Promise<void> {
  const existing = readRecord();
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    log.info(`another poller (pid ${existing.pid}) is already running; exiting`);
    process.exit(0);
  }
  if (stopRequested()) {
    log.info("stop marker present at startup; exiting");
    process.exit(0);
  }

  let cfg = loadConfig(configDir(), (m) => log.warn(m));
  writeRecord({ pid: process.pid, socketPath: herdrSocketPath(), startedUnixMs: Date.now(), intervalMs: cfg.pollIntervalMs });
  log.info(
    `poller started (pid ${process.pid}, every ${cfg.pollIntervalMs / 1000}s, state: ${stateDir()}, socket: ${herdrSocketPath() ?? "default"})`,
  );

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => shutdown(signal));
  }

  let herdrFailures = 0;
  let abortLogged = false;

  for (;;) {
    checkExitConditions();
    // Re-read config each cycle so interval/host edits apply without a restart.
    cfg = loadConfig(configDir(), (m) => log.warn(m));

    const started = Date.now();
    const summary = await refreshAll(cfg, {
      ...log,
      // The abort message is logged once per outage below, not per cycle.
      error: (m) => {
        if (!abortLogged) log.error(m);
      },
    });

    if (summary.herdrUnavailable) {
      herdrFailures++;
      if (herdrFailures >= HERDR_FAILURE_LIMIT) shutdown(`herdr unreachable ${herdrFailures} times in a row`);
    } else {
      herdrFailures = 0;
    }

    if (summary.aborted) {
      abortLogged = true;
    } else if (abortLogged) {
      abortLogged = false;
      log.info("glab is working again");
    }

    // Rich pick-mr board data (title, comments, approvals -- fields the
    // sidebar's own $mr token never needed) is refreshed on the same
    // cycle, but only when the token refresh above actually had usable
    // glab access; there's nothing to gain re-deriving the same failure.
    if (!summary.herdrUnavailable && !summary.aborted) {
      try {
        const workspaces = await listWorkspaces();
        if (workspaces) await refreshBoard(workspaces, cfg, log, createGlabClient(cfg));
      } catch (err) {
        log.warn(`board refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const retrying = shouldRetrySoon(summary);
    const sleepMs = retrying ? RETRY_INTERVAL_MS : cfg.pollIntervalMs;

    // One line per cycle (~300/day at the default interval; the log rotates).
    log.info(
      `cycle: ${summary.reported} reported, ${summary.cleared} cleared, ${summary.kept} kept, ${summary.failed} failed in ${Date.now() - started}ms` +
        (retrying ? ` (retrying in ${sleepMs / 1000}s)` : ""),
    );

    const record = readRecord();
    if (record && record.pid === process.pid && record.intervalMs !== cfg.pollIntervalMs) {
      writeRecord({ ...record, intervalMs: cfg.pollIntervalMs });
    }

    await sleepWatching(sleepMs);
  }
}

main().catch((err) => {
  log.error(`poller crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  shutdown("crash", 1);
});

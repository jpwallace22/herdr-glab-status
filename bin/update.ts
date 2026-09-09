#!/usr/bin/env bun
// Entry point for both the event hooks and the `refresh` action.
//
// - Action (HERDR_PLUGIN_ACTION_ID set): refresh every workspace now, ignoring
//   the throttle, and make sure the poller is running.
// - Event: refresh only the affected workspace, at most once per throttle
//   window, and make sure the poller is running (so linking the plugin into a
//   live server starts polling without a restart).
//
// Both paths also update the pick-mr board cache (src/board.ts) for
// whatever they just refreshed, not just the sidebar's $mr token -- without
// this, the board only catches up on the poller's own cycle (up to
// poll_interval_seconds later), so it can visibly lag behind a sidebar that
// just updated on a focus/create event. Both reuse the same
// inspectWorkspace decision refreshWorkspaces already computed for the
// token, rather than checking each workspace a second time.
//
// Never fail loudly: a noisy hook would spam the plugin log on every focus
// change. Problems go to stderr, which `herdr plugin log list` shows.

import { refreshTokensAndBoard, updateBoardCacheFromDecision } from "../src/board";
import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { resolveEventWorkspaceId } from "../src/events";
import { createGlabClient } from "../src/glab";
import { getWorkspace } from "../src/herdr";
import { hookLogger } from "../src/log";
import { clearStopRequest, ensurePoller } from "../src/poller-control";
import { refreshWorkspaces, type Decision } from "../src/refresh";
import { lastCheckMs, throttleElapsed } from "../src/throttle";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

async function main(): Promise<void> {
  const isAction = Boolean(process.env.HERDR_PLUGIN_ACTION_ID);

  if (isAction) {
    // An explicit refresh also means "I want this running".
    clearStopRequest();
    ensurePoller(log);
    const summary = await refreshTokensAndBoard(cfg, log);
    log.debug(`refresh: ${summary.reported} reported, ${summary.cleared} cleared, ${summary.kept} kept, ${summary.failed} failed`);
    return;
  }

  ensurePoller(log);

  const workspaceId = resolveEventWorkspaceId(process.env);
  if (!workspaceId) {
    log.debug(`event ${process.env.HERDR_PLUGIN_EVENT ?? "?"} carried no workspace id`);
    return;
  }

  const now = Date.now();
  if (!throttleElapsed(lastCheckMs(workspaceId), now, cfg.throttleMs)) {
    log.debug(`${workspaceId}: throttled`);
    return;
  }

  const ws = await getWorkspace(workspaceId);
  if (!ws) {
    log.debug(`${workspaceId}: no checkout path; nothing to do`);
    return;
  }

  const glab = createGlabClient(cfg);
  let decision: Decision | null = null;
  const summary = await refreshWorkspaces([ws], cfg, log, glab, (_, d) => {
    decision = d;
  });

  // Keeps pick-mr's board in step with the sidebar token this just
  // refreshed, instead of only catching up on the next full poller cycle
  // (up to poll_interval_seconds later) or a manual refresh.
  if (!summary.aborted && decision) {
    try {
      await updateBoardCacheFromDecision(ws, decision, glab);
    } catch (err) {
      log.warn(`${ws.label}: board update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(`[glab-status] update failed: ${err instanceof Error ? err.message : String(err)}`);
});

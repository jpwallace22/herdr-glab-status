#!/usr/bin/env bun
// Entry point for both the event hooks and the `refresh` action.
//
// - Action (HERDR_PLUGIN_ACTION_ID set): refresh every workspace now, ignoring
//   the throttle, and make sure the poller is running.
// - Event: refresh only the affected workspace, at most once per throttle
//   window, and make sure the poller is running (so linking the plugin into a
//   live server starts polling without a restart).
//
// Never fail loudly: a noisy hook would spam the plugin log on every focus
// change. Problems go to stderr, which `herdr plugin log list` shows.

import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { resolveEventWorkspaceId } from "../src/events";
import { getWorkspace } from "../src/herdr";
import { hookLogger } from "../src/log";
import { clearStopRequest, ensurePoller } from "../src/poller-control";
import { refreshAll, refreshWorkspaces } from "../src/refresh";
import { lastCheckMs, throttleElapsed } from "../src/throttle";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

async function main(): Promise<void> {
  const isAction = Boolean(process.env.HERDR_PLUGIN_ACTION_ID);

  if (isAction) {
    // An explicit refresh also means "I want this running".
    clearStopRequest();
    ensurePoller(log);
    const summary = await refreshAll(cfg, log);
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
  await refreshWorkspaces([ws], cfg, log);
}

main().catch((err) => {
  console.error(`[glab-status] update failed: ${err instanceof Error ? err.message : String(err)}`);
});

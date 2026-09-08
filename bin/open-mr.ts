#!/usr/bin/env bun
// `open-mr` action: open the current workspace's merge request in the
// browser, focusing an already-open tab for it instead of piling up
// duplicates when one exists (see src/browser.ts for the how and the
// platform/browser limits). Falls back to a herdr notification with the URL
// when no browser can be launched at all (e.g. over SSH).

import { focusOrOpenTab } from "../src/browser";
import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { resolveEventWorkspaceId } from "../src/events";
import { runCommand } from "../src/exec";
import { briefError, createGlabClient, resolveGlabPath } from "../src/glab";
import { getWorkspace, showNotification } from "../src/herdr";
import { parseMrView } from "../src/label";
import { hookLogger } from "../src/log";
import { mrRefArg, resolveMrRef } from "../src/resolve";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

async function main(): Promise<void> {
  const workspaceId = resolveEventWorkspaceId(process.env);
  if (!workspaceId) {
    log.warn("open-mr needs a workspace context");
    return;
  }
  const ws = await getWorkspace(workspaceId);
  if (!ws) {
    log.info("current workspace has no git checkout");
    return;
  }
  const glab = createGlabClient(cfg);
  const branch = await glab.currentBranch(ws.checkoutPath);
  if (!branch) {
    log.info(`${ws.label}: no current branch`);
    return;
  }
  const ref = mrRefArg(resolveMrRef(branch));

  // Fetch the MR first (rather than after a failed `--web`) so its URL is
  // available up front for tab reuse.
  const view = await glab.mrView(ref, ws.checkoutPath);
  if (!view.ok) {
    log.info(`${ws.label}: no merge request for ${ref} (${briefError(view)})`);
    return;
  }
  const mr = parseMrView(view.stdout);
  if (!mr || !mr.webUrl) {
    log.info(`${ws.label}: glab mr view returned unexpected output for ${ref}`);
    return;
  }

  if (await focusOrOpenTab(cfg, mr.webUrl)) return;

  const env: Record<string, string> = { NO_COLOR: "1" };
  if (cfg.host) env.GITLAB_HOST = cfg.host;
  const opened = await runCommand([resolveGlabPath(cfg), "mr", "view", ref, "--web"], { cwd: ws.checkoutPath, env });
  if (opened.ok) return;

  await showNotification(`MR !${mr.iid}`, mr.webUrl);
  log.info(`could not open a browser; MR URL: ${mr.webUrl}`);
}

main().catch((err) => {
  console.error(`[glab-status] open-mr failed: ${err instanceof Error ? err.message : String(err)}`);
});

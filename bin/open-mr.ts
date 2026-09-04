#!/usr/bin/env bun
// `open-mr` action: open the current workspace's merge request in the browser.
// Falls back to a herdr notification with the URL when no browser can be
// launched (e.g. over SSH).

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

  const env: Record<string, string> = { NO_COLOR: "1" };
  if (cfg.host) env.GITLAB_HOST = cfg.host;
  const opened = await runCommand([resolveGlabPath(cfg), "mr", "view", ref, "--web"], { cwd: ws.checkoutPath, env });
  if (opened.ok) return;

  const view = await glab.mrView(ref, ws.checkoutPath);
  const mr = view.ok ? parseMrView(view.stdout) : null;
  if (!mr) {
    log.info(`${ws.label}: no merge request for ${ref} (${briefError(opened)})`);
    return;
  }
  if (mr.webUrl) {
    await showNotification(`MR !${mr.iid}`, mr.webUrl);
    log.info(`could not open a browser; MR URL: ${mr.webUrl}`);
  }
}

main().catch((err) => {
  console.error(`[glab-status] open-mr failed: ${err instanceof Error ? err.message : String(err)}`);
});

#!/usr/bin/env bun
// `pick-mr`: fzf-pick one of your open GitLab MRs across every workspace
// herdr tracks, then open it in the browser.
//
// Listing is instant and does no glab/network work at all: it reads the
// `$mr` token herdr already has cached per workspace (src/picker.ts), the
// same token already sitting in the sidebar. Only opening the one you pick
// does a live glab call (reusing open-mr.ts's tab-reuse + `glab mr view
// --web` + notification fallback chain) -- and only for that one MR.
//
// fzf needs a real terminal: it reads the row list from stdin but drives its
// own UI straight over /dev/tty. This runs as the "picker" plugin pane
// declared in herdr-plugin.toml (opened by bin/open-pick-mr.ts's `pick-mr`
// action, or directly with `bun bin/pick-mr.ts` in any pane) rather than as
// a plugin action's own command, which has no real terminal to give it.

import { focusOrOpenTab } from "../src/browser";
import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { runCommand } from "../src/exec";
import { briefError, createGlabClient, resolveGlabPath } from "../src/glab";
import { listWorkspaces, showNotification } from "../src/herdr";
import { parseMrView } from "../src/label";
import { hookLogger } from "../src/log";
import { collectRows, formatRows, sortRows } from "../src/picker";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

// Feed `lines` to fzf on stdin and return the chosen line, or null if
// cancelled (Esc/Ctrl-C) or fzf itself couldn't run (e.g. no /dev/tty).
async function pick(header: string, lines: string[]): Promise<string | null> {
  // Pass the row list as stdin content directly rather than a "pipe" +
  // FileSink.write()/.end(): fzf still opens /dev/tty itself for the actual
  // interactive UI, so this doesn't cost us anything and sidesteps the
  // stdin-is-a-FileSink-or-an-fd union bun-types gives "pipe".
  const input = new TextEncoder().encode(lines.join("\n") + "\n");
  let proc;
  try {
    proc = Bun.spawn(["fzf", "--ansi", "--delimiter", "\t", "--with-nth", "2", "--header", header, "--prompt", "MR> "], {
      stdin: input,
      stdout: "pipe",
      stderr: "inherit",
    });
  } catch (err) {
    console.error(`[glab-status] could not start fzf: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const [output, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
  if (exitCode !== 0 || !output.trim()) return null;
  return output;
}

async function main(): Promise<void> {
  if (!Bun.which("fzf")) {
    console.error("[glab-status] pick-mr needs fzf on PATH (e.g. `brew install fzf`); not found.");
    process.exitCode = 1;
    return;
  }

  const workspaces = await listWorkspaces();
  if (workspaces === null) {
    console.error("[glab-status] could not list workspaces (is the herdr server running?)");
    process.exitCode = 1;
    return;
  }

  const rows = sortRows(collectRows(workspaces));
  if (rows.length === 0) {
    console.error("[glab-status] no open MRs in the sidebar right now (nothing cached, or none tracked)");
    return;
  }

  const { header, lines } = formatRows(rows);
  const selection = await pick(header, lines);
  if (!selection) return; // cancelled, or fzf couldn't run

  const index = Number(selection.split("\t", 1)[0]);
  const row = rows[index];
  if (!row) return;

  const iid = /^!(\d+)/.exec(row.token)?.[1];
  if (!iid) {
    console.error(`[glab-status] could not parse an MR number out of "${row.token}"`);
    return;
  }

  // Only now -- for the one MR the user actually picked -- do we touch glab
  // at all, to resolve its URL (for tab-reuse) before opening it.
  const glab = createGlabClient(cfg);
  const view = await glab.mrView(iid, row.workspace.checkoutPath);
  const mr = view.ok ? parseMrView(view.stdout) : null;

  const env: Record<string, string> = { NO_COLOR: "1" };
  if (cfg.host) env.GITLAB_HOST = cfg.host;

  if (mr?.webUrl && (await focusOrOpenTab(cfg, mr.webUrl, { log }))) return;

  const opened = await runCommand([resolveGlabPath(cfg), "mr", "view", iid, "--web"], {
    cwd: row.workspace.checkoutPath,
    env,
  });
  if (opened.ok) return;
  log.debug(`glab mr view --web failed: ${briefError(opened)}`);

  if (mr?.webUrl) {
    await showNotification(`MR !${iid}`, mr.webUrl);
    console.error(`[glab-status] could not open a browser; MR URL: ${mr.webUrl}`);
  } else {
    console.error(`[glab-status] could not open !${iid} (${row.repo}) in a browser`);
  }
}

main().catch((err) => {
  console.error(`[glab-status] pick-mr failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

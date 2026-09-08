#!/usr/bin/env bun
// `pick-mr`: fzf-pick one of your open GitLab MRs across every workspace
// herdr tracks, then open it in the browser (reusing open-mr.ts's tab-reuse
// + `glab mr view --web` + notification fallback chain).
//
// fzf needs a real terminal: it reads the row list from stdin but drives its
// own UI straight over /dev/tty, so this only works run from an actual pane
// (`bun bin/pick-mr.ts`), not from something herdr invokes headlessly. See
// README's "Picking an MR" section.

import { focusOrOpenTab } from "../src/browser";
import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { runCommand } from "../src/exec";
import { briefError, createGlabClient, resolveGlabPath } from "../src/glab";
import { listWorkspaces, showNotification } from "../src/herdr";
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

  const glab = createGlabClient(cfg);
  const { rows, aborted } = await collectRows(workspaces, cfg, log, glab);
  if (aborted) console.error("[glab-status] stopped early: glab is not usable (see the message above)");
  if (rows.length === 0) {
    console.error("[glab-status] no open merge requests found across tracked workspaces");
    return;
  }

  const sorted = sortRows(rows);
  const { header, lines } = formatRows(sorted);
  const selection = await pick(header, lines);
  if (!selection) return; // cancelled, or fzf couldn't run

  const index = Number(selection.split("\t", 1)[0]);
  const row = sorted[index];
  if (!row) return;
  if (!row.webUrl) {
    console.error(`[glab-status] ${row.repo} !${row.iid} has no web URL`);
    return;
  }

  if (await focusOrOpenTab(cfg, row.webUrl, { log })) return;

  const env: Record<string, string> = { NO_COLOR: "1" };
  if (cfg.host) env.GITLAB_HOST = cfg.host;
  const opened = await runCommand([resolveGlabPath(cfg), "mr", "view", String(row.iid), "--web"], {
    cwd: row.workspace.checkoutPath,
    env,
  });
  if (opened.ok) return;
  if (!opened.ok) log.debug(`glab mr view --web failed: ${briefError(opened)}`);

  await showNotification(`MR !${row.iid}`, row.webUrl);
  console.error(`[glab-status] could not open a browser; MR URL: ${row.webUrl}`);
}

main().catch((err) => {
  console.error(`[glab-status] pick-mr failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

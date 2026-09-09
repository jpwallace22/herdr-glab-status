#!/usr/bin/env bun
// `pick-mr`: fzf-pick one of your open GitLab MRs across every workspace
// herdr tracks. Reads the board that src/board.ts computes and caches (via
// the background poller, or an explicit refresh) -- no glab/network call
// at all to build the initial list, so it's instant.
//
// Enter jumps to that MR's workspace (`herdr workspace focus`); o opens it
// in the browser instead, reusing open-mr.ts's tab-reuse + `glab mr view
// --web` + notification fallback chain; r refreshes the cached data; d/m/s
// toggle drafts/mine/scope filters (bin/board-rows.ts does the actual
// toggling + re-read + re-format for all of r/d/m/s, via fzf's own
// `reload` binding, so none of them need to leave the picker). The key
// legend is a `--footer` (needs fzf 0.63+), pinned to the bottom, separate
// from the column header. Layout is top-down (`--layout reverse`); the
// right-hand preview pane shows the *workspace* the highlighted row lives
// in -- its live herdr state (agent/panes/tabs/focus), not a restatement of
// the row's own MR columns -- via bin/board-rows.ts --preview.
//
// This runs as the "picker" plugin pane declared in herdr-plugin.toml
// (opened by bin/open-pick-mr.ts's `pick-mr` action, or directly with
// `bun bin/pick-mr.ts` in any pane) rather than as a plugin action's own
// command, because fzf needs a real terminal and an action's command
// doesn't get one.

import type { BoardRow } from "../src/board";
import { readBoardCache, readCachedUsername } from "../src/board";
import { readFilters } from "../src/board-filters";
import { focusOrOpenTab } from "../src/browser";
import { loadConfig } from "../src/config";
import { configDir, pluginRoot } from "../src/env";
import { runCommand } from "../src/exec";
import { briefError, resolveGlabPath } from "../src/glab";
import { runHerdr, showNotification } from "../src/herdr";
import { hookLogger } from "../src/log";
import { applyFilters, formatRows, KEY_LEGEND, sortRows } from "../src/picker";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

const BOARD_ROWS = ["bun", `${pluginRoot()}/bin/board-rows.ts`].join(" ");

// Feed `lines` to fzf on stdin and return its raw stdout (the `--expect`ed
// key on the first line, the selected row on the second), or null if
// cancelled (Esc/Ctrl-C) or fzf itself couldn't run (e.g. no /dev/tty).
async function pick(header: string, lines: string[]): Promise<string | null> {
  const input = new TextEncoder().encode(lines.join("\n") + "\n");
  let proc;
  try {
    proc = Bun.spawn(
      [
        "fzf",
        "--ansi",
        "--layout",
        "reverse", // top-down: prompt+header at top, list growing down
        "--delimiter",
        "\t",
        "--with-nth",
        "2",
        "--header",
        header,
        "--footer",
        KEY_LEGEND,
        "--prompt",
        "MR> ",
        "--expect",
        "enter,o",
        "--bind",
        `r:reload(${BOARD_ROWS} --refresh)`,
        "--bind",
        `d:reload(${BOARD_ROWS} --toggle-drafts)`,
        "--bind",
        `m:reload(${BOARD_ROWS} --toggle-mine)`,
        "--bind",
        `s:reload(${BOARD_ROWS} --toggle-scope)`,
        // Right-hand pane: which workspace the highlighted row lives in,
        // plus the MR detail the compact row has no room for.
        "--preview",
        `${BOARD_ROWS} --preview {1}`,
        "--preview-window",
        "right,45%,border-left",
      ],
      { stdin: input, stdout: "pipe", stderr: "inherit" },
    );
  } catch (err) {
    console.error(`[glab-status] could not start fzf: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const [output, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
  if (exitCode !== 0 || !output.trim()) return null;
  return output;
}

// Open a row's MR in the browser: tab-reuse against the already-cached
// webUrl first (no glab call needed for that), then `glab mr view --web`,
// then a notification with the URL as a last resort. Mirrors open-mr.ts.
async function openInBrowser(row: BoardRow): Promise<void> {
  if (row.webUrl && (await focusOrOpenTab(cfg, row.webUrl, { log }))) return;

  const env: Record<string, string> = { NO_COLOR: "1" };
  if (cfg.host) env.GITLAB_HOST = cfg.host;
  const opened = await runCommand([resolveGlabPath(cfg), "mr", "view", String(row.iid), "--web"], {
    cwd: row.checkoutPath,
    env,
  });
  if (opened.ok) return;
  log.debug(`glab mr view --web failed: ${briefError(opened)}`);

  if (row.webUrl) {
    await showNotification(`MR !${row.iid}`, row.webUrl);
    console.error(`[glab-status] could not open a browser; MR URL: ${row.webUrl}`);
  } else {
    console.error(`[glab-status] could not open !${row.iid} (${row.repo}) in a browser`);
  }
}

async function main(): Promise<void> {
  if (!Bun.which("fzf")) {
    console.error("[glab-status] pick-mr needs fzf on PATH (e.g. `brew install fzf`); not found.");
    process.exitCode = 1;
    return;
  }

  const cached = readBoardCache();
  if (cached.length === 0) {
    console.error(
      "[glab-status] no cached MR data yet -- run `herdr plugin action invoke refresh --plugin glab-status`, " +
        "or wait for the poller's first cycle",
    );
    return;
  }

  const rows = sortRows(applyFilters(cached, readFilters(), readCachedUsername()));
  if (rows.length === 0) {
    console.error("[glab-status] no open MRs match the current filters (press d/m/s to toggle them)");
    return;
  }

  const { header, lines } = formatRows(rows);
  const result = await pick(header, lines);
  if (!result) return; // cancelled, or fzf couldn't run

  const [key, selection] = result.split("\n", 2);
  const index = Number((selection ?? "").split("\t", 1)[0]);
  const row = rows[index];
  if (!row) return;

  if (key === "o") {
    await openInBrowser(row);
    return;
  }

  const focusResult = await runHerdr(["workspace", "focus", row.workspaceId]);
  if (!focusResult.ok) {
    console.error(`[glab-status] could not focus ${row.repo}: ${briefError(focusResult)}`);
  }
}

main().catch((err) => {
  console.error(`[glab-status] pick-mr failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

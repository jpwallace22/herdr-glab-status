#!/usr/bin/env bun
// Shared data step for pick-mr's fzf UI: optionally toggles a filter and/or
// does a live refresh, then reads the cached board, applies the s/d/m
// filter state, sorts, and prints formatted lines to stdout (one per row,
// `<index>\t<columns>`, see src/picker.ts's formatRows). Used both for the
// picker's initial list and, via fzf's `--bind key:reload(...)`, to
// refresh or re-filter it without leaving the picker -- see bin/pick-mr.ts.
//
// Flags: --refresh, --toggle-drafts, --toggle-mine, --toggle-scope (any
// combination), or --preview <index> on its own (fzf's right-hand preview
// for the row currently highlighted -- see bin/pick-mr.ts's `--preview`
// binding). --preview does a few live local herdr calls (workspace state,
// which pane if any has an agent, that pane's scrollback) -- the one part
// of this whole picker that isn't purely reading a cache, because that
// state is inherently live, not something a poller cycle could usefully
// snapshot. None of it touches glab.
//
// Filter state (s/d/m) lives in a file whose path bin/pick-mr.ts generates
// fresh per picker session and passes down via GLAB_STATUS_FILTERS_PATH
// (inherited by every reload/preview command fzf spawns, since they're
// children of the same process) -- deliberately not a fixed, permanently
// shared path: filters reset every time you open the picker, they don't
// persist across sessions. Falls back to src/board-filters.ts's own
// default path when unset, for standalone `bun bin/board-rows.ts` use.

import { toggleDrafts, toggleMine, toggleScope, readFilters } from "../src/board-filters";
import { readBoardCache, readCachedUsername, refreshBoard } from "../src/board";
import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { createGlabClient } from "../src/glab";
import { getWorkspace, getWorkspaceStatus, listAgents, listWorkspaces, readAgent } from "../src/herdr";
import { hookLogger } from "../src/log";
import { applyFilters, formatPreview, formatRows, sortRows } from "../src/picker";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

// Generous scrollback: the preview pane is usually the full height of a
// large overlay, and this is just a local read, not a network call.
const PREVIEW_SCROLLBACK_LINES = 300;

// undefined (not set) falls back to src/board-filters.ts's own shared
// default path -- only reachable via standalone use, not through the
// picker (bin/pick-mr.ts always sets this).
const filtersPath = process.env.GLAB_STATUS_FILTERS_PATH || undefined;

// The repo of the workspace this pane belongs to, for "scope" -- plugin
// panes get HERDR_WORKSPACE_ID the same as actions do.
async function currentRepoName(): Promise<string | null> {
  const id = process.env.HERDR_WORKSPACE_ID;
  if (!id) return null;
  const ws = await getWorkspace(id);
  return ws?.repoName ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);

  // Preview is read-only and never combined with the toggle/refresh flags
  // (fzf calls it on every highlight change, independent of a reload).
  const previewFlagIndex = argv.indexOf("--preview");
  if (previewFlagIndex >= 0) {
    const index = Number(argv[previewFlagIndex + 1]);
    const filters = readFilters(filtersPath);
    const rows = sortRows(applyFilters(readBoardCache(), filters, readCachedUsername()));
    const row = rows[index];
    if (!row) {
      console.log("(no row selected)");
      return;
    }
    console.log(formatPreview(row, await getWorkspaceStatus(row.workspaceId)));

    // The actual workspace, not just facts about it: whichever pane in it
    // has a detected agent, live -- same source and intent as sessionizer's
    // own agent-view preview.
    const agents = await listAgents();
    const agent = agents?.find((a) => a.workspaceId === row.workspaceId) ?? null;
    const content = agent ? await readAgent(agent.paneId, PREVIEW_SCROLLBACK_LINES) : null;
    console.log("");
    if (content?.trim()) {
      console.log(content.trimEnd());
    } else {
      console.log(agent ? "(pane has no scrollback yet)" : "(no agent detected in this workspace)");
    }
    return;
  }

  if (args.has("--toggle-drafts")) toggleDrafts(filtersPath);
  if (args.has("--toggle-mine")) toggleMine(filtersPath);
  if (args.has("--toggle-scope")) toggleScope(await currentRepoName(), filtersPath);

  let rows;
  if (args.has("--refresh")) {
    const workspaces = await listWorkspaces();
    if (workspaces === null) {
      console.error("[glab-status] could not list workspaces (is the herdr server running?)");
      process.exitCode = 1;
      return;
    }
    rows = await refreshBoard(workspaces, cfg, log, createGlabClient(cfg));
  } else {
    rows = readBoardCache();
  }

  const filters = readFilters(filtersPath);
  const username = readCachedUsername();
  const filtered = sortRows(applyFilters(rows, filters, username));
  const { lines } = formatRows(filtered);
  for (const line of lines) console.log(line);
}

main().catch((err) => {
  console.error(`[glab-status] board-rows failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

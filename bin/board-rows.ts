#!/usr/bin/env bun
// Shared data step for pick-mr's fzf UI: optionally toggles a filter and/or
// does a live refresh, then reads the cached board, applies the s/d/m
// filter state, sorts, and prints formatted lines to stdout (one per row,
// `<index>\t<columns>`, see src/picker.ts's formatRows). Used both for the
// picker's initial list and, via fzf's `--bind key:reload(...)`, to
// refresh or re-filter it without leaving the picker -- see bin/pick-mr.ts.
//
// Flags (any combination): --refresh, --toggle-drafts, --toggle-mine,
// --toggle-scope.

import { toggleDrafts, toggleMine, toggleScope, readFilters } from "../src/board-filters";
import { readBoardCache, readCachedUsername, refreshBoard } from "../src/board";
import { loadConfig } from "../src/config";
import { configDir } from "../src/env";
import { createGlabClient } from "../src/glab";
import { getWorkspace, listWorkspaces } from "../src/herdr";
import { hookLogger } from "../src/log";
import { applyFilters, formatRows, sortRows } from "../src/picker";

const cfg = loadConfig(configDir(), (m) => console.error(`[glab-status] config: ${m}`));
const log = hookLogger(cfg.debug);

// The repo of the workspace this pane belongs to, for "scope" -- plugin
// panes get HERDR_WORKSPACE_ID the same as actions do.
async function currentRepoName(): Promise<string | null> {
  const id = process.env.HERDR_WORKSPACE_ID;
  if (!id) return null;
  const ws = await getWorkspace(id);
  return ws?.repoName ?? null;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--toggle-drafts")) toggleDrafts();
  if (args.has("--toggle-mine")) toggleMine();
  if (args.has("--toggle-scope")) toggleScope(await currentRepoName());

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

  const filters = readFilters();
  const username = readCachedUsername();
  const filtered = sortRows(applyFilters(rows, filters, username));
  const { lines } = formatRows(filtered);
  for (const line of lines) console.log(line);
}

main().catch((err) => {
  console.error(`[glab-status] board-rows failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

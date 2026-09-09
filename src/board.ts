// Rich per-MR data for the pick-mr board: computed by the background poller
// (and by an explicit on-demand refresh, see bin/board-rows.ts) and cached
// to disk, so the picker itself never makes a live glab call to build its
// list -- it just reads this file. This is what makes pick-mr instant: all
// the network work happens on the poller's own schedule (or when you
// explicitly ask for a refresh), never at picker-open time.
//
// One row per workspace with an open (not merged/closed) MR -- same scope
// as the sidebar's own $mr token, just with the richer fields (title,
// comments, approvals) the token's compact grammar doesn't carry. Reuses
// inspectWorkspace() from refresh.ts, so it shares that function's branch →
// MR resolution and transient-failure handling instead of a second,
// parallel implementation of it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Approvals } from "./approvals";
import { parseApprovals } from "./approvals";
import type { Config } from "./config";
import { stateDir } from "./env";
import type { GlabClient } from "./glab";
import type { Workspace } from "./herdr";
import type { Logger } from "./log";
import { inspectWorkspace } from "./refresh";

export interface BoardRow {
  workspaceId: string;
  checkoutPath: string;
  repo: string;
  repoName: string | null;
  iid: number;
  title: string;
  draft: boolean;
  pipelineStatus: string | null;
  unresolved: number | null;
  comments: number | null;
  approvals: Approvals | null;
  webUrl: string | null;
  branch: string;
  createdAt: string | null;
  authorUsername: string | null;
}

export function boardCachePath(dir: string = stateDir()): string {
  return join(dir, "mr-board.json");
}

export function readBoardCache(path: string = boardCachePath()): BoardRow[] {
  if (!existsSync(path)) return [];
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? (data as BoardRow[]) : [];
  } catch {
    return [];
  }
}

export function writeBoardCache(rows: BoardRow[], path: string = boardCachePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows));
}

// The authenticated glab username is cached alongside the board (refreshed
// whenever the board is) rather than looked up live on every keypress, so
// the picker's "mine" filter stays instant like everything else it reads.
export function currentUserPath(dir: string = stateDir()): string {
  return join(dir, "mr-board-user.json");
}

export function readCachedUsername(path: string = currentUserPath()): string | null {
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    const username = data && typeof data === "object" ? (data as { username?: unknown }).username : undefined;
    return typeof username === "string" && username !== "" ? username : null;
  } catch {
    return null;
  }
}

export function writeCachedUsername(username: string | null, path: string = currentUserPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ username }));
}

// Fetch approvals for one MR. Best-effort: any failure (including a
// GlabClient without the optional `approvals` method) yields null rather
// than dropping the row, since APPR is one field among several.
async function fetchApprovals(glab: GlabClient, projectId: number | null, iid: number, cwd: string): Promise<Approvals | null> {
  if (!glab.approvals) return null;
  const result = await glab.approvals(projectId, iid, cwd);
  if (!result.ok) return null;
  return parseApprovals(result.stdout);
}

// The authenticated glab user's username, for the board's "mine" filter.
// Best-effort and only needs one call total (not per workspace): any
// workspace's checkout will do, since it's asking glab "who am I", not
// anything project-scoped.
export async function fetchCurrentUsername(glab: GlabClient, cwd: string): Promise<string | null> {
  if (!glab.currentUser) return null;
  const result = await glab.currentUser(cwd);
  if (!result.ok) return null;
  try {
    const data: unknown = JSON.parse(result.stdout);
    const username = data && typeof data === "object" ? (data as { username?: unknown }).username : undefined;
    return typeof username === "string" && username !== "" ? username : null;
  } catch {
    return null;
  }
}

async function computeOne(ws: Workspace, cfg: Config, log: Logger, glab: GlabClient): Promise<BoardRow | null> {
  let decision: Awaited<ReturnType<typeof inspectWorkspace>>;
  try {
    decision = await inspectWorkspace(ws, cfg, glab);
  } catch (err) {
    log.warn(`${ws.label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (decision.kind !== "report" || decision.mr.state !== "opened") return null;

  const { mr, unresolved, branch } = decision;
  const approvals = await fetchApprovals(glab, mr.projectId, mr.iid, ws.checkoutPath);
  return {
    workspaceId: ws.workspaceId,
    checkoutPath: ws.checkoutPath,
    repo: ws.label,
    repoName: ws.repoName ?? null,
    iid: mr.iid,
    title: mr.title,
    draft: mr.draft,
    pipelineStatus: mr.pipelineStatus,
    unresolved,
    comments: mr.commentCount,
    approvals,
    webUrl: mr.webUrl,
    branch,
    createdAt: mr.createdAt,
    authorUsername: mr.authorUsername,
  };
}

// Compute every workspace's board row concurrently: this is either the
// poller's own periodic cycle (background, latency doesn't matter much) or
// an explicit on-demand refresh a person is waiting on, and either way
// there's no reason to make one workspace's slow glab call hold up another
// workspace's fast one. Rows come back in `workspaces` order.
export async function computeBoardRows(workspaces: Workspace[], cfg: Config, log: Logger, glab: GlabClient): Promise<BoardRow[]> {
  const results = await Promise.all(workspaces.map((ws) => computeOne(ws, cfg, log, glab)));
  return results.filter((row): row is BoardRow => row !== null);
}

// Compute the board and write it (plus the current username, for "mine") to
// the cache in one step -- what both the poller and bin/board-rows.ts's
// `--refresh` actually call.
export async function refreshBoard(
  workspaces: Workspace[],
  cfg: Config,
  log: Logger,
  glab: GlabClient,
  boardPath?: string,
  userPath?: string,
): Promise<BoardRow[]> {
  const rows = await computeBoardRows(workspaces, cfg, log, glab);
  writeBoardCache(rows, boardPath);
  if (workspaces[0]) {
    const username = await fetchCurrentUsername(glab, workspaces[0].checkoutPath);
    writeCachedUsername(username, userPath);
  }
  return rows;
}

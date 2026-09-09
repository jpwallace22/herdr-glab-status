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
//
// Two ways in: refreshTokensAndBoard() drives refreshWorkspaces() itself
// and reuses its per-workspace decisions to build rows, so the poller's
// cycle and the `refresh` action pay for inspectWorkspace's branch/mr-view/
// discussions calls once, not twice. refreshBoard()/computeBoardRows() run
// inspectWorkspace independently, for the one caller that doesn't already
// have a refreshWorkspaces result to reuse (bin/board-rows.ts's on-demand
// --refresh, triggered from inside the picker).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Approvals } from "./approvals";
import { parseApprovals } from "./approvals";
import type { Config } from "./config";
import { stateDir } from "./env";
import { createGlabClient, type GlabClient } from "./glab";
import { listWorkspaces, type Workspace } from "./herdr";
import type { Logger } from "./log";
import { inspectWorkspace, refreshWorkspaces, type Decision, type RefreshSummary } from "./refresh";

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

// Build one board row from a decision already computed by inspectWorkspace
// (directly, or via refreshWorkspaces' onDecision callback) -- the shared
// tail end of both computeOne (which does its own inspectWorkspace call)
// and the combined refresh below (which reuses refreshWorkspaces' own
// decisions instead of re-deriving them). null for anything that isn't an
// open MR; never called with an "abort" decision (callers check first).
async function boardRowFromDecision(ws: Workspace, decision: Decision, glab: GlabClient): Promise<BoardRow | null> {
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

// Inspect one workspace end to end for board.ts's own callers (the ones
// that don't already have a decision from refreshWorkspaces -- currently
// just bin/board-rows.ts's on-demand --refresh). An abort (glab missing or
// unauthenticated) is logged and treated as "no row" rather than silently
// dropped: previously this was indistinguishable from "no MR", so a glab
// auth failure emptied the board with no trace of why.
async function computeOne(ws: Workspace, cfg: Config, log: Logger, glab: GlabClient): Promise<BoardRow | null> {
  let decision: Decision;
  try {
    decision = await inspectWorkspace(ws, cfg, glab);
  } catch (err) {
    log.warn(`${ws.label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (decision.kind === "abort") {
    log.error(decision.message);
    return null;
  }
  return boardRowFromDecision(ws, decision, glab);
}

// Compute every workspace's board row concurrently: this is either the
// poller's own periodic cycle (background, latency doesn't matter much) or
// an explicit on-demand refresh a person is waiting on, and either way
// there's no reason to make one workspace's slow glab call hold up another
// workspace's fast one. Rows come back in `workspaces` order. If more than
// one workspace aborts in the same batch (e.g. glab is globally
// unauthenticated), only the first is logged -- they're all the same
// underlying problem.
export async function computeBoardRows(workspaces: Workspace[], cfg: Config, log: Logger, glab: GlabClient): Promise<BoardRow[]> {
  let abortLogged = false;
  const dedupedLog: Logger = { ...log, error: (m) => { if (!abortLogged) { abortLogged = true; log.error(m); } } };
  const results = await Promise.all(workspaces.map((ws) => computeOne(ws, cfg, dedupedLog, glab)));
  return results.filter((row): row is BoardRow => row !== null);
}

// Splice one workspace's row into the existing board cache, from a decision
// already computed elsewhere (refreshWorkspaces' onDecision callback) --
// what bin/update.ts's per-workspace event path calls, so the board catches
// up with the same single inspectWorkspace check that just refreshed the
// sidebar token, instead of running a second one. Drops the row when the
// workspace no longer has an open MR; leaves the cache untouched on abort
// (same "don't blank on a transient/auth failure" rule as the sidebar
// token -- refreshWorkspaces already logged it once).
export async function updateBoardCacheFromDecision(
  ws: Workspace,
  decision: Decision,
  glab: GlabClient,
  boardPath?: string,
): Promise<void> {
  if (decision.kind === "abort") return;
  const row = await boardRowFromDecision(ws, decision, glab);
  const rest = readBoardCache(boardPath).filter((r) => r.workspaceId !== ws.workspaceId);
  writeBoardCache(row ? [...rest, row] : rest, boardPath);
}

// Compute the board and write it (plus the current username, for "mine") to
// the cache in one step -- what bin/board-rows.ts's on-demand `--refresh`
// calls. Runs inspectWorkspace itself (via computeBoardRows); for the
// poller/refresh-action paths, which already need the same per-workspace
// check for the sidebar token, use refreshTokensAndBoard below instead so
// that work isn't done twice.
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

// Refreshes both the sidebar $mr tokens (refreshWorkspaces, unchanged
// behavior) and the board cache in one pass over inspectWorkspace instead
// of two independent ones -- what the poller's cycle and the `refresh`
// action both want. Lists workspaces itself (mirrors refresh.ts's
// refreshAll) so callers don't have to fetch them twice either. Skips the
// board write entirely when the token refresh couldn't reach herdr or
// aborted (nothing usable to build rows from).
export async function refreshTokensAndBoard(
  cfg: Config,
  log: Logger,
  glab?: GlabClient,
  boardPath?: string,
  userPath?: string,
): Promise<RefreshSummary> {
  const workspaces = await listWorkspaces();
  if (workspaces === null) {
    log.warn("could not list workspaces (is the herdr server running?)");
    return { reported: 0, cleared: 0, kept: 0, failed: 0, aborted: null, herdrUnavailable: true };
  }
  const resolvedGlab = glab ?? createGlabClient(cfg);

  const decisions: { ws: Workspace; decision: Decision }[] = [];
  const summary = await refreshWorkspaces(workspaces, cfg, log, resolvedGlab, (ws, decision) => decisions.push({ ws, decision }));

  if (!summary.herdrUnavailable && !summary.aborted) {
    const rows = (
      await Promise.all(decisions.map(({ ws, decision }) => boardRowFromDecision(ws, decision, resolvedGlab)))
    ).filter((row): row is BoardRow => row !== null);
    writeBoardCache(rows, boardPath);
    if (workspaces[0]) {
      const username = await fetchCurrentUsername(resolvedGlab, workspaces[0].checkoutPath);
      writeCachedUsername(username, userPath);
    }
  }
  return summary;
}

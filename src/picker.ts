// Data + formatting for the `pick-mr` action: one row per open MR across
// every workspace herdr tracks, ready to hand to fzf.
//
// Row collection reuses inspectWorkspace() as-is, so the picker shares
// refresh.ts's branch → MR resolution and its transient-failure handling
// (a workspace with a flaky glab call is skipped for this run, not shown
// with wrong data) instead of a second, parallel implementation of that
// logic. It adds exactly one extra glab call per open MR (approvals) beyond
// what the sidebar refresh already makes — worth it for a one-shot
// interactive picker, not for the background poll cycle.
//
// Unlike refresh.ts's refreshWorkspaces (deliberately sequential: it runs
// every ~5 minutes forever in the background, so gentleness matters more
// than latency), collectRows runs every workspace concurrently. This is a
// one-shot interactive command a person is sitting at a keybinding waiting
// on, and each workspace's own pipeline (branch check, mr view, discussion
// pages, an approvals call) already carries 15-20s glab-call timeouts — done
// sequentially across a dozen workspaces that's a minute or more of nothing
// on screen before fzf ever appears. Concurrently, the wait is bounded by
// the single slowest workspace instead of their sum.

import type { Approvals } from "./approvals";
import { parseApprovals } from "./approvals";
import type { Config } from "./config";
import type { GlabClient } from "./glab";
import type { Workspace } from "./herdr";
import { pipelineSymbol } from "./label";
import type { Logger } from "./log";
import { inspectWorkspace } from "./refresh";

export interface MrRow {
  workspace: Workspace;
  repo: string;
  iid: number;
  title: string;
  draft: boolean;
  pipelineStatus: string | null;
  /** Unresolved discussion threads, or null when counting was skipped
   * (count_unresolved = false) or failed for this MR. */
  unresolved: number | null;
  /** Total comments (user_notes_count), or null if glab didn't report one. */
  comments: number | null;
  /** null when the approvals call failed or was skipped, not "0/0". */
  approvals: Approvals | null;
  webUrl: string | null;
}

export interface CollectResult {
  rows: MrRow[];
  /** glab was unusable (missing/unauthenticated); collection stopped early. */
  aborted: boolean;
}

// Called as each workspace finishes, so a caller (bin/pick-mr.ts) can show
// progress. `index` is a count of workspaces completed so far, not the
// workspace's position in the input list — workspaces run concurrently, so
// they don't finish in input order.
export type ProgressCallback = (workspace: Workspace, index: number, total: number) => void;

// Fetch approvals for one MR. Best-effort: any failure (including a
// GlabClient without the optional `approvals` method) yields null rather
// than dropping the row, since APPR is one column among several.
async function fetchApprovals(glab: GlabClient, projectId: number | null, iid: number, cwd: string): Promise<Approvals | null> {
  if (!glab.approvals) return null;
  const result = await glab.approvals(projectId, iid, cwd);
  if (!result.ok) return null;
  return parseApprovals(result.stdout);
}

// Inspect one workspace end to end (decision + approvals if it turns into a
// report row), for collectRows to fan out over every workspace at once.
async function collectOne(
  ws: Workspace,
  cfg: Config,
  log: Logger,
  glab: GlabClient,
): Promise<{ row: MrRow | null; aborted: string | null }> {
  let decision: Awaited<ReturnType<typeof inspectWorkspace>>;
  try {
    decision = await inspectWorkspace(ws, cfg, glab);
  } catch (err) {
    log.warn(`${ws.label}: ${err instanceof Error ? err.message : String(err)}`);
    return { row: null, aborted: null };
  }
  if (decision.kind === "abort") return { row: null, aborted: decision.message };
  if (decision.kind !== "report" || decision.mr.state !== "opened") return { row: null, aborted: null };

  const { mr, unresolved } = decision;
  const approvals = await fetchApprovals(glab, mr.projectId, mr.iid, ws.checkoutPath);
  return {
    row: {
      workspace: ws,
      repo: ws.label,
      iid: mr.iid,
      title: mr.title,
      draft: mr.draft,
      pipelineStatus: mr.pipelineStatus,
      unresolved,
      comments: mr.commentCount,
      approvals,
      webUrl: mr.webUrl,
    },
    aborted: null,
  };
}

// Inspect every workspace concurrently, reusing inspectWorkspace's decision
// for each one. Only "report" decisions for opened (not merged/closed) MRs
// become rows; workspaces with no MR, a kept (transient) token, or a
// merged/closed MR are silently skipped, same as they'd be blank in the
// sidebar. Rows come back in the same order as `workspaces`, regardless of
// which finished first. An abort (glab missing or unauthenticated) is
// reported to the caller instead of throwing, mirroring refreshWorkspaces —
// but unlike refreshWorkspaces it does not stop other workspaces early:
// they're already in flight by the time any one of them aborts, and a
// workspace's own successful result shouldn't be thrown away just because a
// different one hit an auth error.
export async function collectRows(
  workspaces: Workspace[],
  cfg: Config,
  log: Logger,
  glab: GlabClient,
  onProgress?: ProgressCallback,
): Promise<CollectResult> {
  let aborted = false;
  let completed = 0;
  const total = workspaces.length;

  const results = await Promise.all(
    workspaces.map(async (ws) => {
      const result = await collectOne(ws, cfg, log, glab);
      completed++;
      onProgress?.(ws, completed, total);
      if (result.aborted) {
        // Only the first abort is logged: with everything running
        // concurrently, several workspaces can hit "glab is unusable" at
        // once, and it's the same underlying problem each time.
        if (!aborted) log.error(result.aborted);
        aborted = true;
      }
      return result.row;
    }),
  );

  return { rows: results.filter((row): row is MrRow => row !== null), aborted };
}

// Higher = needs attention sooner. A failed pipeline outweighs everything
// else; unresolved threads and missing approvals matter but less; drafts
// sink to the bottom since they're not usually waiting on anyone yet.
export function attentionScore(row: MrRow): number {
  let score = 0;
  // Comfortably above the largest possible sum of the other signals (capped
  // unresolved threads + a handful of missing approvals), so a failed
  // pipeline always sorts first.
  if (row.pipelineStatus === "failed") score += 1000;
  else if (row.pipelineStatus === "running") score += 5;
  if (row.unresolved !== null) score += Math.min(row.unresolved, 20) * 10;
  if (row.approvals) {
    const missing = row.approvals.required - row.approvals.given;
    if (missing > 0) score += missing * 15;
  }
  if (row.draft) score -= 50;
  return score;
}

// Most attention-needing first; ties broken by comment count, then title.
export function sortRows(rows: MrRow[]): MrRow[] {
  return [...rows].sort((a, b) => {
    const byScore = attentionScore(b) - attentionScore(a);
    if (byScore !== 0) return byScore;
    const byComments = (b.comments ?? 0) - (a.comments ?? 0);
    if (byComments !== 0) return byComments;
    return a.title.localeCompare(b.title);
  });
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function ciCell(row: MrRow): string {
  if (!row.pipelineStatus) return "-";
  const symbol = pipelineSymbol(row.pipelineStatus);
  return symbol ? `${symbol} ${row.pipelineStatus}` : row.pipelineStatus;
}

function apprCell(row: MrRow): string {
  return row.approvals ? `${row.approvals.given}/${row.approvals.required}` : "?";
}

// Zero and "not counted" render the same as the sidebar label does (no ✎N
// segment): there's nothing here that needs a reviewer's attention either way.
function thrCell(row: MrRow): string {
  return row.unresolved ? String(row.unresolved) : "-";
}

function cmtCell(row: MrRow): string {
  return row.comments === null ? "-" : String(row.comments);
}

function titleCell(row: MrRow): string {
  return row.draft ? `[draft] ${row.title}` : row.title;
}

export interface FormattedRows {
  header: string;
  /** One per row, in `<index>\t<visible columns>` form so a caller (fzf via
   * `--delimiter '\t' --with-nth 2`) can hide the index while still being
   * able to map a selected line back to `rows[index]`. */
  lines: string[];
}

const COLUMN_TITLES = ["REPO", "MR", "CI", "APPR", "THR", "CMT"] as const;

// Fixed-width columns sized to the widest cell (or the header, if that's
// wider), TITLE left ragged since it's last and terminals/fzf wrap it anyway.
export function formatRows(rows: MrRow[]): FormattedRows {
  const mrCell = (r: MrRow) => `!${r.iid}`;
  const cells: ((r: MrRow) => string)[] = [(r) => r.repo, mrCell, ciCell, apprCell, thrCell, cmtCell];
  const widths = COLUMN_TITLES.map((title, i) => Math.max(title.length, ...rows.map((r) => cells[i]!(r).length)));

  const header = COLUMN_TITLES.map((title, i) => pad(title, widths[i]!)).join("  ").concat("  TITLE");
  const lines = rows.map((row, index) => {
    const visible = cells.map((cell, i) => pad(cell(row), widths[i]!)).join("  ").concat(`  ${titleCell(row)}`);
    return `${index}\t${visible}`;
  });
  return { header, lines };
}

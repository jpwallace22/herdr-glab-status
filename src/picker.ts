// Presentation for the pick-mr board: filtering, sorting, and fzf-ready
// formatting over BoardRow[] (src/board.ts computes and caches that data;
// this module never touches glab or herdr, it's pure and synchronous).

import type { BoardFilters } from "./board-filters";
import type { BoardRow } from "./board";
import type { WorkspaceStatus } from "./herdr";
import { pipelineSymbol } from "./label";

// s/d/m filters (see src/board-filters.ts). `currentUsername` is null when
// it couldn't be determined (see board.ts's fetchCurrentUsername) -- mine
// filtering is then a no-op rather than hiding everything, since "mine" is
// unknowable, not "nothing is mine".
export function applyFilters(rows: BoardRow[], filters: BoardFilters, currentUsername: string | null): BoardRow[] {
  return rows.filter((row) => {
    if (!filters.showDrafts && row.draft) return false;
    if (filters.mineOnly && currentUsername && row.authorUsername !== currentUsername) return false;
    if (filters.scopeRepo && row.repoName !== filters.scopeRepo) return false;
    return true;
  });
}

// Higher = needs attention sooner. A failed pipeline outweighs everything
// else; unresolved threads and missing approvals matter but less; drafts
// sink to the bottom since they're not usually waiting on anyone yet.
export function attentionScore(row: BoardRow): number {
  let score = 0;
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
export function sortRows(rows: BoardRow[]): BoardRow[] {
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

function ciCell(row: BoardRow): string {
  if (!row.pipelineStatus) return "-";
  const symbol = pipelineSymbol(row.pipelineStatus);
  return symbol ? `${symbol} ${row.pipelineStatus}` : row.pipelineStatus;
}

function apprCell(row: BoardRow): string {
  return row.approvals ? `${row.approvals.given}/${row.approvals.required}` : "?";
}

// Zero and "not counted" render the same as the sidebar label does (no ✎N
// segment): there's nothing here that needs a reviewer's attention either way.
function thrCell(row: BoardRow): string {
  return row.unresolved ? String(row.unresolved) : "-";
}

function cmtCell(row: BoardRow): string {
  return row.comments === null ? "-" : String(row.comments);
}

function titleCell(row: BoardRow): string {
  return row.draft ? `[draft] ${row.title}` : row.title;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function ageCell(row: BoardRow, now: number = Date.now()): string {
  if (!row.createdAt) return "?";
  const ms = now - Date.parse(row.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export interface FormattedRows {
  header: string;
  /** One per row, in `<index>\t<visible columns>` form so a caller (fzf via
   * `--delimiter '\t' --with-nth 2`) can hide the index while still being
   * able to map a selected line back to `rows[index]`. */
  lines: string[];
}

const COLUMN_TITLES = ["REPO", "MR", "CI", "APPR", "THR", "CMT", "AGE"] as const;

// Printed via `--footer` (fzf 0.63+; see bin/pick-mr.ts), pinned to the
// bottom of the pane rather than mixed into the column header.
export const KEY_LEGEND =
  "[enter]: workspace   [ctrl-o]: browser   [ctrl-r]: refresh   [ctrl-d]: drafts   [alt-m]: mine   [ctrl-s]: scope   [esc]: quit";

// Fixed-width columns sized to the widest cell (or the header, if that's
// wider); TITLE left ragged since it's last and terminals/fzf wrap it anyway.
export function formatRows(rows: BoardRow[], now: number = Date.now()): FormattedRows {
  const mrCell = (r: BoardRow) => `!${r.iid}`;
  const cells: ((r: BoardRow) => string)[] = [(r) => r.repo, mrCell, ciCell, apprCell, thrCell, cmtCell, (r) => ageCell(r, now)];
  const widths = COLUMN_TITLES.map((title, i) => Math.max(title.length, ...rows.map((r) => cells[i]!(r).length)));

  const header = COLUMN_TITLES.map((title, i) => pad(title, widths[i]!)).join("  ").concat("  TITLE");
  const lines = rows.map((row, index) => {
    const visible = cells.map((cell, i) => pad(cell(row), widths[i]!)).join("  ").concat(`  ${titleCell(row)}`);
    return `${index}\t${visible}`;
  });
  return { header, lines };
}

// The right-hand preview for whichever row is highlighted: the *workspace*
// only -- where it lives and its live herdr state (agent, panes/tabs,
// focus). No MR content at all: the row you're looking at already tells
// you which MR this is (REPO/MR/TITLE columns), so this pane is purely
// "what and where is this workspace". `status` is null when `herdr
// workspace get` failed or the caller skipped it; every workspace-state
// line then reads "?" rather than being omitted, so the layout doesn't
// jump around row to row.
export function formatPreview(row: BoardRow, status: WorkspaceStatus | null): string {
  return [
    `${row.repo}  (workspace ${row.workspaceId})`,
    row.repoName ? `${row.repoName} · ${row.branch}` : row.branch,
    row.checkoutPath,
    "",
    `agent      ${status?.agentStatus ?? "?"}`,
    `panes      ${status ? status.paneCount : "?"}   tabs   ${status ? status.tabCount : "?"}`,
    `focused    ${status ? (status.focused ? "yes" : "no") : "?"}`,
  ].join("\n");
}

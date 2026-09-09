// Data + formatting for the `pick-mr` action: one row per workspace's
// current `$mr` sidebar token, ready to hand to fzf.
//
// This is deliberately just a read of what herdr already has cached from
// the background poller / event-driven refresh (`herdr workspace list`'s
// per-workspace `tokens.mr`, see src/herdr.ts) -- no glab call, no network
// round trip, nothing to wait on. It shows exactly what the sidebar is
// already showing, not a fresher, slower re-check: pick-mr is a picker over
// current status, not another refresh. If a token looks stale, that's what
// `herdr plugin action invoke refresh --plugin glab-status` (or waiting for
// the next poll cycle) is for, same as it always was.

import type { Workspace } from "./herdr";

export interface MrRow {
  workspace: Workspace;
  repo: string;
  /** The raw `$mr` token, e.g. "!581 ✖ ✎1" or "!66 draft ✔" (see
   * label.ts's formatLabel for the grammar). */
  token: string;
}

// merged/closed MRs still carry a token (so the sidebar can show them
// briefly) but aren't "open" -- formatLabel puts the literal word right
// after the iid, so this mirrors that grammar rather than re-deriving state
// from scratch.
const NOT_OPEN = /^!\d+ (?:merged|closed)(?:\s|$)/;

// One row per workspace with an open MR's token. Workspaces with no token
// (no MR, or the token has expired) or a merged/closed one are left out,
// same as they'd show nothing (or a token you can't act on) in the sidebar.
export function collectRows(workspaces: Workspace[]): MrRow[] {
  const rows: MrRow[] = [];
  for (const workspace of workspaces) {
    const token = workspace.mrToken;
    if (!token || NOT_OPEN.test(token)) continue;
    rows.push({ workspace, repo: workspace.label, token });
  }
  return rows;
}

// Higher = needs attention sooner. Read straight off the token's own
// grammar rather than re-parsing structured fields we don't have here: a
// failed pipeline (✖) outweighs everything else, each unresolved thread
// (✎N) adds a bit, and a draft sinks to the bottom since it's not usually
// waiting on anyone yet.
export function attentionScore(row: MrRow): number {
  let score = 0;
  if (row.token.includes("✖")) score += 1000;
  else if (row.token.includes("↻")) score += 5;
  const unresolved = /✎(\d+)/.exec(row.token);
  if (unresolved) score += Math.min(Number(unresolved[1]), 20) * 10;
  if (/(?:^|\s)draft(?:\s|$)/.test(row.token)) score -= 50;
  return score;
}

// Most attention-needing first; ties broken by repo name.
export function sortRows(rows: MrRow[]): MrRow[] {
  return [...rows].sort((a, b) => attentionScore(b) - attentionScore(a) || a.repo.localeCompare(b.repo));
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export interface FormattedRows {
  header: string;
  /** One per row, in `<index>\t<visible columns>` form so a caller (fzf via
   * `--delimiter '\t' --with-nth 2`) can hide the index while still being
   * able to map a selected line back to `rows[index]`. */
  lines: string[];
}

// REPO padded to the widest label (or the header, if that's wider); the
// token is left ragged since it's short and already fixed-format.
export function formatRows(rows: MrRow[]): FormattedRows {
  const repoWidth = Math.max("REPO".length, ...rows.map((r) => r.repo.length));
  const header = `${pad("REPO", repoWidth)}  MR`;
  const lines = rows.map((row, index) => `${index}\t${pad(row.repo, repoWidth)}  ${row.token}`);
  return { header, lines };
}

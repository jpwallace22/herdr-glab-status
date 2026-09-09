// Parses `glab api projects/:id/merge_requests/:iid/approvals`, for the
// pick-mr board's APPR column. This is a GitLab API field the sidebar
// `$mr` token never needed and so never fetched; src/board.ts pays for it
// once per open MR per poller cycle (~5 min default) so the board itself
// can read a cache instead of ever calling glab at picker-open time.

export interface Approvals {
  given: number;
  required: number;
}

export function parseApprovals(stdout: string): Approvals | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const a = data as Record<string, unknown>;
  const required = typeof a.approvals_required === "number" ? a.approvals_required : null;
  const given = Array.isArray(a.approved_by) ? a.approved_by.length : null;
  if (required === null || given === null) return null;
  return { given, required };
}

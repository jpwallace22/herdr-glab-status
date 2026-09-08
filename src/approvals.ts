// Parses `glab api projects/:id/merge_requests/:iid/approvals`, for the
// `pick-mr` picker's APPR column. This is a GitLab API field the background
// sidebar refresh never needed and so never fetched — an extra call per open
// MR is worth paying for a one-shot interactive picker, but not for every
// workspace on every poll cycle.

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

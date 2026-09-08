// Sidebar label composition. Format (kept stable, it is in use):
//   !<iid>[ draft][ merged][ closed][ <pipeline-symbol>][ ✎<unresolved>]
// e.g. `!67 draft ↻`, `!575 ✔ ✎2`.

export interface MrSummary {
  iid: number;
  /** GitLab MR state: opened | merged | closed | locked */
  state: string;
  draft: boolean;
  /** head_pipeline.status, or null when the MR has no pipeline. */
  pipelineStatus: string | null;
  webUrl: string | null;
  projectId: number | null;
  /** Only read by the `pick-mr` picker; the sidebar label doesn't show it. */
  title: string;
  /** user_notes_count from the GitLab API, i.e. total comments (not just
   * unresolved threads). Only read by the `pick-mr` picker. */
  commentCount: number | null;
}

export const PIPELINE_SYMBOLS: Readonly<Record<string, string>> = {
  success: "✔",
  failed: "✖",
  running: "↻",
  pending: "⋯",
  created: "⋯",
  waiting_for_resource: "⋯",
  preparing: "⋯",
  scheduled: "⋯",
  canceled: "⊘",
  canceling: "⊘",
  skipped: "⊘",
  manual: "⚙",
};

export function pipelineSymbol(status: string | null | undefined): string {
  if (!status) return "";
  return PIPELINE_SYMBOLS[status] ?? "";
}

export function formatLabel(
  mr: Pick<MrSummary, "iid" | "state" | "draft" | "pipelineStatus">,
  unresolved: number | null,
): string {
  const parts = [`!${mr.iid}`];
  if (mr.draft) parts.push("draft");
  if (mr.state === "merged") parts.push("merged");
  if (mr.state === "closed") parts.push("closed");
  const symbol = pipelineSymbol(mr.pipelineStatus);
  if (symbol) parts.push(symbol);
  if (unresolved !== null && Number.isFinite(unresolved) && unresolved > 0) {
    parts.push(`✎${Math.floor(unresolved)}`);
  }
  return parts.join(" ");
}

// Parse the JSON printed by `glab mr view <ref> --output json`. Returns null
// when the payload does not look like a merge request.
export function parseMrView(stdout: string): MrSummary | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const mr = data as Record<string, unknown>;
  if (typeof mr.iid !== "number") return null;
  const pipeline = mr.head_pipeline;
  const pipelineStatus =
    pipeline && typeof pipeline === "object" && typeof (pipeline as { status?: unknown }).status === "string"
      ? ((pipeline as { status: string }).status)
      : null;
  return {
    iid: mr.iid,
    state: typeof mr.state === "string" ? mr.state : "opened",
    draft: mr.draft === true,
    pipelineStatus,
    webUrl: typeof mr.web_url === "string" ? mr.web_url : null,
    projectId: typeof mr.project_id === "number" ? mr.project_id : null,
    title: typeof mr.title === "string" ? mr.title : "",
    commentCount: typeof mr.user_notes_count === "number" ? mr.user_notes_count : null,
  };
}

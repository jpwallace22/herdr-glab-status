// Branch → merge request reference.
//
// Normally an MR is looked up by its source branch. Branches named
// `mr-<iid>-review` are local scratch checkouts of someone else's MR (created by
// review tooling), so they resolve to that iid directly.

export const SCRATCH_BRANCH_PATTERN = /^mr-([0-9]+)-review$/;

export type MrRef = { kind: "iid"; iid: number } | { kind: "branch"; branch: string };

export function resolveMrRef(branch: string): MrRef {
  const match = SCRATCH_BRANCH_PATTERN.exec(branch);
  if (match) {
    const iid = Number(match[1]);
    if (Number.isSafeInteger(iid) && iid > 0) return { kind: "iid", iid };
  }
  return { kind: "branch", branch };
}

// The argument to pass to `glab mr view`.
export function mrRefArg(ref: MrRef): string {
  return ref.kind === "iid" ? String(ref.iid) : ref.branch;
}

// Normalise `git branch --show-current` output: empty (detached HEAD) → null.
export function normalizeBranch(raw: string | null | undefined): string | null {
  const name = raw?.trim();
  if (!name || name === "HEAD") return null;
  return name;
}

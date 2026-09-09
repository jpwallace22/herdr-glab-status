// Persisted toggle state for the pick-mr board's s/d/m keys (scope, drafts,
// mine). A tiny file in the state dir rather than in-memory, because each
// key press is its own `bun bin/board-rows.ts` invocation (fzf's `reload`
// binding shells out fresh each time -- see bin/pick-mr.ts) with no shared
// process to hold state in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./env";

// The env var bin/pick-mr.ts sets to its per-session filters path, and
// bin/board-rows.ts reads -- a named constant shared by both rather than
// the same string literal typed twice, so a typo in either file fails to
// compile instead of silently falling back to the default shared path
// (which is exactly the cross-session filter bug this file's design fixed).
export const FILTERS_PATH_ENV_VAR = "GLAB_STATUS_FILTERS_PATH";

export interface BoardFilters {
  /** Isolate filter, same pattern as mineOnly/scopeRepo: false shows
   * everything (drafts included, the default); true narrows down to
   * *only* drafts. Not a show/hide toggle -- "filtering for drafts"
   * means filtering the list down to drafts, not hiding them. */
  draftsOnly: boolean;
  mineOnly: boolean;
  /** null = all repos; otherwise only rows whose repoName matches. */
  scopeRepo: string | null;
}

export const DEFAULT_FILTERS: Readonly<BoardFilters> = { draftsOnly: false, mineOnly: false, scopeRepo: null };

export function filtersPath(dir: string = stateDir()): string {
  return join(dir, "mr-board-filters.json");
}

export function readFilters(path: string = filtersPath()): BoardFilters {
  if (!existsSync(path)) return { ...DEFAULT_FILTERS };
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (data === null || typeof data !== "object") return { ...DEFAULT_FILTERS };
    const d = data as Record<string, unknown>;
    return {
      draftsOnly: typeof d.draftsOnly === "boolean" ? d.draftsOnly : DEFAULT_FILTERS.draftsOnly,
      mineOnly: typeof d.mineOnly === "boolean" ? d.mineOnly : DEFAULT_FILTERS.mineOnly,
      scopeRepo: typeof d.scopeRepo === "string" && d.scopeRepo !== "" ? d.scopeRepo : null,
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function writeFilters(filters: BoardFilters, path: string = filtersPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(filters));
}

export function toggleDrafts(path: string = filtersPath()): BoardFilters {
  const next = { ...readFilters(path) };
  next.draftsOnly = !next.draftsOnly;
  writeFilters(next, path);
  return next;
}

export function toggleMine(path: string = filtersPath()): BoardFilters {
  const next = { ...readFilters(path) };
  next.mineOnly = !next.mineOnly;
  writeFilters(next, path);
  return next;
}

// Cycles between "all repos" and "just this one" -- `currentRepo` is null
// when the caller doesn't know one (e.g. no workspace context), in which
// case toggling scope on is a no-op (there's nothing to scope to).
export function toggleScope(currentRepo: string | null, path: string = filtersPath()): BoardFilters {
  const next = { ...readFilters(path) };
  next.scopeRepo = next.scopeRepo === null ? currentRepo : null;
  writeFilters(next, path);
  return next;
}

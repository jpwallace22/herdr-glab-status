// Persisted toggle state for the pick-mr board's s/d/m keys (scope, drafts,
// mine). A tiny file in the state dir rather than in-memory, because each
// key press is its own `bun bin/board-rows.ts` invocation (fzf's `reload`
// binding shells out fresh each time -- see bin/pick-mr.ts) with no shared
// process to hold state in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./env";

export interface BoardFilters {
  showDrafts: boolean;
  mineOnly: boolean;
  /** null = all repos; otherwise only rows whose repoName matches. */
  scopeRepo: string | null;
}

export const DEFAULT_FILTERS: Readonly<BoardFilters> = { showDrafts: true, mineOnly: false, scopeRepo: null };

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
      showDrafts: typeof d.showDrafts === "boolean" ? d.showDrafts : DEFAULT_FILTERS.showDrafts,
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
  next.showDrafts = !next.showDrafts;
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

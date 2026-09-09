import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FILTERS, filtersPath, readFilters, toggleDrafts, toggleMine, toggleScope, writeFilters } from "../src/board-filters";

describe("board filters", () => {
  let dir: string;
  let path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-filters-"));
    path = filtersPath(dir);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("no file yet reads as defaults", () => {
    expect(readFilters(join(dir, "missing.json"))).toEqual(DEFAULT_FILTERS);
  });

  test("round-trips through the file", () => {
    writeFilters({ draftsOnly: true, mineOnly: true, scopeRepo: "repo-a" }, path);
    expect(readFilters(path)).toEqual({ draftsOnly: true, mineOnly: true, scopeRepo: "repo-a" });
  });

  test("toggleDrafts and toggleMine flip just their own field", () => {
    writeFilters(DEFAULT_FILTERS, path);
    expect(toggleDrafts(path)).toEqual({ draftsOnly: true, mineOnly: false, scopeRepo: null });
    expect(toggleDrafts(path)).toEqual({ draftsOnly: false, mineOnly: false, scopeRepo: null });
    expect(toggleMine(path)).toMatchObject({ mineOnly: true });
    expect(toggleMine(path)).toMatchObject({ mineOnly: false });
  });

  test("toggleScope cycles null -> given repo -> null", () => {
    writeFilters(DEFAULT_FILTERS, path);
    expect(toggleScope("repo-a", path).scopeRepo).toBe("repo-a");
    expect(toggleScope("repo-b", path).scopeRepo).toBeNull(); // was scoped -> clears regardless of the repo passed
    expect(toggleScope("repo-a", path).scopeRepo).toBe("repo-a");
  });

  test("toggling scope on with no known repo is a no-op (stays unscoped)", () => {
    writeFilters(DEFAULT_FILTERS, path);
    expect(toggleScope(null, path).scopeRepo).toBeNull();
  });

  test("malformed content on disk falls back to defaults", () => {
    Bun.write(path, "not json");
    expect(readFilters(path)).toEqual(DEFAULT_FILTERS);
    Bun.write(path, JSON.stringify({ draftsOnly: "nope" }));
    expect(readFilters(path)).toEqual(DEFAULT_FILTERS);
  });
});

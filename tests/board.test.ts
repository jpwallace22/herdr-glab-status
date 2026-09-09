import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import type { CommandResult } from "../src/exec";
import type { GlabClient } from "../src/glab";
import type { Workspace } from "../src/herdr";
import { silentLogger } from "../src/log";
import {
  boardCachePath,
  computeBoardRows,
  currentUserPath,
  fetchCurrentUsername,
  readBoardCache,
  readCachedUsername,
  refreshBoard,
  writeBoardCache,
  writeCachedUsername,
  type BoardRow,
} from "../src/board";

// ---------- fakes (same shape as tests/refresh.test.ts's fakeGlab) ----------

function ok(stdout: string): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", spawnError: null, timedOut: false };
}
function fail(stderr: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr, spawnError: null, timedOut: false, ...extra };
}

interface FakeRepo {
  branch: string | null;
  mrs?: Record<string, CommandResult>;
  approvals?: CommandResult;
}

function mr(iid: number, extra: Record<string, unknown> = {}): CommandResult {
  return ok(
    JSON.stringify({
      iid,
      state: "opened",
      draft: false,
      project_id: 42,
      web_url: `https://gl/mr/${iid}`,
      title: `MR ${iid}`,
      user_notes_count: 0,
      created_at: "2026-09-01T00:00:00Z",
      author: { username: "patc" },
      ...extra,
    }),
  );
}

function approvalsResult(given: number, required: number): CommandResult {
  return ok(JSON.stringify({ approvals_required: required, approved_by: Array.from({ length: given }, () => ({})) }));
}

function fakeGlab(repos: Record<string, FakeRepo>, currentUser: CommandResult | null = null): GlabClient {
  return {
    async currentBranch(cwd) {
      return repos[cwd]?.branch ?? null;
    },
    async mrView(ref, cwd) {
      return repos[cwd]?.mrs?.[ref] ?? fail('No open merge request available for "x".');
    },
    async discussionsPage() {
      return ok("[]");
    },
    async approvals(_projectId, _iid, cwd) {
      return repos[cwd]?.approvals ?? fail("not found");
    },
    async currentUser() {
      return currentUser ?? fail("not found");
    },
  };
}

const ws = (id: string, path: string, extra: Partial<Workspace> = {}): Workspace => ({
  workspaceId: id,
  label: id,
  checkoutPath: path,
  ...extra,
});
const cfg: Config = { ...DEFAULT_CONFIG };

describe("computeBoardRows", () => {
  test("builds a row per open MR, with the fields the token doesn't carry", () => {
    const glab = fakeGlab({
      "/a": { branch: "feat/a", mrs: { "feat/a": mr(10, { title: "Add widget" }) }, approvals: approvalsResult(1, 2) },
      "/b": { branch: "main" },
    });
    return computeBoardRows([ws("wA", "/a", { label: "repo-a" }), ws("wB", "/b")], cfg, silentLogger, glab).then((rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspaceId: "wA",
        repo: "repo-a",
        iid: 10,
        title: "Add widget",
        branch: "feat/a",
        approvals: { given: 1, required: 2 },
        webUrl: "https://gl/mr/10",
        authorUsername: "patc",
        createdAt: "2026-09-01T00:00:00Z",
      });
    });
  });

  test("skips merged/closed MRs and workspaces with no MR", async () => {
    const glab = fakeGlab({
      "/a": { branch: "b", mrs: { b: mr(1, { state: "merged" }) } },
      "/b": { branch: "main" },
    });
    const rows = await computeBoardRows([ws("wA", "/a"), ws("wB", "/b")], cfg, silentLogger, glab);
    expect(rows).toHaveLength(0);
  });

  test("a missing approvals method or a failed approvals call yields null, not a dropped row", async () => {
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } }); // no approvals fixture -> fail
    const rows = await computeBoardRows([ws("wA", "/a")], cfg, silentLogger, glab);
    expect(rows[0]?.approvals).toBeNull();
  });

  test("rows come back in workspace order regardless of which resolves first", async () => {
    const glab = fakeGlab({
      "/a": { branch: "a", mrs: { a: mr(1) } },
      "/b": { branch: "b", mrs: { b: mr(2) } },
      "/c": { branch: "c", mrs: { c: mr(3) } },
    });
    const rows = await computeBoardRows([ws("wA", "/a"), ws("wB", "/b"), ws("wC", "/c")], cfg, silentLogger, glab);
    expect(rows.map((r) => r.iid)).toEqual([1, 2, 3]);
  });

  test("a throwing glab client for one workspace is skipped and logged, not thrown", async () => {
    const glab = fakeGlab({ "/b": { branch: "c", mrs: { c: mr(2) } } });
    glab.currentBranch = async (cwd) => {
      if (cwd === "/a") throw new Error("kaboom");
      return "c";
    };
    const warnings: string[] = [];
    const rows = await computeBoardRows([ws("wA", "/a"), ws("wB", "/b")], cfg, { ...silentLogger, warn: (m) => warnings.push(m) }, glab);
    expect(rows.map((r) => r.iid)).toEqual([2]);
    expect(warnings.some((w) => w.includes("kaboom"))).toBe(true);
  });
});

describe("fetchCurrentUsername", () => {
  test("parses the username from `glab api user`", async () => {
    const glab = fakeGlab({}, ok(JSON.stringify({ username: "patc", id: 1 })));
    expect(await fetchCurrentUsername(glab, "/a")).toBe("patc");
  });

  test("null when the call fails, returns junk, or the method is missing", async () => {
    const glab = fakeGlab({}, fail("401"));
    expect(await fetchCurrentUsername(glab, "/a")).toBeNull();
    const noMethod: GlabClient = { currentBranch: async () => null, mrView: async () => fail(""), discussionsPage: async () => ok("[]") };
    expect(await fetchCurrentUsername(noMethod, "/a")).toBeNull();
  });
});

describe("refreshBoard", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-refresh-board-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("computes rows, writes the board cache, and caches the current username in one call", async () => {
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } }, ok(JSON.stringify({ username: "patc" })));
    const cachePath = boardCachePath(dir);
    const userPath = currentUserPath(dir);
    const rows = await refreshBoard([ws("wA", "/a")], cfg, silentLogger, glab, cachePath, userPath);
    expect(rows).toHaveLength(1);
    expect(readBoardCache(cachePath)).toEqual(rows);
    expect(readCachedUsername(userPath)).toBe("patc");
  });

  test("no workspaces at all: writes an empty board, skips the username fetch", async () => {
    const glab = fakeGlab({});
    const cachePath = boardCachePath(dir);
    const userPath = currentUserPath(dir);
    const rows = await refreshBoard([], cfg, silentLogger, glab, cachePath, userPath);
    expect(rows).toEqual([]);
    expect(readBoardCache(cachePath)).toEqual([]);
  });
});

describe("board cache", () => {
  let dir: string;
  let cachePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-board-"));
    cachePath = boardCachePath(dir);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const row: BoardRow = {
    workspaceId: "wA",
    checkoutPath: "/a",
    repo: "repo-a",
    repoName: "repo-a",
    iid: 10,
    title: "t",
    draft: false,
    pipelineStatus: "success",
    unresolved: 1,
    comments: 2,
    approvals: { given: 1, required: 2 },
    webUrl: "https://gl/mr/10",
    branch: "feat/a",
    createdAt: "2026-09-01T00:00:00Z",
    authorUsername: "patc",
  };

  test("round-trips rows through the cache file", () => {
    writeBoardCache([row], cachePath);
    expect(readBoardCache(cachePath)).toEqual([row]);
  });

  test("a missing file reads as empty, not an error", () => {
    expect(readBoardCache(join(dir, "does-not-exist.json"))).toEqual([]);
  });

  test("unparsable or non-array content reads as empty", () => {
    Bun.write(join(dir, "junk.json"), "not json");
    expect(readBoardCache(join(dir, "junk.json"))).toEqual([]);
    Bun.write(join(dir, "obj.json"), JSON.stringify({ not: "an array" }));
    expect(readBoardCache(join(dir, "obj.json"))).toEqual([]);
  });
});

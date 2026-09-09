import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import type { CommandResult } from "../src/exec";
import type { GlabClient } from "../src/glab";
import type { Workspace } from "../src/herdr";
import { silentLogger } from "../src/log";
import type { Decision } from "../src/refresh";
import {
  boardCachePath,
  computeBoardRows,
  currentUserPath,
  fetchCurrentUsername,
  readBoardCache,
  readCachedUsername,
  refreshBoard,
  refreshTokensAndBoard,
  updateBoardCacheFromDecision,
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

const UNAUTHORIZED = fail("GET https://gitlab.example.com/api/v4/user: 401 {message: 401 Unauthorized}");

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

function fakeGlab(repos: Record<string, FakeRepo>, currentUser: CommandResult | null = null): GlabClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async currentBranch(cwd) {
      calls.push(`branch ${cwd}`);
      return repos[cwd]?.branch ?? null;
    },
    async mrView(ref, cwd) {
      calls.push(`mr view ${ref} @${cwd}`);
      return repos[cwd]?.mrs?.[ref] ?? fail('No open merge request available for "x".');
    },
    async discussionsPage() {
      return ok("[]");
    },
    async approvals(_projectId, _iid, cwd) {
      calls.push(`approvals @${cwd}`);
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

  test("an auth failure (abort) is logged, not silently dropped like 'no MR'", async () => {
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: UNAUTHORIZED } } });
    const errors: string[] = [];
    const rows = await computeBoardRows([ws("wA", "/a")], cfg, { ...silentLogger, error: (m) => errors.push(m) }, glab);
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("glab auth login");
  });

  test("multiple workspaces aborting in the same batch log only once", async () => {
    const glab = fakeGlab({
      "/a": { branch: "b", mrs: { b: UNAUTHORIZED } },
      "/c": { branch: "d", mrs: { d: UNAUTHORIZED } },
    });
    const errors: string[] = [];
    await computeBoardRows([ws("wA", "/a"), ws("wC", "/c")], cfg, { ...silentLogger, error: (m) => errors.push(m) }, glab);
    expect(errors).toHaveLength(1);
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

// A "report" Decision for an open MR, matching what refreshWorkspaces'
// onDecision callback would hand updateBoardCacheFromDecision.
function reportDecision(iid: number, extra: Record<string, unknown> = {}): Decision {
  return {
    kind: "report",
    label: `!${iid}`,
    unresolved: null,
    warning: null,
    branch: "b",
    mr: {
      iid,
      state: "opened",
      draft: false,
      pipelineStatus: null,
      webUrl: null,
      projectId: 42,
      title: "t",
      commentCount: null,
      createdAt: null,
      authorUsername: null,
      ...extra,
    },
  };
}

describe("updateBoardCacheFromDecision", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-update-board-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("splices in just the one workspace's row, leaving the rest of the cache untouched", async () => {
    const cachePath = join(dir, "splice.json");
    writeBoardCache(
      [
        { workspaceId: "wOther", checkoutPath: "/other", repo: "other", repoName: "other", iid: 99, title: "t", draft: false, pipelineStatus: null, unresolved: null, comments: null, approvals: null, webUrl: null, branch: "b", createdAt: null, authorUsername: null },
      ],
      cachePath,
    );
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } });
    await updateBoardCacheFromDecision(ws("wA", "/a"), reportDecision(1, { title: "new" }), glab, cachePath);
    const rows = readBoardCache(cachePath);
    expect(rows.map((r) => r.workspaceId).sort()).toEqual(["wA", "wOther"]);
    expect(rows.find((r) => r.workspaceId === "wA")?.title).toBe("new");
  });

  test("replaces a stale row for the same workspace rather than duplicating it", async () => {
    const cachePath = join(dir, "replace.json");
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } });
    await updateBoardCacheFromDecision(ws("wA", "/a"), reportDecision(1, { title: "old" }), glab, cachePath);
    await updateBoardCacheFromDecision(ws("wA", "/a"), reportDecision(1, { title: "updated" }), glab, cachePath);
    const rows = readBoardCache(cachePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("updated");
  });

  test("drops the row when the decision says there's no open MR", async () => {
    const cachePath = join(dir, "drop.json");
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } });
    await updateBoardCacheFromDecision(ws("wA", "/a"), reportDecision(1), glab, cachePath);
    expect(readBoardCache(cachePath)).toHaveLength(1);

    await updateBoardCacheFromDecision(ws("wA", "/a"), { kind: "clear", reason: "no merge request for main" }, glab, cachePath);
    expect(readBoardCache(cachePath)).toEqual([]);
  });

  test("an abort decision leaves the cache untouched (matches the sidebar token's 'keep' rule)", async () => {
    const cachePath = join(dir, "abort.json");
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } });
    await updateBoardCacheFromDecision(ws("wA", "/a"), reportDecision(1, { title: "before" }), glab, cachePath);
    await updateBoardCacheFromDecision(ws("wA", "/a"), { kind: "abort", failure: "auth", message: "glab is not authenticated" }, glab, cachePath);
    expect(readBoardCache(cachePath)[0]?.title).toBe("before");
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

// ---------- refreshTokensAndBoard: real herdr calls via the fake binary ----------

describe("refreshTokensAndBoard", () => {
  let dir: string;
  let logFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  function herdrCalls(): string[][] {
    let text: string;
    try {
      text = readFileSync(logFile, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n\n")
      .filter((block) => block.trim() !== "")
      .map((block) => block.split("\n").filter((line, i, arr) => !(i === arr.length - 1 && line === "")));
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-status-refresh-tokens-board-"));
    logFile = join(dir, "herdr-calls.log");
    const fake = join(import.meta.dir, "fixtures", "fake-herdr.sh");
    chmodSync(fake, 0o755);
    for (const key of ["HERDR_BIN_PATH", "HERDR_PLUGIN_STATE_DIR", "FAKE_HERDR_LOG", "FAKE_HERDR_FAIL", "FAKE_HERDR_WORKSPACES_JSON"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HERDR_BIN_PATH = fake;
    process.env.HERDR_PLUGIN_STATE_DIR = join(dir, "state");
    process.env.FAKE_HERDR_LOG = logFile;
    delete process.env.FAKE_HERDR_FAIL;
  });

  beforeEach(() => {
    writeFileSync(logFile, "");
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("refreshes the sidebar token and the board cache from one pass over inspectWorkspace", async () => {
    process.env.FAKE_HERDR_WORKSPACES_JSON = JSON.stringify({
      result: { workspaces: [{ workspace_id: "wA", label: "repo-a", worktree: { checkout_path: "/a" } }] },
    });
    const glab = fakeGlab({ "/a": { branch: "feat/a", mrs: { "feat/a": mr(10, { title: "hi" }) } } });
    const cachePath = boardCachePath(dir);
    const summary = await refreshTokensAndBoard(cfg, silentLogger, glab, cachePath);
    expect(summary).toMatchObject({ reported: 1, cleared: 0, kept: 0, failed: 0, aborted: null });
    const rows = readBoardCache(cachePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: "wA", iid: 10, title: "hi" });
    // Exactly one glab currentBranch/mrView pass -- not two.
    expect(glab.calls.filter((c) => c.startsWith("branch"))).toHaveLength(1);
  });

  test("herdr unreachable: token summary reflects it, board is left untouched", async () => {
    process.env.FAKE_HERDR_FAIL = "1";
    try {
      const glab = fakeGlab({});
      const cachePath = boardCachePath(dir);
      const before = readBoardCache(cachePath);
      const summary = await refreshTokensAndBoard(cfg, silentLogger, glab, cachePath);
      expect(summary).toMatchObject({ herdrUnavailable: true });
      expect(readBoardCache(cachePath)).toEqual(before);
    } finally {
      delete process.env.FAKE_HERDR_FAIL;
    }
  });

  test("an aborted token refresh (auth failure) skips the board write entirely", async () => {
    process.env.FAKE_HERDR_WORKSPACES_JSON = JSON.stringify({
      result: { workspaces: [{ workspace_id: "wA", label: "repo-a", worktree: { checkout_path: "/a" } }] },
    });
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: UNAUTHORIZED } } });
    const cachePath = boardCachePath(dir);
    writeBoardCache([], cachePath);
    const summary = await refreshTokensAndBoard(cfg, silentLogger, glab, cachePath);
    expect(summary.aborted?.failure).toBe("auth");
    expect(readBoardCache(cachePath)).toEqual([]);
  });
});

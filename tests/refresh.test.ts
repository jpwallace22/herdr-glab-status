import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import type { CommandResult } from "../src/exec";
import type { GlabClient } from "../src/glab";
import type { Workspace } from "../src/herdr";
import { silentLogger, type Logger } from "../src/log";
import { inspectWorkspace, refreshWorkspaces } from "../src/refresh";
import { lastCheckMs } from "../src/throttle";

// ---------- fakes ----------

function ok(stdout: string): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", spawnError: null, timedOut: false };
}
function fail(stderr: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr, spawnError: null, timedOut: false, ...extra };
}

const NO_MR = fail('\n ERROR \n\n No open merge request available for "x".\n');
const UNAUTHORIZED = fail("GET https://gitlab.example.com/api/v4/user: 401 {message: 401 Unauthorized}");
const MISSING = fail("", { exitCode: null, spawnError: "spawn glab ENOENT" });

interface FakeRepo {
  branch: string | null;
  /** keyed by the ref glab would be called with (branch name or iid string) */
  mrs?: Record<string, CommandResult>;
  /** discussion pages, in order; missing pages return [] */
  discussions?: unknown[][];
  discussionsFailure?: CommandResult;
}

function mr(iid: number, extra: Record<string, unknown> = {}): CommandResult {
  return ok(JSON.stringify({ iid, state: "opened", draft: false, project_id: 42, web_url: `https://gl/mr/${iid}`, ...extra }));
}

function unresolvedThreads(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(i), notes: [{ resolvable: true, resolved: false }] }));
}

function fakeGlab(repos: Record<string, FakeRepo>): GlabClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async currentBranch(cwd) {
      calls.push(`branch ${cwd}`);
      return repos[cwd]?.branch ?? null;
    },
    async mrView(ref, cwd) {
      calls.push(`mr view ${ref} @${cwd}`);
      return repos[cwd]?.mrs?.[ref] ?? NO_MR;
    },
    async discussionsPage(projectId, iid, page, perPage, cwd) {
      calls.push(`discussions ${projectId}/${iid} p${page}x${perPage} @${cwd}`);
      const repo = repos[cwd];
      if (repo?.discussionsFailure) return repo.discussionsFailure;
      return ok(JSON.stringify(repo?.discussions?.[page - 1] ?? []));
    },
  };
}

const ws = (id: string, path: string): Workspace => ({ workspaceId: id, label: id, checkoutPath: path });
const cfg: Config = { ...DEFAULT_CONFIG };

// ---------- inspectWorkspace: clear vs report vs abort ----------

describe("inspectWorkspace decisions", () => {
  test("no branch (detached HEAD / not a repo) → clear without calling glab", async () => {
    const glab = fakeGlab({ "/w": { branch: null } });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d.kind).toBe("clear");
    expect(glab.calls).toEqual(["branch /w"]);
  });

  test("branch without an MR → clear", async () => {
    const glab = fakeGlab({ "/w": { branch: "feat/x" } });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "clear", reason: expect.stringContaining("no merge request") });
    expect(glab.calls).toEqual(["branch /w", "mr view feat/x @/w"]);
  });

  test("open MR with pipeline and unresolved threads → report with full label", async () => {
    const glab = fakeGlab({
      "/w": {
        branch: "feat/x",
        mrs: { "feat/x": mr(575, { head_pipeline: { status: "success" } }) },
        discussions: [unresolvedThreads(2)],
      },
    });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "report", label: "!575 ✔ ✎2", unresolved: 2, warning: null });
    // Exactly two glab API calls for an MR with <100 discussions.
    expect(glab.calls.filter((c) => !c.startsWith("branch"))).toEqual([
      "mr view feat/x @/w",
      "discussions 42/575 p1x100 @/w",
    ]);
  });

  test("scratch branch mr-<iid>-review resolves by iid", async () => {
    const glab = fakeGlab({
      "/w": { branch: "mr-67-review", mrs: { "67": mr(67, { draft: true, head_pipeline: { status: "running" } }) } },
    });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "report", label: "!67 draft ↻" });
    expect(glab.calls).toContain("mr view 67 @/w");
  });

  test("paginates discussions past 100", async () => {
    const glab = fakeGlab({
      "/w": {
        branch: "b",
        mrs: { b: mr(1) },
        discussions: [unresolvedThreads(100), unresolvedThreads(5)],
      },
    });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "report", label: "!1 ✎105", unresolved: 105 });
    expect(glab.calls.filter((c) => c.startsWith("discussions"))).toHaveLength(2);
  });

  test("count_unresolved = false skips the discussions call", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: mr(1) }, discussions: [unresolvedThreads(3)] } });
    const d = await inspectWorkspace(ws("w1", "/w"), { ...cfg, countUnresolved: false }, glab);
    expect(d).toMatchObject({ kind: "report", label: "!1", unresolved: null });
    expect(glab.calls.some((c) => c.startsWith("discussions"))).toBe(false);
  });

  test("merged MR keeps its label", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: mr(9, { state: "merged", head_pipeline: { status: "success" } }) } } });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "report", label: "!9 merged ✔" });
  });

  test("discussions failure (non-auth) → report the MR without ✎ and warn", async () => {
    const glab = fakeGlab({
      "/w": { branch: "b", mrs: { b: mr(5, { head_pipeline: { status: "failed" } }) }, discussionsFailure: fail("dial tcp: no such host") },
    });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "report", label: "!5 ✖", unresolved: null, warning: expect.stringContaining("no such host") });
  });

  test("unparsable MR JSON → clear", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: ok("<html>") } } });
    expect((await inspectWorkspace(ws("w1", "/w"), cfg, glab)).kind).toBe("clear");
  });

  test("other glab failure → clear (not abort)", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: fail("x509: certificate signed by unknown authority") } } });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "clear", reason: expect.stringContaining("x509") });
  });

  test("unauthenticated glab → abort", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: UNAUTHORIZED } } });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "abort", failure: "auth", message: expect.stringContaining("glab auth login") });
  });

  test("unauthenticated during discussions → abort too", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: mr(1) }, discussionsFailure: UNAUTHORIZED } });
    expect((await inspectWorkspace(ws("w1", "/w"), cfg, glab)).kind).toBe("abort");
  });

  test("missing glab binary → abort", async () => {
    const glab = fakeGlab({ "/w": { branch: "b", mrs: { b: MISSING } } });
    const d = await inspectWorkspace(ws("w1", "/w"), cfg, glab);
    expect(d).toMatchObject({ kind: "abort", failure: "missing", message: expect.stringContaining("glab_path") });
  });
});

// ---------- refreshWorkspaces against a fake herdr binary ----------

describe("refreshWorkspaces", () => {
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
    dir = mkdtempSync(join(tmpdir(), "glab-status-refresh-"));
    logFile = join(dir, "herdr-calls.log");
    const fake = join(import.meta.dir, "fixtures", "fake-herdr.sh");
    chmodSync(fake, 0o755);
    for (const key of ["HERDR_BIN_PATH", "HERDR_PLUGIN_STATE_DIR", "FAKE_HERDR_LOG", "FAKE_HERDR_FAIL"]) {
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

  test("reports MRs, clears non-MRs, records checks, uses TTL and seq", async () => {
    const glab = fakeGlab({
      "/a": { branch: "feat/a", mrs: { "feat/a": mr(10, { head_pipeline: { status: "success" } }) }, discussions: [unresolvedThreads(1)] },
      "/b": { branch: "main" },
      "/c": { branch: null },
    });
    const before = Date.now();
    const summary = await refreshWorkspaces([ws("wA", "/a"), ws("wB", "/b"), ws("wC", "/c")], cfg, silentLogger, glab);
    expect(summary).toEqual({ reported: 1, cleared: 2, failed: 0, aborted: null, herdrUnavailable: false });

    const calls = herdrCalls();
    expect(calls).toHaveLength(3);
    const [report, clearB, clearC] = calls as [string[], string[], string[]];
    expect(report.slice(0, 7)).toEqual(["workspace", "report-metadata", "wA", "--source", "glab-status", "--token", "mr=!10 ✔ ✎1"]);
    expect(report[report.indexOf("--ttl-ms") + 1]).toBe("900000");
    expect(Number(report[report.indexOf("--seq") + 1])).toBeGreaterThanOrEqual(before);
    expect(clearB.slice(0, 7)).toEqual(["workspace", "report-metadata", "wB", "--source", "glab-status", "--clear-token", "mr"]);
    expect(clearC[2]).toBe("wC");

    for (const id of ["wA", "wB", "wC"]) expect(lastCheckMs(id)).toBeGreaterThanOrEqual(before);
  });

  test("abort clears the failing and all remaining workspaces, logs once, and stops", async () => {
    const glab = fakeGlab({
      "/a": { branch: "a", mrs: { a: mr(1) } },
      "/b": { branch: "b", mrs: { b: UNAUTHORIZED } },
      "/c": { branch: "c", mrs: { c: mr(3) } },
    });
    const errors: string[] = [];
    const log: Logger = { ...silentLogger, error: (m) => errors.push(m) };
    const summary = await refreshWorkspaces([ws("wA", "/a"), ws("wB", "/b"), ws("wC", "/c")], cfg, log, glab);

    expect(summary.reported).toBe(1);
    expect(summary.cleared).toBe(2);
    expect(summary.aborted?.failure).toBe("auth");
    expect(errors).toHaveLength(1);
    // glab was not consulted for /c after the abort.
    expect(glab.calls.some((c) => c.includes("@/c"))).toBe(false);

    const calls = herdrCalls();
    expect(calls.map((c) => [c[2], c[5]])).toEqual([
      ["wA", "--token"],
      ["wB", "--clear-token"],
      ["wC", "--clear-token"],
    ]);
  });

  test("a throwing glab client for one workspace does not stop the others", async () => {
    const glab = fakeGlab({ "/a": { branch: "a", mrs: { a: mr(1) } }, "/c": { branch: "c", mrs: { c: mr(3) } } });
    glab.currentBranch = async (cwd) => {
      if (cwd === "/b") throw new Error("kaboom");
      return cwd === "/a" ? "a" : "c";
    };
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
    const summary = await refreshWorkspaces([ws("wA", "/a"), ws("wB", "/b"), ws("wC", "/c")], cfg, log, glab);
    expect(summary).toMatchObject({ reported: 2, cleared: 1, aborted: null });
    expect(warnings.some((w) => w.includes("kaboom"))).toBe(true);
    expect(herdrCalls().map((c) => c[2])).toEqual(["wA", "wB", "wC"]);
  });

  test("herdr rejecting a report counts as failed but the loop continues", async () => {
    process.env.FAKE_HERDR_FAIL = "1";
    try {
      const glab = fakeGlab({ "/a": { branch: "a", mrs: { a: mr(1) } }, "/b": { branch: "main" } });
      const summary = await refreshWorkspaces([ws("wA", "/a"), ws("wB", "/b")], cfg, silentLogger, glab);
      expect(summary).toMatchObject({ reported: 0, cleared: 0, failed: 2 });
      expect(herdrCalls()).toHaveLength(2);
    } finally {
      delete process.env.FAKE_HERDR_FAIL;
    }
  });
});

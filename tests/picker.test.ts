import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import type { CommandResult } from "../src/exec";
import type { GlabClient } from "../src/glab";
import type { Workspace } from "../src/herdr";
import { silentLogger, type Logger } from "../src/log";
import { attentionScore, collectRows, formatRows, sortRows, type MrRow } from "../src/picker";

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
  discussions?: unknown[][];
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
      ...extra,
    }),
  );
}

function approvals(given: number, required: number): CommandResult {
  return ok(JSON.stringify({ approvals_required: required, approved_by: Array.from({ length: given }, () => ({})) }));
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
      return repos[cwd]?.mrs?.[ref] ?? fail('No open merge request available for "x".');
    },
    async discussionsPage(_projectId, _iid, page, _perPage, cwd) {
      calls.push(`discussions p${page} @${cwd}`);
      const repo = repos[cwd];
      return ok(JSON.stringify(repo?.discussions?.[page - 1] ?? []));
    },
    async approvals(_projectId, _iid, cwd) {
      calls.push(`approvals @${cwd}`);
      return repos[cwd]?.approvals ?? fail("not found");
    },
  };
}

const ws = (id: string, path: string): Workspace => ({ workspaceId: id, label: id, checkoutPath: path });
const cfg: Config = { ...DEFAULT_CONFIG };

// ---------- collectRows ----------

describe("collectRows", () => {
  test("builds a row per open MR, skipping workspaces with no MR", async () => {
    const glab = fakeGlab({
      "/a": { branch: "feat/a", mrs: { "feat/a": mr(10, { title: "Add widget" }) }, approvals: approvals(1, 2) },
      "/b": { branch: "main" },
    });
    const { rows, aborted } = await collectRows([ws("wA", "/a"), ws("wB", "/b")], cfg, silentLogger, glab);
    expect(aborted).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: "wA",
      iid: 10,
      title: "Add widget",
      approvals: { given: 1, required: 2 },
      webUrl: "https://gl/mr/10",
    });
  });

  test("onProgress fires exactly once per workspace (order not guaranteed: workspaces run concurrently)", async () => {
    const glab = fakeGlab({
      "/a": { branch: "b", mrs: { b: mr(1) } },
      "/c": { branch: "d", mrs: { d: UNAUTHORIZED } },
    });
    glab.currentBranch = async (cwd) => {
      if (cwd === "/z") throw new Error("kaboom");
      return { "/a": "b", "/c": "d" }[cwd] ?? null;
    };
    const seenLabels: string[] = [];
    const seenIndices: number[] = [];
    await collectRows([ws("wA", "/a"), ws("wZ", "/z"), ws("wC", "/c")], cfg, silentLogger, glab, (workspace, i, total) => {
      seenLabels.push(workspace.label);
      seenIndices.push(i);
      expect(total).toBe(3);
    });
    expect(seenLabels.sort()).toEqual(["wA", "wC", "wZ"]);
    expect(seenIndices.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test("skips merged/closed MRs", async () => {
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1, { state: "merged" }) } } });
    const { rows } = await collectRows([ws("wA", "/a")], cfg, silentLogger, glab);
    expect(rows).toHaveLength(0);
  });

  test("a workspace with a transient glab failure contributes no row but doesn't stop the walk", async () => {
    const glab = fakeGlab({
      "/a": { branch: "b", mrs: { b: fail("dial tcp: no such host") } },
      "/b": { branch: "c", mrs: { c: mr(2) } },
    });
    const { rows, aborted } = await collectRows([ws("wA", "/a"), ws("wB", "/b")], cfg, silentLogger, glab);
    expect(aborted).toBe(false);
    expect(rows.map((r) => r.iid)).toEqual([2]);
  });

  test("an abort (auth failure) is reported once, not thrown, without discarding other workspaces' rows", async () => {
    const glab = fakeGlab({
      "/a": { branch: "b", mrs: { b: mr(1) } },
      "/b": { branch: "c", mrs: { c: UNAUTHORIZED } },
      "/c": { branch: "d", mrs: { d: mr(3) } },
    });
    const errors: string[] = [];
    const log: Logger = { ...silentLogger, error: (m) => errors.push(m) };
    const { rows, aborted } = await collectRows([ws("wA", "/a"), ws("wB", "/b"), ws("wC", "/c")], cfg, log, glab);
    expect(aborted).toBe(true);
    // wA and wC's own calls succeeded independently of wB's auth failure —
    // everything runs concurrently, so there's nothing to gain (and a
    // successful result to lose) by discarding them.
    expect(rows.map((r) => r.iid)).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });

  test("a missing approvals method or a failed approvals call yields null, not a dropped row", async () => {
    const glab = fakeGlab({ "/a": { branch: "b", mrs: { b: mr(1) } } }); // no `approvals` fixture → fail("not found")
    const { rows } = await collectRows([ws("wA", "/a")], cfg, silentLogger, glab);
    expect(rows[0]?.approvals).toBeNull();

    const noApprovalsMethod: GlabClient = {
      currentBranch: async () => "b",
      mrView: async () => mr(1),
      discussionsPage: async () => ok("[]"),
    };
    const { rows: rows2 } = await collectRows([ws("wA", "/a")], cfg, silentLogger, noApprovalsMethod);
    expect(rows2[0]?.approvals).toBeNull();
  });

  test("a throwing glab client for one workspace is skipped and logged, not thrown", async () => {
    const glab = fakeGlab({ "/b": { branch: "c", mrs: { c: mr(2) } } });
    glab.currentBranch = async (cwd) => {
      if (cwd === "/a") throw new Error("kaboom");
      return "c";
    };
    const warnings: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
    const { rows } = await collectRows([ws("wA", "/a"), ws("wB", "/b")], cfg, log, glab);
    expect(rows.map((r) => r.iid)).toEqual([2]);
    expect(warnings.some((w) => w.includes("kaboom"))).toBe(true);
  });
});

// ---------- attentionScore / sortRows ----------

function row(overrides: Partial<MrRow> = {}): MrRow {
  return {
    workspace: ws("w", "/w"),
    repo: "repo",
    iid: 1,
    title: "t",
    draft: false,
    pipelineStatus: null,
    unresolved: null,
    comments: null,
    approvals: null,
    webUrl: null,
    ...overrides,
  };
}

describe("attentionScore", () => {
  test("a failed pipeline outranks everything else", () => {
    const failed = row({ pipelineStatus: "failed" });
    const busy = row({ unresolved: 20, approvals: { given: 0, required: 5 } });
    expect(attentionScore(failed)).toBeGreaterThan(attentionScore(busy));
  });

  test("unresolved threads and missing approvals raise the score", () => {
    expect(attentionScore(row({ unresolved: 3 }))).toBeGreaterThan(attentionScore(row()));
    expect(attentionScore(row({ approvals: { given: 0, required: 2 } }))).toBeGreaterThan(
      attentionScore(row({ approvals: { given: 2, required: 2 } })),
    );
  });

  test("a draft sinks below a plain clean MR", () => {
    expect(attentionScore(row({ draft: true }))).toBeLessThan(attentionScore(row()));
  });
});

describe("sortRows", () => {
  test("most attention-needing first, ties broken by comments then title", () => {
    const clean = row({ iid: 1, title: "b clean", comments: 1 });
    const failed = row({ iid: 2, title: "a failed", pipelineStatus: "failed" });
    const tiedHigh = row({ iid: 3, title: "z tied", comments: 5 });
    const tiedLow = row({ iid: 4, title: "a tied", comments: 5 });
    expect(sortRows([clean, failed, tiedHigh, tiedLow]).map((r) => r.iid)).toEqual([2, 4, 3, 1]);
  });
});

// ---------- formatRows ----------

describe("formatRows", () => {
  test("columns are aligned and an index prefix is added for fzf", () => {
    const rows = [
      row({ iid: 581, repo: "catalog-ui", title: "feat: update catalog", pipelineStatus: "failed", approvals: { given: 1, required: 3 }, unresolved: 1, comments: 4 }),
      row({ iid: 622, repo: "landing-ui", title: "chore: e2e", pipelineStatus: "success", approvals: { given: 2, required: 3 }, comments: 53 }),
    ];
    const { header, lines } = formatRows(rows);
    expect(header.startsWith("REPO")).toBe(true);
    expect(header).toContain("TITLE");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("0\t")).toBe(true);
    expect(lines[1]!.startsWith("1\t")).toBe(true);
    expect(lines[0]).toContain("!581");
    expect(lines[0]).toContain("✖ failed");
    expect(lines[0]).toContain("1/3");
    expect(lines[0]).toContain("feat: update catalog");
    // Both REPO cells are padded to the same width.
    const repoColWidth = (line: string) => line.split("\t")[1]!.indexOf("  ");
    expect(repoColWidth(lines[0]!)).toBe(repoColWidth(lines[1]!));
  });

  test("cells fall back to '-' or '?' for missing data", () => {
    const { lines } = formatRows([row({ unresolved: null, comments: null, approvals: null, pipelineStatus: null })]);
    const visible = lines[0]!.split("\t")[1]!;
    expect(visible).toContain("?"); // approvals unknown
    // THR and CMT both render as "-" for null/zero data.
    expect(visible.split(/\s{2,}/).filter((c) => c === "-").length).toBeGreaterThanOrEqual(2);
  });

  test("a draft MR's title is prefixed", () => {
    const { lines } = formatRows([row({ draft: true, title: "wip" })]);
    expect(lines[0]).toContain("[draft] wip");
  });

  test("empty input yields a header with no lines", () => {
    const { header, lines } = formatRows([]);
    expect(header).toContain("REPO");
    expect(lines).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTERS } from "../src/board-filters";
import type { BoardRow } from "../src/board";
import type { WorkspaceStatus } from "../src/herdr";
import { applyFilters, attentionScore, formatPreview, formatRows, sortRows } from "../src/picker";

function row(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    workspaceId: "w",
    checkoutPath: "/w",
    repo: "repo",
    repoName: "repo",
    iid: 1,
    title: "t",
    draft: false,
    pipelineStatus: null,
    unresolved: null,
    comments: null,
    approvals: null,
    webUrl: null,
    branch: "b",
    createdAt: null,
    authorUsername: null,
    ...overrides,
  };
}

describe("applyFilters", () => {
  test("draftsOnly=true narrows down to drafts; default shows everything", () => {
    const rows = [row({ iid: 1, draft: true }), row({ iid: 2, draft: false })];
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, draftsOnly: true }, null).map((r) => r.iid)).toEqual([1]);
    expect(applyFilters(rows, DEFAULT_FILTERS, null).map((r) => r.iid)).toEqual([1, 2]);
  });

  test("mineOnly keeps only rows authored by the current user", () => {
    const rows = [row({ iid: 1, authorUsername: "me" }), row({ iid: 2, authorUsername: "them" })];
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, mineOnly: true }, "me").map((r) => r.iid)).toEqual([1]);
  });

  test("mineOnly with no known current user is a no-op, not 'hide everything'", () => {
    const rows = [row({ iid: 1, authorUsername: "them" })];
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, mineOnly: true }, null)).toHaveLength(1);
  });

  test("scopeRepo keeps only rows in that repo", () => {
    const rows = [row({ iid: 1, repoName: "a" }), row({ iid: 2, repoName: "b" })];
    expect(applyFilters(rows, { ...DEFAULT_FILTERS, scopeRepo: "a" }, null).map((r) => r.iid)).toEqual([1]);
  });
});

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

describe("formatRows", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");

  test("columns are aligned and an index prefix is added for fzf", () => {
    const rows = [
      row({
        iid: 581,
        repo: "catalog-ui",
        title: "feat: update catalog",
        pipelineStatus: "failed",
        approvals: { given: 1, required: 3 },
        unresolved: 1,
        comments: 4,
        createdAt: "2026-09-09T11:38:00Z",
      }),
      row({
        iid: 622,
        repo: "landing-ui",
        title: "chore: e2e",
        pipelineStatus: "success",
        approvals: { given: 2, required: 3 },
        comments: 53,
        createdAt: "2026-09-06T12:00:00Z",
      }),
    ];
    const { header, lines } = formatRows(rows, now);
    expect(header.startsWith("REPO")).toBe(true);
    expect(header).toContain("TITLE");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith("0\t")).toBe(true);
    expect(lines[1]!.startsWith("1\t")).toBe(true);
    expect(lines[0]).toContain("!581");
    expect(lines[0]).toContain("✖ failed");
    expect(lines[0]).toContain("1/3");
    expect(lines[0]).toContain("22m"); // 22 minutes before `now`
    expect(lines[1]).toContain("3d");
    expect(lines[0]).toContain("feat: update catalog");
  });

  test("cells fall back to '-' or '?' for missing data", () => {
    const { lines } = formatRows([row({ unresolved: null, comments: null, approvals: null, pipelineStatus: null, createdAt: null })], now);
    const visible = lines[0]!;
    expect(visible).toContain("?"); // approvals and age unknown
    expect(visible).toContain("-"); // THR and CMT
  });

  test("a draft MR's title is prefixed", () => {
    const { lines } = formatRows([row({ draft: true, title: "wip" })], now);
    expect(lines[0]).toContain("[draft]");
    expect(lines[0]).toContain("wip");
  });

  test("cells are colored: green/red/yellow by status, dim for context, reset after each", () => {
    const failed = formatRows([row({ pipelineStatus: "failed", approvals: { given: 0, required: 2 }, unresolved: 3, comments: 1 })], now)
      .lines[0]!;
    expect(failed).toContain("\x1b[31m"); // CI red (failed) and THR red (unresolved > 0)
    expect(failed).toContain("\x1b[33m"); // APPR yellow (missing approvals)
    expect(failed).toContain("\x1b[2m"); // CMT/AGE dim
    expect(failed).toContain("\x1b[36m"); // REPO cyan
    expect(failed).toContain("\x1b[0m"); // reset after every colored cell

    const clean = formatRows([row({ pipelineStatus: "success", approvals: { given: 2, required: 2 }, unresolved: 0 })], now).lines[0]!;
    expect(clean).toContain("\x1b[32m"); // CI green (success) and APPR green (fully approved)
  });

  test("empty input yields a header with no lines", () => {
    const { header, lines } = formatRows([], now);
    expect(header).toContain("REPO");
    expect(lines).toEqual([]);
  });
});

describe("formatPreview", () => {
  const status: WorkspaceStatus = { agentStatus: "working", paneCount: 2, tabCount: 1, focused: true };

  test("is workspace-only: identity + live herdr state, no MR content at all", () => {
    const text = formatPreview(
      row({
        workspaceId: "wD",
        checkoutPath: "/Users/me/code/ngc-auth/.claude/worktrees/kubb-api-2",
        repo: "kubb-api-2",
        repoName: "ngc-auth",
        branch: "feat/kubb-api-stack",
        iid: 13,
        title: "feat!: rebuild on the kubb-api-* stack",
      }),
      status,
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("kubb-api-2  (workspace wD)");
    expect(lines[1]).toBe("ngc-auth · feat/kubb-api-stack");
    expect(lines[2]).toBe("/Users/me/code/ngc-auth/.claude/worktrees/kubb-api-2");
    expect(text).toContain("agent      working");
    expect(text).toContain("panes      2   tabs   1");
    expect(text).toContain("focused    yes");
    // Nothing MR-specific: the row you highlighted to get here already
    // shows the MR number, title, CI, approvals, threads, comments, age.
    expect(text).not.toContain("!13");
    expect(text).not.toContain("rebuild on the kubb-api");
    expect(text).not.toContain("approvals");
    expect(text).not.toContain("comments");
  });

  test("null status (herdr workspace get failed) reads '?' for every workspace-state line, not blank", () => {
    const text = formatPreview(row({ repoName: null }), null);
    expect(text).toContain("agent      ?");
    expect(text).toContain("panes      ?   tabs   ?");
    expect(text).toContain("focused    ?");
  });
});

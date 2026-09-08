import { describe, expect, test } from "bun:test";
import { formatLabel, parseMrView, pipelineSymbol } from "../src/label";

const base = { iid: 575, state: "opened", draft: false, pipelineStatus: null as string | null };

describe("formatLabel", () => {
  test("bare open MR with no pipeline and no unresolved threads", () => {
    expect(formatLabel(base, 0)).toBe("!575");
    expect(formatLabel(base, null)).toBe("!575");
  });

  test("success pipeline with unresolved threads", () => {
    expect(formatLabel({ ...base, pipelineStatus: "success" }, 2)).toBe("!575 ✔ ✎2");
  });

  test("draft with running pipeline", () => {
    expect(formatLabel({ ...base, iid: 67, draft: true, pipelineStatus: "running" }, 0)).toBe("!67 draft ↻");
  });

  test("merged and closed states", () => {
    expect(formatLabel({ ...base, state: "merged", pipelineStatus: "success" }, 0)).toBe("!575 merged ✔");
    expect(formatLabel({ ...base, state: "closed" }, 3)).toBe("!575 closed ✎3");
  });

  test("draft precedes state, state precedes pipeline, unresolved last", () => {
    expect(formatLabel({ ...base, draft: true, state: "closed", pipelineStatus: "failed" }, 1)).toBe(
      "!575 draft closed ✖ ✎1",
    );
  });

  test("omits ✎ for zero, negative, or non-finite counts", () => {
    expect(formatLabel(base, 0)).toBe("!575");
    expect(formatLabel(base, -1)).toBe("!575");
    expect(formatLabel(base, Number.NaN)).toBe("!575");
  });

  test("unknown pipeline status yields no symbol", () => {
    expect(formatLabel({ ...base, pipelineStatus: "something_new" }, 0)).toBe("!575");
  });
});

describe("pipelineSymbol", () => {
  test.each([
    ["success", "✔"],
    ["failed", "✖"],
    ["running", "↻"],
    ["pending", "⋯"],
    ["created", "⋯"],
    ["waiting_for_resource", "⋯"],
    ["preparing", "⋯"],
    ["canceled", "⊘"],
    ["skipped", "⊘"],
    ["manual", "⚙"],
  ])("%s → %s", (status, symbol) => {
    expect(pipelineSymbol(status)).toBe(symbol);
  });

  test("null/undefined/empty → no symbol", () => {
    expect(pipelineSymbol(null)).toBe("");
    expect(pipelineSymbol(undefined)).toBe("");
    expect(pipelineSymbol("")).toBe("");
  });
});

describe("parseMrView", () => {
  test("extracts the fields the label needs", () => {
    const json = JSON.stringify({
      iid: 67,
      state: "opened",
      draft: true,
      project_id: 272587,
      web_url: "https://gitlab.example.com/g/p/-/merge_requests/67",
      head_pipeline: { status: "running", id: 1 },
      title: "feat: add widget",
      user_notes_count: 4,
    });
    expect(parseMrView(json)).toEqual({
      iid: 67,
      state: "opened",
      draft: true,
      pipelineStatus: "running",
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/67",
      projectId: 272587,
      title: "feat: add widget",
      commentCount: 4,
    });
  });

  test("tolerates a missing pipeline, title, and comment count", () => {
    const mr = parseMrView(JSON.stringify({ iid: 1, state: "merged", draft: false, head_pipeline: null }));
    expect(mr?.pipelineStatus).toBeNull();
    expect(mr?.state).toBe("merged");
    expect(mr?.title).toBe("");
    expect(mr?.commentCount).toBeNull();
  });

  test("rejects non-MR payloads", () => {
    expect(parseMrView("")).toBeNull();
    expect(parseMrView("not json")).toBeNull();
    expect(parseMrView("[]")).toBeNull();
    expect(parseMrView(JSON.stringify({ message: "404 Not Found" }))).toBeNull();
  });
});

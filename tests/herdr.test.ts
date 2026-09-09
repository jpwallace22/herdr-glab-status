import { describe, expect, test } from "bun:test";
import { resolveEventWorkspaceId } from "../src/events";
import { parseWorkspaces } from "../src/herdr";

const listPayload = {
  id: "cli:workspace:list",
  result: {
    type: "workspace_list",
    workspaces: [
      { workspace_id: "wM", label: "scratch", pane_count: 1 },
      {
        workspace_id: "wH",
        label: "landing-ui",
        worktree: { checkout_path: "/Users/me/code/landing-ui", is_linked_worktree: false, repo_name: "landing-ui" },
        tokens: { mr: "!581 ✖ ✎1" },
      },
      { workspace_id: "wX", label: "broken", worktree: { checkout_path: "" } },
      { workspace_id: "", label: "no-id", worktree: { checkout_path: "/tmp/x" } },
    ],
  },
};

describe("parseWorkspaces", () => {
  test("keeps only workspaces with a checkout path, and carries the $mr token + repo name", () => {
    expect(parseWorkspaces(listPayload)).toEqual([
      {
        workspaceId: "wH",
        label: "landing-ui",
        checkoutPath: "/Users/me/code/landing-ui",
        mrToken: "!581 ✖ ✎1",
        repoName: "landing-ui",
      },
    ]);
  });

  test("no tokens.mr/repo_name (or empty ones) are null, not undefined or ''", () => {
    const payload = { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: "/a" } }] };
    expect(parseWorkspaces(payload)).toEqual([{ workspaceId: "w1", label: "w1", checkoutPath: "/a", mrToken: null, repoName: null }]);
    const empty = { workspaces: [{ workspace_id: "w1", worktree: { checkout_path: "/a", repo_name: "" }, tokens: { mr: "" } }] };
    expect(parseWorkspaces(empty)[0]?.mrToken).toBeNull();
    expect(parseWorkspaces(empty)[0]?.repoName).toBeNull();
  });

  test("accepts the workspace get payload", () => {
    const payload = {
      result: { type: "workspace_info", workspace: { workspace_id: "wG", label: "g", worktree: { checkout_path: "/p" } } },
    };
    expect(parseWorkspaces(payload)).toEqual([{ workspaceId: "wG", label: "g", checkoutPath: "/p", mrToken: null, repoName: null }]);
  });

  test("accepts a bare array and tolerates junk", () => {
    expect(parseWorkspaces([{ workspace_id: "w1", worktree: { checkout_path: "/a" } }, null, 3])).toEqual([
      { workspaceId: "w1", label: "w1", checkoutPath: "/a", mrToken: null, repoName: null },
    ]);
    expect(parseWorkspaces(null)).toEqual([]);
    expect(parseWorkspaces("nope")).toEqual([]);
    expect(parseWorkspaces({ result: {} })).toEqual([]);
  });
});

describe("resolveEventWorkspaceId", () => {
  test("prefers HERDR_WORKSPACE_ID", () => {
    expect(resolveEventWorkspaceId({ HERDR_WORKSPACE_ID: "wA", HERDR_PLUGIN_EVENT_JSON: '{"workspace_id":"wB"}' })).toBe("wA");
  });

  test("falls back to the event payload in several shapes", () => {
    expect(resolveEventWorkspaceId({ HERDR_PLUGIN_EVENT_JSON: '{"workspace_id":"wB"}' })).toBe("wB");
    expect(resolveEventWorkspaceId({ HERDR_PLUGIN_EVENT_JSON: '{"workspace":{"workspace_id":"wC"}}' })).toBe("wC");
    expect(resolveEventWorkspaceId({ HERDR_PLUGIN_EVENT_JSON: '{"pane":{"workspace_id":"wD"}}' })).toBe("wD");
  });

  test("then the context payload", () => {
    expect(resolveEventWorkspaceId({ HERDR_PLUGIN_CONTEXT_JSON: '{"workspace":{"workspace_id":"wE"}}' })).toBe("wE");
  });

  test("returns null when nothing identifies a workspace", () => {
    expect(resolveEventWorkspaceId({})).toBeNull();
    expect(resolveEventWorkspaceId({ HERDR_WORKSPACE_ID: "" })).toBeNull();
    expect(resolveEventWorkspaceId({ HERDR_PLUGIN_EVENT_JSON: "not json" })).toBeNull();
    expect(resolveEventWorkspaceId({ HERDR_PLUGIN_EVENT_JSON: '{"worktree":{"path":"/x"}}' })).toBeNull();
  });
});

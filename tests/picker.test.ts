import { describe, expect, test } from "bun:test";
import type { Workspace } from "../src/herdr";
import { attentionScore, collectRows, formatRows, sortRows, type MrRow } from "../src/picker";

const ws = (label: string, mrToken: string | null): Workspace => ({
  workspaceId: label,
  label,
  checkoutPath: `/${label}`,
  mrToken,
});

describe("collectRows", () => {
  test("one row per workspace with an open MR token", () => {
    const rows = collectRows([ws("catalog-ui", "!581 ✖ ✎1"), ws("landing-ui", "!622 ✔")]);
    expect(rows).toEqual([
      { workspace: ws("catalog-ui", "!581 ✖ ✎1"), repo: "catalog-ui", token: "!581 ✖ ✎1" },
      { workspace: ws("landing-ui", "!622 ✔"), repo: "landing-ui", token: "!622 ✔" },
    ]);
  });

  test("workspaces with no token (null, or the field absent) are skipped", () => {
    const noField: Workspace = { workspaceId: "w", label: "w", checkoutPath: "/w" };
    expect(collectRows([ws("a", null), noField])).toEqual([]);
  });

  test("merged and closed MRs are skipped, not just any token", () => {
    expect(collectRows([ws("a", "!9 merged ✔"), ws("b", "!5 closed"), ws("c", "!5 closed ✎2")])).toEqual([]);
  });

  test("a draft, open MR is kept (draft is not merged/closed)", () => {
    const rows = collectRows([ws("a", "!66 draft ✔")]);
    expect(rows).toHaveLength(1);
  });
});

describe("attentionScore", () => {
  const row = (token: string): MrRow => ({ workspace: ws("w", token), repo: "w", token });

  test("a failed pipeline outranks unresolved threads and missing approvals combined", () => {
    expect(attentionScore(row("!1 ✖"))).toBeGreaterThan(attentionScore(row("!2 ✎20")));
  });

  test("more unresolved threads score higher", () => {
    expect(attentionScore(row("!1 ✎5"))).toBeGreaterThan(attentionScore(row("!1 ✎1")));
    expect(attentionScore(row("!1 ✎1"))).toBeGreaterThan(attentionScore(row("!1")));
  });

  test("a draft sinks below a plain clean MR", () => {
    expect(attentionScore(row("!1 draft"))).toBeLessThan(attentionScore(row("!1")));
  });

  test("a running pipeline scores a little above a plain clean MR", () => {
    expect(attentionScore(row("!1 ↻"))).toBeGreaterThan(attentionScore(row("!1")));
  });
});

describe("sortRows", () => {
  test("most attention-needing first, ties broken by repo name", () => {
    const clean = { workspace: ws("b-clean", "!1"), repo: "b-clean", token: "!1" };
    const failed = { workspace: ws("a-failed", "!2 ✖"), repo: "a-failed", token: "!2 ✖" };
    const tiedHigh = { workspace: ws("z-tied", "!3 ✎5"), repo: "z-tied", token: "!3 ✎5" };
    const tiedLow = { workspace: ws("a-tied", "!4 ✎5"), repo: "a-tied", token: "!4 ✎5" };
    expect(sortRows([clean, failed, tiedHigh, tiedLow]).map((r) => r.repo)).toEqual(["a-failed", "a-tied", "z-tied", "b-clean"]);
  });
});

describe("formatRows", () => {
  test("REPO is padded to the widest label; the token is appended as-is", () => {
    const rows = collectRows([ws("catalog-ui", "!581 ✖ ✎1"), ws("ui", "!622 ✔")]);
    const { header, lines } = formatRows(rows);
    expect(header).toBe("REPO        MR");
    expect(lines[0]).toBe("0\tcatalog-ui  !581 ✖ ✎1");
    expect(lines[1]).toBe("1\tui          !622 ✔");
  });

  test("empty input yields a header with no lines", () => {
    const { header, lines } = formatRows([]);
    expect(header).toBe("REPO  MR");
    expect(lines).toEqual([]);
  });
});

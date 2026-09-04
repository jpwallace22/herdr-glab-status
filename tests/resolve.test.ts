import { describe, expect, test } from "bun:test";
import { mrRefArg, normalizeBranch, resolveMrRef } from "../src/resolve";

describe("resolveMrRef", () => {
  test("ordinary branches resolve by source branch", () => {
    expect(resolveMrRef("feat/kubb-api-stack")).toEqual({ kind: "branch", branch: "feat/kubb-api-stack" });
    expect(mrRefArg(resolveMrRef("chore_ngc-auth-bump"))).toBe("chore_ngc-auth-bump");
  });

  test("scratch review checkouts resolve by iid", () => {
    expect(resolveMrRef("mr-575-review")).toEqual({ kind: "iid", iid: 575 });
    expect(mrRefArg(resolveMrRef("mr-575-review"))).toBe("575");
  });

  test("near-misses of the scratch pattern stay branches", () => {
    for (const branch of ["mr-575-review-2", "mr-575", "mr--review", "mr-abc-review", "xmr-1-review", "MR-1-review"]) {
      expect(resolveMrRef(branch)).toEqual({ kind: "branch", branch });
    }
  });

  test("a zero iid is not a valid scratch reference", () => {
    expect(resolveMrRef("mr-0-review")).toEqual({ kind: "branch", branch: "mr-0-review" });
  });
});

describe("normalizeBranch", () => {
  test("trims and passes through branch names", () => {
    expect(normalizeBranch("main\n")).toBe("main");
  });

  test("detached HEAD and empty output become null", () => {
    expect(normalizeBranch("")).toBeNull();
    expect(normalizeBranch("\n")).toBeNull();
    expect(normalizeBranch("HEAD")).toBeNull();
    expect(normalizeBranch(null)).toBeNull();
    expect(normalizeBranch(undefined)).toBeNull();
  });
});

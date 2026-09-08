import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../src/exec";
import { briefError, classifyFailure } from "../src/glab";

function failed(stderr: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr, spawnError: null, timedOut: false, ...extra };
}

describe("classifyFailure", () => {
  test("no open MR for the branch", () => {
    expect(classifyFailure(failed('\n ERROR \n\n No open merge request available for "feat/x".\n'))).toBe("no_mr");
  });

  test("unknown iid (404)", () => {
    expect(classifyFailure(failed("GET https://gitlab.example.com/api/v4/projects/1/merge_requests/9999: 404 {message: 404 Not found}"))).toBe(
      "no_mr",
    );
  });

  test("authentication problems", () => {
    expect(classifyFailure(failed("GET https://gitlab.example.com/api/v4/user: 401 {message: 401 Unauthorized}"))).toBe("auth");
    expect(classifyFailure(failed("You are not logged in to any GitLab hosts. Run glab auth login to authenticate."))).toBe("auth");
    expect(classifyFailure(failed("error: invalid token"))).toBe("auth");
  });

  test("a missing binary", () => {
    expect(classifyFailure(failed("", { exitCode: null, spawnError: "spawn glab ENOENT" }))).toBe("missing");
  });

  test("checkout whose remote isn't GitLab (e.g. GitHub) is no_mr, not auth", () => {
    // glab's own message tells the user to `glab auth login`, but this isn't
    // an auth failure — the checkout just has no GitLab remote at all.
    const text =
      "None of the git remotes configured for this repository point to a known GitLab host. Please use `glab auth login` to tell glab which remote to use.";
    expect(classifyFailure(failed(text))).toBe("no_mr");
  });

  test("everything else (network, project resolution) is 'other'", () => {
    expect(classifyFailure(failed("dial tcp: lookup gitlab.example.com: no such host"))).toBe("other");
    expect(classifyFailure(failed("x509: certificate signed by unknown authority"))).toBe("other");
    expect(classifyFailure(failed("", { timedOut: true }))).toBe("other");
    expect(classifyFailure(failed(""))).toBe("other");
  });
});

describe("briefError", () => {
  test("skips glab's bare ERROR banner and blank lines", () => {
    expect(briefError(failed('\n   ERROR  \n\n  No open merge request available for "x".\n'))).toBe(
      'No open merge request available for "x".',
    );
  });

  test("reports spawn errors and timeouts", () => {
    expect(briefError(failed("", { spawnError: "spawn glab ENOENT" }))).toBe("spawn glab ENOENT");
    expect(briefError(failed("", { timedOut: true }))).toBe("timed out");
  });

  test("falls back to the exit code", () => {
    expect(briefError(failed("", { exitCode: 3 }))).toBe("exit 3");
  });
});

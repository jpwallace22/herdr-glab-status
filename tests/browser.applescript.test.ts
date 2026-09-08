// Real, non-mocked execution of the AppleScript in src/browser.ts —
// browser.test.ts mocks the script's execution, so it can't catch a broken
// *runtime* property access. Skipped automatically outside macOS or where
// osascript/osacompile aren't installed, so it never affects `bun test`'s
// "no network, no herdr needed" guarantee on Linux or CI without Xcode
// command line tools.
//
// Still can't catch: whether a property referenced here (e.g. `active tab
// index`) actually exists on a real, running browser's dictionary —
// `osacompile` only checks syntax, and normalizeUrl only exercises
// app-independent string logic. That needs the real app installed and
// running. See src/browser.ts for how the scripts are structured so a
// property like that failing leaves a tab unfocused rather than duplicated.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_BROWSERS, NORMALIZE_URL, scriptInvocation } from "../src/browser";
import { runCommand } from "../src/exec";

const hasOsascript = process.platform === "darwin" && Bun.which("osascript") !== null;
const hasOsacompile = process.platform === "darwin" && Bun.which("osacompile") !== null;

// Chrome/Brave/Edge's scripts compile only against an app that's actually
// installed (the compiler resolves `active tab index` from that app's
// dictionary at compile time — see src/browser.ts), so each is checked only
// if it's actually there; asserting all three unconditionally would make
// this suite depend on the machine, not the code. Arc's script doesn't need
// Arc installed to compile (its properties are single words), so it isn't
// gated this way.
function isInstalled(app: string): boolean {
  return existsSync(`/Applications/${app}.app`) || existsSync(join(homedir(), "Applications", `${app}.app`));
}

async function runNormalizeUrl(input: string): Promise<string> {
  const harness = `${NORMALIZE_URL}\non run argv\n  return normalizeUrl(item 1 of argv)\nend run\n`;
  const result = await runCommand(["osascript", "-e", harness, "--", input], { timeoutMs: 5_000 });
  if (!result.ok) throw new Error(`osascript failed: ${result.stderr || result.exitCode}`);
  return result.stdout.trim();
}

describe.skipIf(!hasOsascript)("normalizeUrl (real osascript execution, darwin only)", () => {
  test("leaves a clean URL unchanged", async () => {
    expect(await runNormalizeUrl("https://gitlab.example.com/g/p/-/merge_requests/1")).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/1",
    );
  });

  test("strips a trailing slash", async () => {
    expect(await runNormalizeUrl("https://gitlab.example.com/g/p/-/merge_requests/1/")).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/1",
    );
  });

  test("strips a query string", async () => {
    expect(await runNormalizeUrl("https://gitlab.example.com/g/p/-/merge_requests/1?tab=diffs")).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/1",
    );
  });

  test("strips a fragment", async () => {
    expect(await runNormalizeUrl("https://gitlab.example.com/g/p/-/merge_requests/1#note_123")).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/1",
    );
  });

  test("strips a fragment that itself contains a query-like string", async () => {
    expect(await runNormalizeUrl("https://gitlab.example.com/g/p/-/merge_requests/1#note_123?x=1")).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/1",
    );
  });
});

describe.skipIf(!hasOsacompile)("generated scripts actually compile (real osacompile, darwin only)", () => {
  const url = "https://gitlab.example.com/g/p/-/merge_requests/1";

  function assertCompiles(script: string) {
    const dir = mkdtempSync(join(tmpdir(), "glab-status-osacompile-"));
    try {
      const source = join(dir, "script.applescript");
      const compiled = join(dir, "script.scpt");
      writeFileSync(source, script);
      const result = Bun.spawnSync(["osacompile", "-o", compiled, source]);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const app of CHROMIUM_BROWSERS) {
    test.skipIf(!isInstalled(app))(`${app}'s script compiles`, () => {
      assertCompiles(scriptInvocation(app, url).script);
    });
  }

  test("Arc's script compiles", () => {
    assertCompiles(scriptInvocation("Arc", url).script);
  });
});

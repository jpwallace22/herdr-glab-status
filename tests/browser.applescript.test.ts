// Every test in browser.test.ts mocks the AppleScript's execution — none of
// them run the actual script. That's how a broken *runtime* property access
// (Chrome erroring on an unsupported property) shipped with a fully green
// `bun test`: the mock always says "it worked", regardless of what the real
// script does.
//
// This file closes part of that gap by actually invoking `osascript` /
// `osacompile` — no mocking — skipped automatically outside macOS or where
// they aren't installed, so it never affects `bun test`'s "no network, no
// herdr needed" guarantee on Linux or CI without Xcode command line tools.
//
// What this still can NOT catch: whether a property this script references
// (e.g. `active tab index`) actually exists on a real, running browser's
// AppleScript dictionary. `osacompile` only checks syntax; `osascript`
// against `normalizeUrl` only exercises app-independent string logic.
// Verifying an app-specific property genuinely requires that app installed
// and running, which isn't available in an automated test environment here
// — see src/browser.ts's `chromiumScript`/`ARC_SCRIPT` comments for how the
// scripts are structured so a property like that failing can, at worst,
// leave a matched tab unfocused, and can no longer flip "reused" into
// "opened".

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CHROMIUM_BROWSERS, NORMALIZE_URL, scriptInvocation } from "../src/browser";
import { runCommand } from "../src/exec";

const hasOsascript = process.platform === "darwin" && Bun.which("osascript") !== null;
const hasOsacompile = process.platform === "darwin" && Bun.which("osacompile") !== null;

// Chrome/Brave/Edge's scripts compile only against an app that's actually
// installed (their compiler resolves `active tab index` from that specific
// app's dictionary at compile time — see src/browser.ts). Asserting they all
// compile unconditionally would make this suite depend on which of the three
// happen to be on the machine running it, which is not a property of the
// code. Each is checked only if it's actually there. Arc's script doesn't
// need Arc installed to compile (its properties are single words, not
// dictionary-resolved), so it isn't gated this way.
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

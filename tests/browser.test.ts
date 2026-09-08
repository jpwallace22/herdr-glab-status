import { describe, expect, test } from "bun:test";
import {
  CHROMIUM_BROWSERS,
  focusOrOpenTab,
  isSupportedBrowser,
  resolveBrowserApp,
  scriptInvocation,
  SUPPORTED_BROWSERS,
  type SupportedBrowser,
} from "../src/browser";
import type { CommandResult } from "../src/exec";
import type { Logger } from "../src/log";

function ok(stdout = ""): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", spawnError: null, timedOut: false };
}

function failed(stderr = ""): CommandResult {
  return { ok: false, exitCode: 1, stdout: "", stderr, spawnError: null, timedOut: false };
}

function recordingLogger(): { log: Logger; debugLines: string[] } {
  const debugLines: string[] = [];
  return {
    debugLines,
    log: { debug: (m) => debugLines.push(m), info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("isSupportedBrowser", () => {
  test("accepts the known apps", () => {
    for (const app of SUPPORTED_BROWSERS) expect(isSupportedBrowser(app)).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isSupportedBrowser("Firefox")).toBe(false);
    expect(isSupportedBrowser("Safari")).toBe(false);
    expect(isSupportedBrowser("")).toBe(false);
  });
});

describe("scriptInvocation", () => {
  const url = "https://gitlab.example.com/g/p/-/merge_requests/1";

  test("each Chromium app gets its own script with a literal `tell application`", () => {
    for (const app of CHROMIUM_BROWSERS) {
      const { script, args } = scriptInvocation(app, url);
      expect(args).toEqual([url]);
      expect(script).toContain(`tell application "${app}"`);
      expect(script).toContain("active tab index");
      // Regression guard: a variable app name (`tell application appName`)
      // can't compile against `active tab index` — AppleScript resolves
      // multi-word properties against a literal app name at compile time.
      // Baking in the literal here also means driving Brave/Edge never
      // depends on Chrome being installed.
      for (const other of CHROMIUM_BROWSERS) {
        if (other !== app) expect(script).not.toContain(`tell application "${other}"`);
      }
      // Regression guard: an app with 0 windows must not error out.
      expect(script).toContain("(count of windows) is 0");
      // Regression guard: matching must ignore a fragment/query string, since
      // GitLab rewrites the URL as you interact with an MR (diff tabs, note
      // anchors), not just strip a trailing slash.
      expect(script).toContain("normalizeUrl");
    }
  });

  test("Arc gets its own script, with just the URL as argv", () => {
    const { script, args } = scriptInvocation("Arc", url);
    expect(args).toEqual([url]);
    expect(script).toContain('tell application "Arc"');
    expect(script).toContain("tell matchedTab to select");
    // Regression guard: Arc can be running with 0 windows (all closed, app
    // still open); `front window` would error without this.
    expect(script).toContain("(count of windows) is 0");
    expect(script).toContain("normalizeUrl");
  });
});

// A follow-up "bring the tab to front" step must never be able to undo a
// match that was already found — if it throws, the tab should just stay
// unfocused, not get treated as "not found" and duplicated. Asserted
// structurally: didFocus is set and the loop exits before that step runs,
// and the step is in its own try (see src/browser.ts).
describe("match determination is decoupled from bringing the tab to front", () => {
  const url = "https://gitlab.example.com/g/p/-/merge_requests/1";

  test("Chromium: didFocus is set, and the loop exits, before the follow-up activation step", () => {
    const { script } = scriptInvocation("Google Chrome", url);
    const matchIndex = script.indexOf("set didFocus to true");
    const activateIndex = script.indexOf("set active tab index of matchedWindow");
    expect(matchIndex).toBeGreaterThan(-1);
    expect(activateIndex).toBeGreaterThan(-1);
    expect(matchIndex).toBeLessThan(activateIndex);
    // The activation step must be its own try, separate from the one
    // guarding the URL comparison that sets didFocus.
    expect(script.slice(activateIndex - 40, activateIndex)).toContain("try");
  });

  test("Arc: didFocus is set, and the loop exits, before selecting the matched tab", () => {
    const { script } = scriptInvocation("Arc", url);
    const matchIndex = script.indexOf("set didFocus to true");
    const selectIndex = script.indexOf("tell matchedTab to select");
    expect(matchIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeGreaterThan(-1);
    expect(matchIndex).toBeLessThan(selectIndex);
    expect(script.slice(selectIndex - 40, selectIndex)).toContain("try");
  });
});

describe("resolveBrowserApp", () => {
  test("an explicit config override wins without checking what's running", async () => {
    const checkRunning = async () => {
      throw new Error("should not be called");
    };
    expect(await resolveBrowserApp({ browser: "Arc" }, checkRunning)).toBe("Arc");
  });

  test("auto-detects the first supported app that is running, in declared order", async () => {
    const running = new Set<SupportedBrowser>(["Microsoft Edge", "Arc"]);
    const checkRunning = async (app: SupportedBrowser) => running.has(app);
    expect(await resolveBrowserApp({ browser: null }, checkRunning)).toBe("Microsoft Edge");
  });

  test("null when nothing supported is running", async () => {
    expect(await resolveBrowserApp({ browser: null }, async () => false)).toBeNull();
  });
});

describe("focusOrOpenTab", () => {
  const url = "https://gitlab.example.com/g/p/-/merge_requests/1";

  test("false on non-macOS, without resolving a browser", async () => {
    const checkRunning = async () => {
      throw new Error("should not be called");
    };
    const run = async () => {
      throw new Error("should not be called");
    };
    expect(
      await focusOrOpenTab({ browser: null, reuseTab: true }, url, { platform: "linux", checkRunning, run }),
    ).toBe(false);
  });

  test("false when reuse_tab is disabled", async () => {
    const run = async () => {
      throw new Error("should not be called");
    };
    expect(
      await focusOrOpenTab({ browser: "Google Chrome", reuseTab: false }, url, { platform: "darwin", run }),
    ).toBe(false);
  });

  test("false when no supported browser is running and none is configured", async () => {
    expect(
      await focusOrOpenTab({ browser: null, reuseTab: true }, url, { platform: "darwin", checkRunning: async () => false }),
    ).toBe(false);
  });

  test("runs the resolved app's script and reports success", async () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const run = async (script: string, args: string[]) => {
      calls.push({ script, args });
      return ok();
    };
    const result = await focusOrOpenTab({ browser: "Brave Browser", reuseTab: true }, url, { platform: "darwin", run });
    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([url]);
  });

  test("false when the script itself fails", async () => {
    const result = await focusOrOpenTab({ browser: "Arc", reuseTab: true }, url, {
      platform: "darwin",
      run: async () => failed(),
    });
    expect(result).toBe(false);
  });

  test("logs whether an existing tab was reused or a new one opened", async () => {
    const { log, debugLines } = recordingLogger();
    await focusOrOpenTab({ browser: "Google Chrome", reuseTab: true }, url, {
      platform: "darwin",
      run: async () => ok("reused"),
      log,
    });
    expect(debugLines).toEqual(["browser tab reuse: Google Chrome reused for " + url]);
  });

  test("logs when nothing matched and a new tab was opened instead", async () => {
    const { log, debugLines } = recordingLogger();
    await focusOrOpenTab({ browser: "Google Chrome", reuseTab: true }, url, {
      platform: "darwin",
      run: async () => ok("opened"),
      log,
    });
    expect(debugLines).toEqual(["browser tab reuse: Google Chrome opened for " + url]);
  });

  test("logs why it gave up when no browser resolved or the script failed", async () => {
    const noApp = recordingLogger();
    await focusOrOpenTab({ browser: null, reuseTab: true }, url, {
      platform: "darwin",
      checkRunning: async () => false,
      log: noApp.log,
    });
    expect(noApp.debugLines).toHaveLength(1);
    expect(noApp.debugLines[0]).toContain("no supported browser running or configured");

    const scriptFailed = recordingLogger();
    await focusOrOpenTab({ browser: "Arc", reuseTab: true }, url, {
      platform: "darwin",
      run: async () => failed("System Events got an error"),
      log: scriptFailed.log,
    });
    expect(scriptFailed.debugLines).toHaveLength(1);
    expect(scriptFailed.debugLines[0]).toContain("Arc script failed");
    expect(scriptFailed.debugLines[0]).toContain("System Events got an error");
  });
});

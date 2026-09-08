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
  test("Chromium apps get the shared script with app name and URL as argv", () => {
    for (const app of CHROMIUM_BROWSERS) {
      const { script, args } = scriptInvocation(app, "https://gitlab.example.com/g/p/-/merge_requests/1");
      expect(args).toEqual([app, "https://gitlab.example.com/g/p/-/merge_requests/1"]);
      expect(script).toContain("tell application appName");
      expect(script).toContain("active tab index");
      // Regression guard: `active tab index` is Chrome-specific vocabulary,
      // and the compiler can only resolve it against a *variable* app name
      // (appName) if it's told which app's terminology to use up front.
      // Without this wrapper, osascript fails to even compile the script
      // (syntax error -2740), silently falling back to always-open-new-tab.
      expect(script).toContain('using terms from application "Google Chrome"');
    }
  });

  test("Arc gets its own script with just the URL as argv", () => {
    const { script, args } = scriptInvocation("Arc", "https://gitlab.example.com/g/p/-/merge_requests/1");
    expect(args).toEqual(["https://gitlab.example.com/g/p/-/merge_requests/1"]);
    expect(script).toContain('tell application "Arc"');
    expect(script).toContain("tell t to select");
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
    expect(calls[0]?.args).toEqual(["Brave Browser", url]);
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

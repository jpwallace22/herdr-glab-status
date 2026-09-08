// Best-effort "open or focus a browser tab" for the `open-mr` action, so
// repeatedly invoking it doesn't pile up duplicate tabs for the same MR.
//
// macOS only: it's the one platform with an AppleScript dictionary Herdr can
// drive from a plugin command. Chrome, Brave, and Edge share the same
// Chromium `tabs of window` / `active tab index` dictionary; Arc's is
// different (a tab is selected directly, not via an index property on its
// window). Every other platform, and every other browser, keeps the old
// behavior of always opening a new tab — see bin/open-mr.ts's fallback to
// `glab mr view --web`.

import type { Config } from "./config";
import { runCommand, type CommandResult } from "./exec";
import { briefError } from "./glab";
import { silentLogger, type Logger } from "./log";

export const CHROMIUM_BROWSERS = ["Google Chrome", "Brave Browser", "Microsoft Edge"] as const;
export const SUPPORTED_BROWSERS = [...CHROMIUM_BROWSERS, "Arc"] as const;
export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export function isSupportedBrowser(value: string): value is SupportedBrowser {
  return (SUPPORTED_BROWSERS as readonly string[]).includes(value);
}

// Shared by both dictionaries: compare URLs with any fragment/query string
// and a trailing "/" stripped. GitLab rewrites the tab's URL as you interact
// with an MR (diff tabs, note anchors, etc.), so matching only the path
// keeps a tab "found" across that instead of only the instant it was opened.
const NORMALIZE_URL = `
on normalizeUrl(u)
  set hashPos to offset of "#" in u
  if hashPos > 0 then set u to text 1 thru (hashPos - 1) of u
  set queryPos to offset of "?" in u
  if queryPos > 0 then set u to text 1 thru (queryPos - 1) of u
  if u ends with "/" then set u to text 1 thru -2 of u
  return u
end normalizeUrl
`;

// Both scripts take the target URL as the sole argv and print "reused" or
// "opened" as their last expression (osascript writes it to stdout) — both
// count as "the script ran fine", so this is the only way to tell whether
// the URL match found a prior tab or silently opened a new one.
//
// The app name is a literal in `tell application "..."`, not an argv
// variable: AppleScript resolves multi-word app vocabulary (e.g. `active tab
// index`) against a literal name at compile time, so a variable there fails
// to compile. A literal per app also means driving Brave or Edge never
// depends on Chrome being installed.
function chromiumScript(app: (typeof CHROMIUM_BROWSERS)[number]): string {
  return `
${NORMALIZE_URL}
on run argv
  set targetURL to my normalizeUrl(item 1 of argv)
  set didFocus to false
  tell application "${app}"
    activate
    repeat with w in windows
      set idx to 0
      repeat with t in tabs of w
        set idx to idx + 1
        try
          if my normalizeUrl(URL of t) is targetURL then
            set active tab index of w to idx
            if miniaturized of w then set miniaturized of w to false
            set index of w to 1
            set didFocus to true
            exit repeat
          end if
        end try
      end repeat
      if didFocus then exit repeat
    end repeat
    if not didFocus then
      if (count of windows) is 0 then
        make new window
      end if
      tell window 1 to make new tab with properties {URL:item 1 of argv}
    end if
  end tell
  if didFocus then
    return "reused"
  else
    return "opened"
  end if
end run
`.trim();
}

const ARC_SCRIPT = `
${NORMALIZE_URL}
on run argv
  set targetURL to my normalizeUrl(item 1 of argv)
  set didFocus to false
  tell application "Arc"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        try
          if my normalizeUrl(URL of t) is targetURL then
            tell t to select
            set didFocus to true
            exit repeat
          end if
        end try
      end repeat
      if didFocus then exit repeat
    end repeat
    if not didFocus then
      if (count of windows) is 0 then
        make new window
      end if
      tell front window to make new tab with properties {URL:item 1 of argv}
    end if
  end tell
  if didFocus then
    return "reused"
  else
    return "opened"
  end if
end run
`.trim();

// The osascript script + argv (after `--`) for a given app and target URL.
// Pure, so the app-specific dispatch is unit-tested without shelling out.
export function scriptInvocation(app: SupportedBrowser, url: string): { script: string; args: string[] } {
  return { script: app === "Arc" ? ARC_SCRIPT : chromiumScript(app), args: [url] };
}

export type IsRunning = (app: SupportedBrowser) => Promise<boolean>;

async function isRunning(app: SupportedBrowser): Promise<boolean> {
  const result = await runCommand(["osascript", "-e", `application "${app}" is running`], { timeoutMs: 5_000 });
  return result.ok && result.stdout.trim() === "true";
}

// The app to target: an explicit config override, or the first supported
// browser that is already running. Nothing is launched just to check this,
// so a workspace where none of them is open yet falls straight back to the
// caller's normal "open a new tab" behavior.
export async function resolveBrowserApp(
  cfg: Pick<Config, "browser">,
  checkRunning: IsRunning = isRunning,
): Promise<SupportedBrowser | null> {
  if (cfg.browser) return cfg.browser;
  for (const app of SUPPORTED_BROWSERS) {
    if (await checkRunning(app)) return app;
  }
  return null;
}

export type RunScript = (script: string, args: string[]) => Promise<CommandResult>;

async function runOsascript(script: string, args: string[]): Promise<CommandResult> {
  return runCommand(["osascript", "-e", script, "--", ...args], { timeoutMs: 15_000 });
}

// Focus the MR's tab if a supported browser already has it open, or open a
// new tab in that browser. Returns false (never throws) whenever tab reuse
// doesn't apply — not macOS, `reuse_tab = false`, no supported browser
// resolved, or the AppleScript call itself failed — so the caller can fall
// back to its normal "open a new tab" path. Logs the outcome at debug level.
export async function focusOrOpenTab(
  cfg: Pick<Config, "browser" | "reuseTab">,
  url: string,
  opts: { platform?: string; checkRunning?: IsRunning; run?: RunScript; log?: Logger } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? silentLogger;
  if (platform !== "darwin" || !cfg.reuseTab) return false;
  const app = await resolveBrowserApp(cfg, opts.checkRunning);
  if (!app) {
    log.debug("browser tab reuse: no supported browser running or configured; opening a new tab the old way");
    return false;
  }
  const { script, args } = scriptInvocation(app, url);
  const run = opts.run ?? runOsascript;
  const result = await run(script, args);
  if (!result.ok) {
    log.debug(`browser tab reuse: ${app} script failed (${briefError(result)}); opening a new tab the old way`);
    return false;
  }
  log.debug(`browser tab reuse: ${app} ${result.stdout.trim() || "ran"} for ${url}`);
  return true;
}

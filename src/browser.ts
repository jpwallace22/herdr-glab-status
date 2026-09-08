// Best-effort "open or focus a browser tab" for the `open-mr` action, so
// repeatedly invoking it doesn't pile up duplicate tabs for the same MR.
//
// Only macOS is supported: it is the one platform with an AppleScript
// dictionary Herdr can drive from a plugin command. Chrome, Brave, and
// Microsoft Edge share the same Chromium `tabs of window` / `active tab
// index` dictionary; Arc ships a different one (a tab is selected directly,
// not via an index property on its window). Every other platform, and every
// other browser, keeps the old behavior of always opening a new tab — see
// bin/open-mr.ts's fallback to `glab mr view --web`.

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

// Both scripts print "reused" or "opened" as their last expression (which
// osascript writes to stdout), so the caller can tell whether it actually
// found an existing tab instead of always taking the "it ran fine" path —
// the fallback branch that opens a new tab when nothing matches means a
// broken URL comparison would otherwise look identical to success.
//
// URLs are compared with a trailing "/" stripped from both sides, since a
// browser can normalize a bare path's trailing slash independently of what
// `glab` reports as the MR's web_url.

const STRIP_TRAILING_SLASH = `
on stripTrailingSlash(u)
  if u ends with "/" then
    return text 1 thru -2 of u
  else
    return u
  end if
end stripTrailingSlash
`;

// Chromium dictionary (Chrome, Brave, Edge): every window has a `tabs` list
// and a settable `active tab index`. Takes the app name and target URL as
// argv so one script serves all three apps.
const CHROMIUM_SCRIPT = `
${STRIP_TRAILING_SLASH}
on run argv
  set appName to item 1 of argv
  set targetURL to my stripTrailingSlash(item 2 of argv)
  set didFocus to false
  tell application appName
    activate
    repeat with w in windows
      set idx to 0
      repeat with t in tabs of w
        set idx to idx + 1
        try
          if my stripTrailingSlash(URL of t) is targetURL then
            set active tab index of w to idx
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
      tell window 1 to make new tab with properties {URL:item 2 of argv}
    end if
  end tell
  if didFocus then
    return "reused"
  else
    return "opened"
  end if
end run
`.trim();

// Arc's dictionary: a tab is focused by selecting it directly, not by
// setting an index property on its window.
const ARC_SCRIPT = `
${STRIP_TRAILING_SLASH}
on run argv
  set targetURL to my stripTrailingSlash(item 1 of argv)
  set didFocus to false
  tell application "Arc"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        try
          if my stripTrailingSlash(URL of t) is targetURL then
            tell t to select
            set didFocus to true
            exit repeat
          end if
        end try
      end repeat
      if didFocus then exit repeat
    end repeat
    if not didFocus then
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
  return app === "Arc" ? { script: ARC_SCRIPT, args: [url] } : { script: CHROMIUM_SCRIPT, args: [app, url] };
}

export type IsRunning = (app: SupportedBrowser) => Promise<boolean>;

async function isRunning(app: SupportedBrowser): Promise<boolean> {
  const result = await runCommand(["osascript", "-e", `application "${app}" is running`], { timeoutMs: 5_000 });
  return result.ok && result.stdout.trim() === "true";
}

// The app to target: an explicit config override, or the first supported
// browser that is already running. Nothing is launched just to check this,
// so a workspace where none of them is open yet still falls straight back
// to the caller's normal "open a new tab" behavior.
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
// does not apply — not macOS, `reuse_tab = false`, no supported browser
// resolved, or the AppleScript call itself failed — so the caller can fall
// back to its normal "open a new tab" path.
//
// Logs at debug level which app was targeted and whether the script actually
// found and reused an existing tab vs. fell through to opening a new one —
// both count as success (a working browser call), so this is the only signal
// that the URL match itself is or isn't finding tabs opened by a prior run.
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

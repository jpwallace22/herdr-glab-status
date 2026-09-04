import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

// Pure: has the throttle window elapsed since the last check?
export function throttleElapsed(lastMs: number, nowMs: number, windowMs: number): boolean {
  return nowMs - lastMs >= windowMs;
}

// Per-workspace timestamps live under the plugin state dir so the poller,
// event hooks, and actions (separate processes) share one view.
function checkDir(): string {
  return join(stateDir(), "last-check");
}

function fileFor(workspaceId: string): string {
  return join(checkDir(), workspaceId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

// Epoch ms of the last recorded check for a workspace, or 0 if never checked.
export function lastCheckMs(workspaceId: string): number {
  try {
    return Number(readFileSync(fileFor(workspaceId), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

export function recordCheck(workspaceId: string, nowMs: number): void {
  try {
    mkdirSync(checkDir(), { recursive: true });
    writeFileSync(fileFor(workspaceId), String(nowMs));
  } catch {
    // Best effort: without a record the workspace is simply re-checked.
  }
}

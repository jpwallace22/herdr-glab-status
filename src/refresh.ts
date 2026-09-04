import { tokenTtlMs, type Config } from "./config";
import { countUnresolved, parseDiscussionsPage } from "./discussions";
import { briefError, classifyFailure, createGlabClient, type GlabClient } from "./glab";
import { clearToken, listWorkspaces, reportToken, type Workspace } from "./herdr";
import { formatLabel, parseMrView, type MrSummary } from "./label";
import type { Logger } from "./log";
import { mrRefArg, resolveMrRef } from "./resolve";
import { recordCheck } from "./throttle";

// What to do with a workspace's `$mr` token.
export type Decision =
  | { kind: "clear"; reason: string }
  | { kind: "report"; label: string; mr: MrSummary; unresolved: number | null; warning: string | null }
  | { kind: "abort"; failure: "auth" | "missing"; message: string };

const clear = (reason: string): Decision => ({ kind: "clear", reason });

function abortFor(failure: "auth" | "missing", detail: string, cfg: Config): Decision {
  const message =
    failure === "missing"
      ? `glab not found (${detail}); install glab or set glab_path in config.toml`
      : `glab is not authenticated${cfg.host ? ` for ${cfg.host}` : ""}: ${detail}; run 'glab auth login'`;
  return { kind: "abort", failure, message };
}

// Inspect one workspace: branch → MR ref → glab → label. Pure with respect to
// herdr: it only reads git/glab and returns a decision.
export async function inspectWorkspace(ws: Workspace, cfg: Config, glab: GlabClient): Promise<Decision> {
  const branch = await glab.currentBranch(ws.checkoutPath);
  if (!branch) return clear("no current branch (detached HEAD or not a git checkout)");

  const ref = resolveMrRef(branch);
  const view = await glab.mrView(mrRefArg(ref), ws.checkoutPath);
  if (!view.ok) {
    const failure = classifyFailure(view);
    if (failure === "no_mr") return clear(`no merge request for ${mrRefArg(ref)}`);
    if (failure === "auth" || failure === "missing") return abortFor(failure, briefError(view), cfg);
    return clear(`glab mr view failed: ${briefError(view)}`);
  }

  const mr = parseMrView(view.stdout);
  if (!mr) return clear("glab mr view returned unexpected output");

  let unresolved: number | null = null;
  let warning: string | null = null;
  if (cfg.countUnresolved) {
    try {
      unresolved = await countUnresolved(async (page, perPage) => {
        const result = await glab.discussionsPage(mr.projectId, mr.iid, page, perPage, ws.checkoutPath);
        if (!result.ok) {
          const failure = classifyFailure(result);
          if (failure === "auth" || failure === "missing") throw abortFor(failure, briefError(result), cfg);
          throw new Error(briefError(result));
        }
        return parseDiscussionsPage(result.stdout);
      });
    } catch (err) {
      if (isAbort(err)) return err;
      // The MR itself is known; show it without the ✎N segment rather than
      // dropping the row over a transient discussions failure.
      warning = `could not count unresolved threads for !${mr.iid}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { kind: "report", label: formatLabel(mr, unresolved), mr, unresolved, warning };
}

function isAbort(value: unknown): value is Extract<Decision, { kind: "abort" }> {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "abort";
}

export interface RefreshSummary {
  reported: number;
  cleared: number;
  /** herdr rejected a report/clear call. */
  failed: number;
  /** Set when glab was unusable and remaining tokens were cleared. */
  aborted: Extract<Decision, { kind: "abort" }> | null;
  /** `herdr workspace list` failed; nothing was refreshed. */
  herdrUnavailable: boolean;
}

// Apply a decision to herdr. `seq` lets herdr drop out-of-order reports from
// overlapping runs (poller vs. event hook).
export async function applyDecision(ws: Workspace, decision: Decision, cfg: Config, log: Logger): Promise<boolean> {
  const seq = Date.now();
  if (decision.kind === "report") {
    if (decision.warning) log.warn(`${ws.label}: ${decision.warning}`);
    const result = await reportToken(ws.workspaceId, decision.label, tokenTtlMs(cfg), seq);
    if (!result.ok) {
      log.warn(`${ws.label}: herdr rejected token report: ${briefError(result)}`);
      return false;
    }
    log.debug(`${ws.label}: ${decision.label}`);
    return true;
  }
  const result = await clearToken(ws.workspaceId, seq);
  if (!result.ok) {
    log.warn(`${ws.label}: herdr rejected token clear: ${briefError(result)}`);
    return false;
  }
  log.debug(`${ws.label}: cleared (${decision.kind === "clear" ? decision.reason : decision.message})`);
  return true;
}

// Refresh the given workspaces sequentially. On an abort (glab missing or
// unauthenticated) the error is logged once, every remaining token is cleared
// so nothing stale lingers, and the run stops.
export async function refreshWorkspaces(
  workspaces: Workspace[],
  cfg: Config,
  log: Logger,
  glab: GlabClient = createGlabClient(cfg),
): Promise<RefreshSummary> {
  const summary: RefreshSummary = { reported: 0, cleared: 0, failed: 0, aborted: null, herdrUnavailable: false };

  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i]!;
    let decision: Decision;
    try {
      decision = await inspectWorkspace(ws, cfg, glab);
    } catch (err) {
      // One bad workspace must never take the loop down.
      decision = clear(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
    recordCheck(ws.workspaceId, Date.now());

    if (decision.kind === "abort") {
      summary.aborted = decision;
      log.error(decision.message);
      for (const remaining of workspaces.slice(i)) {
        const ok = await applyDecision(remaining, decision, cfg, log);
        if (ok) summary.cleared++;
        else summary.failed++;
      }
      break;
    }

    if (decision.kind === "clear" && /failed|unexpected/.test(decision.reason)) {
      log.warn(`${ws.label}: ${decision.reason}`);
    }
    const ok = await applyDecision(ws, decision, cfg, log);
    if (!ok) summary.failed++;
    else if (decision.kind === "report") summary.reported++;
    else summary.cleared++;
  }

  return summary;
}

// Refresh every workspace herdr knows about.
export async function refreshAll(cfg: Config, log: Logger, glab?: GlabClient): Promise<RefreshSummary> {
  const workspaces = await listWorkspaces();
  if (workspaces === null) {
    log.warn("could not list workspaces (is the herdr server running?)");
    return { reported: 0, cleared: 0, failed: 0, aborted: null, herdrUnavailable: true };
  }
  return refreshWorkspaces(workspaces, cfg, log, glab);
}

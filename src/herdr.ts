import { herdrBin, SOURCE, TOKEN } from "./env";
import { runCommand, type CommandResult } from "./exec";

export interface Workspace {
  workspaceId: string;
  label: string;
  checkoutPath: string;
  /** The `$mr` token this workspace is currently showing in the sidebar
   * (see label.ts's formatLabel), read straight from `herdr workspace
   * list`'s cached state -- not re-fetched from glab. null if there is
   * none (no MR, or the token hasn't been reported/has expired). Optional
   * on the type so existing Workspace literals elsewhere (tests, mostly)
   * don't all need updating; toWorkspace() below always sets it. */
  mrToken?: string | null;
  /** worktree.repo_name from `herdr workspace list` -- the actual git repo
   * identity, not the (possibly worktree-specific) workspace label. Used by
   * the pick-mr board's "scope" filter (same repo as the workspace the
   * picker was opened from). Optional for the same reason as mrToken. */
  repoName?: string | null;
}

interface RawWorkspace {
  workspace_id?: unknown;
  label?: unknown;
  worktree?: { checkout_path?: unknown; repo_name?: unknown } | null;
  tokens?: { mr?: unknown } | null;
}

function toWorkspace(raw: unknown): Workspace | null {
  if (raw === null || typeof raw !== "object") return null;
  const ws = raw as RawWorkspace;
  const id = ws.workspace_id;
  const path = ws.worktree?.checkout_path;
  if (typeof id !== "string" || id === "") return null;
  // Workspaces without a checkout (no worktree) have nothing to look up.
  if (typeof path !== "string" || path === "") return null;
  const mr = ws.tokens?.mr;
  const repoName = ws.worktree?.repo_name;
  return {
    workspaceId: id,
    label: typeof ws.label === "string" ? ws.label : id,
    checkoutPath: path,
    repoName: typeof repoName === "string" && repoName !== "" ? repoName : null,
    mrToken: typeof mr === "string" && mr !== "" ? mr : null,
  };
}

// Accepts the `herdr workspace list` payload ({result:{workspaces:[...]}}),
// the `herdr workspace get` payload ({result:{workspace:{...}}}), or a bare
// array. Workspaces without `worktree.checkout_path` are skipped.
export function parseWorkspaces(payload: unknown): Workspace[] {
  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (payload && typeof payload === "object") {
    const result = (payload as { result?: unknown }).result;
    const container = result && typeof result === "object" ? (result as Record<string, unknown>) : (payload as Record<string, unknown>);
    if (Array.isArray(container.workspaces)) items = container.workspaces;
    else if (container.workspace && typeof container.workspace === "object") items = [container.workspace];
  }
  const out: Workspace[] = [];
  for (const item of items) {
    const ws = toWorkspace(item);
    if (ws) out.push(ws);
  }
  return out;
}

export function runHerdr(args: string[]): Promise<CommandResult> {
  return runCommand([herdrBin(), ...args], { timeoutMs: 20_000 });
}

// All workspaces with a checkout, or null when herdr itself is unreachable.
export async function listWorkspaces(): Promise<Workspace[] | null> {
  const result = await runHerdr(["workspace", "list"]);
  if (!result.ok) return null;
  try {
    return parseWorkspaces(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

// One workspace with a checkout, or null if unreachable / no checkout.
export async function getWorkspace(workspaceId: string): Promise<Workspace | null> {
  const result = await runHerdr(["workspace", "get", workspaceId]);
  if (!result.ok) return null;
  try {
    return parseWorkspaces(JSON.parse(result.stdout))[0] ?? null;
  } catch {
    return null;
  }
}

// Live herdr state for one workspace -- distinct from Workspace, which is
// the plugin's own narrow, cache-friendly view. Only used by the pick-mr
// board's preview pane (src/picker.ts's formatPreview), fetched fresh each
// time (a local socket call, not glab/network, so it's cheap to not cache).
export interface WorkspaceStatus {
  agentStatus: string;
  paneCount: number;
  tabCount: number;
  focused: boolean;
}

export function parseWorkspaceStatus(payload: unknown): WorkspaceStatus | null {
  if (payload === null || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  const container = result && typeof result === "object" ? (result as Record<string, unknown>) : (payload as Record<string, unknown>);
  const ws = (container.workspace && typeof container.workspace === "object" ? container.workspace : container) as Record<string, unknown>;
  if (typeof ws.workspace_id !== "string") return null;
  return {
    agentStatus: typeof ws.agent_status === "string" ? ws.agent_status : "unknown",
    paneCount: typeof ws.pane_count === "number" ? ws.pane_count : 0,
    tabCount: typeof ws.tab_count === "number" ? ws.tab_count : 0,
    focused: ws.focused === true,
  };
}

export async function getWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus | null> {
  const result = await runHerdr(["workspace", "get", workspaceId]);
  if (!result.ok) return null;
  try {
    return parseWorkspaceStatus(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

// `herdr agent list` returns only panes with a detected agent -- exactly
// the source sessionizer's own agent view uses for its own fzf preview
// (see its bundled docs: "agent read gives scrollback for an fzf preview
// of what the agent is doing"). Used by the pick-mr board's preview pane
// to find which pane, if any, in the highlighted row's workspace to read.
export interface AgentInfo {
  paneId: string;
  workspaceId: string;
  agent: string;
  agentStatus: string;
}

export function parseAgentList(payload: unknown): AgentInfo[] {
  if (payload === null || typeof payload !== "object") return [];
  const result = (payload as { result?: unknown }).result;
  const container = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const items = Array.isArray((container as Record<string, unknown>).agents) ? (container as { agents: unknown[] }).agents : [];
  const out: AgentInfo[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.pane_id !== "string" || typeof a.workspace_id !== "string") continue;
    out.push({
      paneId: a.pane_id,
      workspaceId: a.workspace_id,
      agent: typeof a.agent === "string" ? a.agent : "unknown",
      agentStatus: typeof a.agent_status === "string" ? a.agent_status : "unknown",
    });
  }
  return out;
}

export async function listAgents(): Promise<AgentInfo[] | null> {
  const result = await runHerdr(["agent", "list"]);
  if (!result.ok) return null;
  try {
    return parseAgentList(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

// Scrollback text for one pane, via `herdr agent read` -- the CLI's own
// documented "preview material" tool. null on any failure (no agent there,
// herdr unreachable, etc.), never throws.
export async function readAgent(paneId: string, lines: number): Promise<string | null> {
  const result = await runHerdr(["agent", "read", paneId, "--lines", String(lines)]);
  return result.ok ? result.stdout : null;
}

export function reportToken(workspaceId: string, label: string, ttlMs: number, seq: number): Promise<CommandResult> {
  return runHerdr([
    "workspace",
    "report-metadata",
    workspaceId,
    "--source",
    SOURCE,
    "--token",
    `${TOKEN}=${label}`,
    "--ttl-ms",
    String(ttlMs),
    "--seq",
    String(seq),
  ]);
}

export function clearToken(workspaceId: string, seq: number): Promise<CommandResult> {
  return runHerdr([
    "workspace",
    "report-metadata",
    workspaceId,
    "--source",
    SOURCE,
    "--clear-token",
    TOKEN,
    "--seq",
    String(seq),
  ]);
}

export async function showNotification(title: string, body: string): Promise<void> {
  await runHerdr(["notification", "show", title, "--body", body]);
}
